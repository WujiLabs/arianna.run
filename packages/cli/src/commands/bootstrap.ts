// `arianna bootstrap` — explicit, idempotent vessel bootstrap.
//
// Same logic the talk command's auto-bootstrap step uses, but invokable on
// its own. Useful for scripts (especially day-1 OpenClaw demo runs) that
// want to pre-warm the vessel before the first /chat, or to re-seed after
// some external mutation. Calling twice is a safe no-op the second time.
//
// `--seed-from-jsonl <path>` lets a driver agent (e.g. pi-coding-agent in
// OpenClaw) carry its own session history into a fresh arianna vessel. The
// path points at a pi-coding-agent / OpenClaw JSONL session file; we parse it
// with the same `parseSessionJsonl` used by `arianna profile import`, write
// the extracted messages to the profile's `imported-messages.jsonl`, then
// run the normal bootstrap. This way the vessel side stays unchanged: the
// bundled-initial-messages mechanism just sees more messages in the seed
// file. The seed file persists on disk so a vessel respawn can re-read it.
//
// Default behavior (no `--seed-from-jsonl`, no pre-existing seed file): the
// command auto-injects the canonical Filo opening box (same wording the TUI
// shows on first turn) into `imported-messages.jsonl`. This closes the gap
// canary acb7b292 (Lume run, 2026-05-09) caught — headless CLI-driven
// incubations were waking the AI as a generic stock assistant because the
// prelude was TUI-only. `--no-prelude` opts out for debug / fully-empty
// starts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";

import type { ResolvedConfig } from "../config.js";
import { ensureBootstrapped, resolveProfileSeedPaths } from "../bootstrap.js";
import type { PathOpts } from "../paths.js";
import {
  ImportError,
  parseSessionJsonl,
  type AgentMessage,
} from "../import-parser.js";
import type { BootstrapArgs } from "../argv.js";
import {
  ComposeUpError,
  ensureComposeUp,
  isLocalDockerAvailable,
  type ExecWithEnvFn,
} from "../compose-up.js";
import { buildFiloPreludeAgentMessage } from "../filo-prelude.js";

export class BootstrapCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapCommandError";
  }
}

export interface BootstrapDeps {
  fetch: typeof globalThis.fetch;
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /** Test seam for path overrides. */
  pathOpts?: PathOpts;
  /** Working directory used to resolve a relative --seed-from-jsonl path. */
  cwd?: string;
  /**
   * Run a shell command with optional env override. Used to auto-`docker
   * compose up -d` the profile's stack when it's not already running on the
   * local-docker route. When undefined AND the daemon route can't be taken
   * either, the auto-up step is skipped — tests that don't need the compose
   * path can keep their existing fetch-only setup. Production wires it via
   * promisify(child_process.exec) at the dispatcher in index.ts.
   */
  exec?: ExecWithEnvFn;
  /** Test seam — defaults to process.env. Threaded into composeEnv builder. */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam — override the docker-binary detection probe used by
   * ensureComposeUp. Lets unit tests force the local vs daemon route without
   * monkey-patching child_process.execSync.
   */
  dockerProbe?: () => void;
  /**
   * Total milliseconds to spend retrying the post-up vessel /status probe
   * (canary-003 fix — vessel takes ~1-3s to bind after `docker compose up
   * -d`). Forwarded to ensureBootstrapped. Default 30000.
   */
  readyTimeoutMs?: number;
  /** Polling interval between vessel readiness probes. Default 500ms. */
  readyIntervalMs?: number;
  /** Sleep implementation for tests. Defaults to setTimeout-backed. */
  sleep?: (ms: number) => Promise<void>;
}

function resolveSeedSourcePath(rawPath: string, cwd: string | undefined): string {
  if (rawPath.includes("\0")) {
    throw new BootstrapCommandError(
      "--seed-from-jsonl path contains an invalid null byte.",
    );
  }
  return isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(cwd ?? process.cwd(), rawPath);
}

function writeJsonl(path: string, messages: AgentMessage[]): void {
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(path, lines + (messages.length > 0 ? "\n" : ""));
}

/**
 * Best-effort read of `aiName` out of a profile's session_config.json. The
 * vessel/sidecar/daemon stack may already be running with an aiName cached
 * server-side, but for the prelude we want the same name the TUI's
 * ChatView gets — that's the one in session_config. Returns null when the
 * file is missing or the field is empty/malformed; the caller decides what
 * to do (we fall through to the vessel /status response).
 */
function readSessionConfigAiName(sessionConfigPath: string): string | null {
  try {
    if (!existsSync(sessionConfigPath)) return null;
    const raw = readFileSync(sessionConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as { aiName?: unknown };
    if (typeof parsed.aiName === "string" && parsed.aiName.length > 0) {
      return parsed.aiName;
    }
    return null;
  } catch {
    // Malformed JSON / IO error → caller falls back to vessel /status.aiName.
    return null;
  }
}

export async function runBootstrap(
  config: ResolvedConfig,
  deps: BootstrapDeps,
  args: BootstrapArgs = {},
): Promise<number> {
  // Detect the compose-up route up front. This decides where the Filo prelude
  // gets written: on the local route the CLI handles it (cwd-walked path
  // resolution works because the operator is on the same host as the daemon).
  // On the daemon route — the canonical case is `arianna bootstrap` running
  // inside an openclaw container — the daemon handles it server-side because
  // path resolution from inside the container would otherwise find openclaw's
  // own docker-compose.yml and write the prelude to a path the host daemon
  // never reads. Validation aea28db5 caught exactly that failure: vessel boots
  // with messages: [] and the AI wakes as a generic Gemini stock assistant.
  //
  // useDaemon flag forces the daemon route. dockerProbe (test seam) lets unit
  // tests pin the route without monkey-patching child_process. Otherwise we
  // probe the local docker binary; absent ⇒ daemon route.
  const useDaemon = args.useDaemon === true;
  const willUseDaemonRoute =
    useDaemon || !isLocalDockerAvailable(deps.dockerProbe);

  // Track whether the daemon-route's /compose-up reported it already
  // bootstrapped vessel server-side. When it did, we skip the local-route
  // ensureBootstrapped call entirely — running it would just re-probe /status,
  // see bootstrapped:true, and print a "Vessel already bootstrapped — no-op"
  // line that follows "Vessel bootstrapped on daemon side." and reads to
  // operators like something didn't work. Validation a09486c9 (Talin run,
  // 2026-05-09) flagged that confusing duplication.
  let daemonHandledBootstrap = false;

  // If --seed-from-jsonl was passed, materialize the JSONL into the profile's
  // imported-messages.jsonl BEFORE we ask the vessel for its bootstrap state.
  // ensureBootstrapped reads that file from disk; doing the seed-write first
  // means the rest of the flow is unchanged.
  //
  // Note: --seed-from-jsonl runs on BOTH routes from the CLI side. Inside an
  // openclaw container, the CLI can read its own filesystem fine — the issue
  // is only that the PROFILE workspace (where imported-messages.jsonl lives)
  // is inaccessible from the container's POV via cwd-walking. We resolve the
  // seed source path against deps.cwd (the operator's chosen file). If the
  // CLI is being run inside an openclaw container against a daemon-routed
  // profile, the operator should write the seed file via daemon + volume
  // mount, or use the daemon route's prelude write instead.
  if (args.seedFromJsonl) {
    const sourcePath = resolveSeedSourcePath(args.seedFromJsonl, deps.cwd);
    let parsed;
    try {
      parsed = parseSessionJsonl(sourcePath);
    } catch (err) {
      if (err instanceof ImportError) {
        throw new BootstrapCommandError(err.message);
      }
      throw err;
    }

    const { importedMessagesPath } = resolveProfileSeedPaths(
      config,
      deps.pathOpts ?? {},
    );

    if (existsSync(importedMessagesPath)) {
      // Refuse to silently clobber an existing seed file. The driver is
      // expected to either bootstrap into a fresh profile or delete the old
      // seed first. We do NOT 'merge' — the right move depends on whether
      // the existing seed and the new one share a prefix, and that's the
      // caller's call.
      throw new BootstrapCommandError(
        `Seed already present at ${importedMessagesPath}. ` +
          `Delete it (or use a fresh profile) before re-seeding.`,
      );
    }

    mkdirSync(dirname(importedMessagesPath), { recursive: true });
    writeJsonl(importedMessagesPath, parsed.messages);
    deps.write(
      `Seeded ${parsed.messages.length} messages from ${sourcePath} → ${importedMessagesPath}.\n`,
    );
    if (parsed.detectedName) {
      deps.write(`Detected partner name: ${parsed.detectedName}.\n`);
    }
    if (parsed.model) {
      deps.write(`Model from session: ${parsed.model.provider}/${parsed.model.modelId}.\n`);
    }
  } else if (!args.noPrelude && !willUseDaemonRoute) {
    // Default-on auto-injection of the Filo opening box on the LOCAL route
    // only. Daemon route handles prelude write server-side via /compose-up
    // (see comment above). Only fires for a fresh profile (no pre-existing
    // seed file). The TUI's ChatView prepends the same prelude to its first
    // /chat call; this branch puts it on the headless `arianna bootstrap`
    // path so CLI-driven incubations match the TUI behavior. See canary
    // acb7b292 (Lume run, 2026-05-09) for the generic-stock-assistant failure
    // mode this prevents.
    //
    // Skipped on existing seed (`profile import` ran first, or a previous
    // `--seed-from-jsonl` already wrote the file). Skipped on `--no-prelude`
    // (debug / opt-out). Re-running `arianna bootstrap` against an
    // already-bootstrapped vessel is also a no-op below — even if we wrote
    // the file here, ensureBootstrapped's /status check would short-circuit
    // before reading it. We still write so a later restore/respawn picks it
    // up consistently with the --seed-from-jsonl branch's behavior.
    const { sessionConfigPath, importedMessagesPath } = resolveProfileSeedPaths(
      config,
      deps.pathOpts ?? {},
    );
    if (!existsSync(importedMessagesPath)) {
      const aiName = readSessionConfigAiName(sessionConfigPath);
      if (aiName) {
        const preludeMsg = buildFiloPreludeAgentMessage(aiName);
        mkdirSync(dirname(importedMessagesPath), { recursive: true });
        writeJsonl(importedMessagesPath, [preludeMsg]);
        deps.write(
          `Auto-injected Filo opening prelude for "${aiName}" → ${importedMessagesPath}. ` +
            `(Pass --no-prelude to opt out.)\n`,
        );
      } else {
        // No session_config or no aiName field — skip silently rather than
        // bake "vessel" / a placeholder into the prelude. The vessel will
        // bootstrap blank-canvas; the operator can re-run bootstrap after
        // populating session_config.json, or pass --seed-from-jsonl.
        deps.warn?.(
          `warn: Filo prelude skipped — no aiName in ${sessionConfigPath}. ` +
            `Run \`arianna profile create <name> --ai-name ...\` first, or pass --no-prelude to silence.\n`,
        );
      }
    }
  }

  // Auto-up the docker compose stack if it isn't already running. Idempotent
  // by construction: ensureComposeUp probes `ps --filter status=running`
  // first and only invokes `up -d` when nothing is running. Operators who
  // already have the stack up see no new behavior — the probe is a no-op
  // fast-path.
  //
  // Surfaced by canary acb7b292 (Lume run, 2026-05-09): the driver had to
  // manually `docker compose -p arianna-canary-001 -f docker-compose.yml -f
  // workspace/profiles/canary-001/compose.override.yml up -d` after
  // `arianna profile create` and before `arianna bootstrap`. The CLI
  // silently failed at vessel /status (no /status response → null) and
  // then threw a generic transport error on /bootstrap, which masked the
  // actual cause ("the stack isn't up").
  //
  // Two routes for `docker compose up -d`:
  //   - local: run the docker binary on the calling host (laptop / CI).
  //     Requires deps.exec.
  //   - daemon: POST /compose-up to the host daemon (openclaw container case).
  //     Routed via deps.fetch.
  //
  // ensureComposeUp picks the route via isLocalDockerAvailable(). The
  // useDaemon flag (`arianna bootstrap --use-daemon`) forces the daemon route
  // regardless of detection.
  //
  // Skipped when no exec AND no daemon-route opt-in (test seam — fetch-only
  // tests that predate the auto-up plumbing don't want a real docker probe
  // to fire against the host). Production wires `exec` via the dispatcher
  // in index.ts so compose-up always runs there, taking whichever route the
  // host environment supports.
  //
  // Daemon-side prelude write: when --seed-from-jsonl was passed we already
  // wrote a seed file (CLI side) and want the daemon to leave it alone. When
  // --no-prelude was passed we want the daemon to skip prelude write too.
  // Otherwise the daemon writes the prelude (closing aea28db5 — see comments
  // at the top of this function).
  const wantDaemonRoute = useDaemon || deps.dockerProbe !== undefined;
  const daemonWritePrelude =
    args.seedFromJsonl || args.noPrelude ? false : true;
  if (deps.exec || wantDaemonRoute) {
    try {
      const composeResult = await ensureComposeUp(config, {
        // exec is required by the type but only invoked on the local route.
        // Provide a panic stub when it's missing so a test that takes the
        // local route without wiring exec gets a clear failure (vs. a silent
        // skip).
        exec:
          deps.exec ??
          (async () => {
            throw new Error(
              "internal: ensureComposeUp took the local route but deps.exec was not wired",
            );
          }),
        write: deps.write,
        warn: deps.warn,
        pathOpts: deps.pathOpts,
        env: deps.env,
        fetch: deps.fetch,
        useDaemon,
        dockerProbe: deps.dockerProbe,
        daemonWritePrelude,
      });

      // Surface what the daemon did with the prelude so operators see it on
      // the openclaw container path (where they'd otherwise have no signal).
      // Mirrors the local-route's "Auto-injected" log line.
      if (composeResult.route === "daemon") {
        if (composeResult.daemonPreludeWritten === true) {
          deps.write(
            `Auto-injected Filo opening prelude on daemon side. (Pass --no-prelude to opt out.)\n`,
          );
        } else if (composeResult.daemonPreludeSkipReason === "ai-name-missing") {
          deps.warn?.(
            `warn: Filo prelude skipped on daemon side — no aiName in profile session_config.json. ` +
              `Run \`arianna profile create <name> --ai-name ...\` first, or pass --no-prelude to silence.\n`,
          );
        } else if (composeResult.daemonPreludeSkipReason === "session-config-missing") {
          deps.warn?.(
            `warn: Filo prelude skipped on daemon side — session_config.json missing. ` +
              `Run \`arianna profile create <name> --ai-name ...\` first.\n`,
          );
        }
        // imported-messages-exists / writePrelude=false / write-failed are
        // all expected cases; no operator-facing message needed.

        // Closes openclaw gap (validation abfd4b13, 2026-05-09): the daemon
        // now also POSTs /bootstrap to vessel after bringing the stack up,
        // because the CLI inside an openclaw container can't read the host's
        // imported-messages.jsonl on its own. ensureBootstrapped below will
        // short-circuit on /status.bootstrapped: true (no double-POST). When
        // the daemon's forward failed, the CLI's idempotent fall-back will
        // re-attempt the bootstrap — surface a warn so operators see the
        // first attempt failed.
        if (composeResult.daemonVesselBootstrapped === true) {
          deps.write(`Vessel bootstrapped on daemon side.\n`);
          daemonHandledBootstrap = true;
        } else if (composeResult.daemonVesselBootstrapError) {
          deps.warn?.(
            `warn: daemon vessel /bootstrap forward failed (${composeResult.daemonVesselBootstrapError}); ` +
              `falling back to CLI-side bootstrap.\n`,
          );
        }
      }
    } catch (err) {
      if (err instanceof ComposeUpError) {
        throw new BootstrapCommandError(err.message);
      }
      throw err;
    }
  }

  // When the daemon-route's /compose-up already POSTed /bootstrap to vessel
  // (validation abfd4b13 fix — daemon owns the bootstrap on the openclaw
  // container path because the CLI inside the container can't read the host's
  // imported-messages.jsonl), there is nothing left for the CLI's
  // ensureBootstrapped to do but re-probe /status and print a redundant
  // "Vessel already bootstrapped — no-op" line that reads as confusing. Skip
  // it. The daemon owns the lifecycle in this case; the "Vessel bootstrapped
  // on daemon side." line above is the success signal operators see.
  // Validation a09486c9 (Talin run, 2026-05-09) flagged the duplication.
  if (daemonHandledBootstrap) {
    return 0;
  }

  const result = await ensureBootstrapped(config, {
    fetch: deps.fetch,
    pathOpts: deps.pathOpts,
    readyTimeoutMs: deps.readyTimeoutMs,
    readyIntervalMs: deps.readyIntervalMs,
    sleep: deps.sleep,
  });

  if (result.alreadyBootstrapped) {
    if (args.seedFromJsonl) {
      // We wrote a seed file to disk, but the vessel was already up. The
      // seed will be consumed on the *next* fresh bootstrap (e.g. after a
      // restore or a vessel respawn). Surface this so the caller doesn't
      // think the seed already landed in the live vessel.
      deps.write(
        `Vessel already bootstrapped${result.aiName ? ` (${result.aiName})` : ""} — ` +
          `seed written to disk but not applied to the live vessel. ` +
          `It will be applied on the next fresh bootstrap.\n`,
      );
      return 0;
    }
    deps.write(
      `Vessel already bootstrapped${
        result.aiName ? ` (${result.aiName})` : ""
      } — no-op.\n`,
    );
    return 0;
  }

  if (result.importedMessageCount > 0) {
    deps.write(
      `Bootstrapped vessel with ${result.importedMessageCount} imported messages` +
        (result.importedMessagesPath ? ` from ${result.importedMessagesPath}` : "") +
        ".\n",
    );
  } else {
    deps.write("Bootstrapped vessel (blank canvas — no imported messages).\n");
  }
  return 0;
}
