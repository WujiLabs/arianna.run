// Shared "ensure the docker compose stack is up" plumbing.
//
// Three callers want this logic:
//
//   1. `arianna bootstrap`         — auto-up the stack before POSTing /bootstrap
//                                    (canary acb7b292 surfaced the gap: the
//                                    driver had to manually `docker compose
//                                    -p arianna-canary-001 -f ... up -d`).
//   2. `arianna profile resume`    — resume a quit profile (already wired).
//   3. (future) any command that wants the same idempotent up.
//
// Pure command-builder + idempotent wrapper. The pure part is `composeBaseFor`
// and `buildComposeEnvFromSession`; both are unit-testable without spawning
// docker. The wrapper `ensureComposeUp` runs the actual exec and is exercised
// in the bootstrap regression test with a recording exec fake.
//
// Daemon-route fallback: when local docker isn't available (the canonical
// case is `arianna` running inside an OpenClaw container — host.docker.internal
// reaches the daemon at :9000 but no docker binary is installed in the
// container), `ensureComposeUp` POSTs to the daemon's `/compose-up` endpoint
// and lets the host-side daemon run `docker compose up -d --remove-orphans`
// against the same profile. This unblocks the openclaw incubation flow without
// forcing the operator to install docker inside the dev container. Surface
// is `ARIANNA_DAEMON_URL` (default `http://host.docker.internal:9000`) and
// the `--use-daemon` flag on `arianna bootstrap` for explicit override when
// both paths are available.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import type { ResolvedConfig } from "./config.js";
import { profileSessionConfigPath, type PathOpts } from "./paths.js";
import { assertValidProfileName, PROFILE_NAME_RE } from "./profile.js";

export type ExecWithEnvFn = (
  cmd: string,
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export class ComposeUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeUpError";
  }
}

/** Default daemon URL when `ARIANNA_DAEMON_URL` is unset. Matches the value
 * the sidecar uses to reach the daemon from inside its container — the same
 * resolver works inside any Docker container that can hit the host's
 * loopback via Docker Desktop's `host.docker.internal` synthesis. */
export const DEFAULT_DAEMON_URL_FOR_CLI = "http://host.docker.internal:9000";

/**
 * Detect whether the local environment can run `docker compose up -d` itself.
 * Uses `docker --version` rather than `docker info` so we don't pay the
 * round-trip to the docker daemon — we only need to know the binary is on PATH
 * (the `up -d` invocation will surface a clearer "Cannot connect" error if the
 * daemon itself is down). Synchronous because this gates a single decision at
 * the start of `ensureComposeUp` and the latency (~5-15ms cold) is negligible
 * next to a real compose-up.
 *
 * Test seam: the `execProbe` argument lets unit tests inject a controlled
 * success/failure without monkey-patching child_process. Production callers
 * leave it undefined and get the real `execSync` probe.
 */
export function isLocalDockerAvailable(
  execProbe?: () => void,
): boolean {
  try {
    if (execProbe) {
      execProbe();
      return true;
    }
    execSync("docker --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface ComposeBase {
  /** Full `docker compose -p ... -f ... -f ...` prefix. */
  base: string;
  /** Profile name routed through the project flag (for log lines). */
  projectName: string;
}

/**
 * Build the `docker compose ...` argument prefix for a resolved config.
 * Mirrors the daemon's `composeBaseCommand` shape so a single up command
 * targets the same project the daemon does. Pure — no I/O.
 *
 * Legacy single-tenant flow (no profile, or literal "default" without a
 * config entry) returns the bare `docker compose` prefix. Named profiles get
 * `-p arianna-<name> -f docker-compose.yml -f workspace/profiles/<name>/compose.override.yml`.
 */
export function composeBaseFor(config: ResolvedConfig): ComposeBase {
  if (!config.profile || config.isLegacy) {
    return { base: "docker compose", projectName: "arianna" };
  }
  const name = config.profile;
  // Defense-in-depth — name reaches a shell. The argv parser regex already
  // accepts only `^[a-z][a-z0-9-]{0,30}$` but profileN ame can also arrive
  // from ARIANNA_PROFILE env or ~/.arianna/config. Re-assert.
  assertValidProfileName(name);
  if (!PROFILE_NAME_RE.test(name)) {
    throw new ComposeUpError(
      `Profile name "${name}" contains characters that would not be safe to interpolate into a shell command.`,
    );
  }
  const projectName = `arianna-${name}`;
  const overrideRel = `workspace/profiles/${name}/compose.override.yml`;
  const base = `docker compose -p ${projectName} -f docker-compose.yml -f ${overrideRel}`;
  return { base, projectName };
}

/**
 * Build the env block to pass to `docker compose up -d`. Mirrors
 * profile-resume.ts's `buildComposeEnv`: reads the profile's
 * session_config.json (if present) and exports the AI_*, API_KEY, PROVIDER,
 * MODEL_ID, ARIANNA_SESSION_ID, ARIANNA_VESSEL_TAG vars compose interpolates
 * into vessel/sidecar service definitions.
 *
 * Legacy single-tenant flow: returns baseEnv unchanged. The legacy compose
 * file already reads from the host TUI's env-injection (or assumes defaults).
 *
 * Pure-ish — does read the session_config.json file but no shell-out. Test
 * by passing a path-overridden ResolvedConfig + matching pathOpts.
 */
export function buildComposeEnvFromSession(
  config: ResolvedConfig,
  baseEnvIn?: NodeJS.ProcessEnv,
  pathOpts: PathOpts = {},
): NodeJS.ProcessEnv {
  const baseEnv = { ...(baseEnvIn ?? process.env) } as NodeJS.ProcessEnv;
  if (!config.profile || config.isLegacy) return baseEnv;

  const sessionPath = profileSessionConfigPath(config.profile, pathOpts);
  if (!existsSync(sessionPath)) return baseEnv;

  try {
    const raw = readFileSync(sessionPath, "utf-8");
    const cfg = JSON.parse(raw) as {
      aiUsername?: string;
      aiName?: string;
      externalLlmApiKey?: string;
      provider?: string;
      modelId?: string;
      sessionId?: string;
    };
    if (cfg.aiUsername) baseEnv.AI_USERNAME = cfg.aiUsername;
    if (cfg.aiName) baseEnv.AI_NAME = cfg.aiName;
    if (cfg.externalLlmApiKey) baseEnv.API_KEY = cfg.externalLlmApiKey;
    if (cfg.provider) baseEnv.PROVIDER = cfg.provider;
    if (cfg.modelId) baseEnv.MODEL_ID = cfg.modelId;
    if (cfg.sessionId) {
      baseEnv.ARIANNA_SESSION_ID = cfg.sessionId;
      baseEnv.ARIANNA_VESSEL_TAG = `${cfg.sessionId}-current`;
    }
  } catch {
    // Best-effort. Malformed session_config.json shouldn't block bringing up
    // the stack — if it's truly broken, the vessel will fail to start and
    // that error will be surfaced by the health probe one layer up.
  }
  return baseEnv;
}

export interface EnsureComposeUpDeps {
  /**
   * Run a shell command with optional env override. Required for the local
   * docker path. When the daemon-route fallback is taken (no local docker, or
   * `useDaemon: true`), this is not invoked — callers can wire it lazily from
   * `child_process.exec` in production and a recording fake in tests.
   */
  exec: ExecWithEnvFn;
  /** stdout. Optional — the wrapper is silent on the happy fast-path. */
  write?: (line: string) => void;
  /** stderr. Used to surface "containers were down; bringing up" notices. */
  warn?: (line: string) => void;
  /** Path-resolution overrides, threaded into buildComposeEnvFromSession. */
  pathOpts?: PathOpts;
  /** Override process.env (for tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * Fetch implementation for the daemon-route fallback. Required when the
   * daemon path is taken (no local docker, or `useDaemon: true`). Production
   * callers wire `globalThis.fetch`; tests inject a vi.fn().
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Force the daemon-route path even when local docker IS available. Used by
   * `arianna bootstrap --use-daemon` for the dev case where both arianna and
   * docker live on the host but the operator wants to test the daemon path.
   */
  useDaemon?: boolean;
  /**
   * Daemon URL for the daemon-route fallback. Defaults to
   * `process.env.ARIANNA_DAEMON_URL ?? DEFAULT_DAEMON_URL_FOR_CLI`. Test seam.
   */
  daemonUrl?: string;
  /**
   * Probe used by `isLocalDockerAvailable` to decide which path to take. Test
   * seam — production leaves this undefined and the real `execSync('docker
   * --version')` probe runs.
   */
  dockerProbe?: () => void;
  /**
   * Daemon-route only. When set, the value is threaded into the POST body
   * to /compose-up as `{ writePrelude }`. The daemon's /compose-up endpoint
   * uses it to decide whether to also write the canonical Filo opening box
   * into the profile's `imported-messages.jsonl`. Closes the openclaw container
   * blocker (validation aea28db5): the CLI's local prelude-write resolves
   * paths through `resolveRepoRoot`, which inside an openclaw container walks
   * up cwd and finds openclaw's docker-compose.yml — the prelude lands at a
   * path the host daemon never reads. Folding the prelude write into
   * /compose-up means the daemon (which already has authoritative access to
   * the host's profile workspace) does both jobs in one round trip.
   *
   * Local route ignores this — the CLI does its own prelude write before
   * ensureComposeUp on the local route, where path resolution against the
   * cwd-walked repo root works correctly (laptop dev flow).
   *
   * Default behavior (omitted): the daemon writes the prelude. Pass `false`
   * to opt out (mirrors `--no-prelude` on `arianna bootstrap`).
   */
  daemonWritePrelude?: boolean;
}

export interface EnsureComposeUpResult {
  /** True when `up -d` was actually run on this call. */
  broughtUp: boolean;
  /** True when a probe found at least one running service before any action. */
  alreadyUp: boolean;
  /** projectName + base for log lines / error messages. */
  composeBase: ComposeBase;
  /**
   * Which path was taken. "local" → docker exec on the calling host;
   * "daemon" → POST /compose-up to the host daemon (openclaw container case).
   */
  route: "local" | "daemon";
  /**
   * Daemon route only — true when the daemon reported it wrote the Filo
   * opening prelude into `imported-messages.jsonl`. Undefined on the local
   * route (the CLI handles prelude write client-side). Local route callers
   * shouldn't read this field.
   */
  daemonPreludeWritten?: boolean;
  /**
   * Daemon route only — short stable token explaining why the daemon DIDN'T
   * write the prelude (when daemonPreludeWritten is false). One of:
   *   - "writePrelude=false"        (caller opted out via --no-prelude)
   *   - "imported-messages-exists"  (seed file already on disk)
   *   - "session-config-missing"    (no session_config.json yet)
   *   - "ai-name-missing"           (config exists but has no aiName field)
   *   - "write-failed"              (filesystem error — see daemon log)
   */
  daemonPreludeSkipReason?: string;
  /**
   * Daemon route only — true when the daemon successfully forwarded a
   * `/bootstrap` POST to vessel after bringing the stack up. Closes the
   * openclaw container blocker (validation abfd4b13, 2026-05-09): the CLI's
   * subsequent `ensureBootstrapped` step would otherwise read
   * imported-messages.jsonl from the openclaw container's filesystem (where
   * it doesn't exist), POST an empty messages array, and the AI would wake
   * as a generic stock assistant. The daemon now does the bootstrap forward
   * itself with the host-side authoritative seed file. Only meaningful on
   * the cold path (when broughtUp: true) — on the alreadyUp fast path the
   * vessel is already running and the CLI's normal flow handles it.
   * Undefined on the local route.
   */
  daemonVesselBootstrapped?: boolean;
  /**
   * Daemon route only — error message from the daemon's vessel /bootstrap
   * forward attempt (when daemonVesselBootstrapped is false). The CLI's
   * subsequent ensureBootstrapped step is idempotent and will re-try, so
   * this is informational rather than fatal. Undefined when the bootstrap
   * forward succeeded or wasn't attempted.
   */
  daemonVesselBootstrapError?: string;
}

/**
 * Idempotent: probe `docker compose ps --services --filter status=running`;
 * if any service is running, no-op. Otherwise run `docker compose up -d
 * --remove-orphans` with the env block built from session_config.json.
 *
 * Two routes:
 *   - "local" — the calling host has docker on PATH. Run the probe + up
 *     directly via `deps.exec`. This is the existing fast path that every
 *     pre-openclaw caller (laptop, CI, test fixtures) takes.
 *   - "daemon" — local docker is missing OR the caller passed `useDaemon`.
 *     POST `/compose-up` to the daemon and let it run the same probe + up
 *     server-side. Used by `arianna bootstrap` invoked from inside an
 *     OpenClaw dev container, where there's no docker binary but the daemon
 *     is reachable at `host.docker.internal:9000`.
 *
 * Why probe first instead of "always up -d":
 *   - `up -d` on already-up containers is technically a no-op too, but it
 *     prints a per-service "Container ... Running" line that adds visual
 *     noise to every `arianna talk` invocation. Operators-with-stack-up
 *     should see no new behavior.
 *   - The probe is ~20ms; one extra exec on the cold path is cheap insurance.
 *
 * Throws ComposeUpError when the up itself fails — caller decides whether to
 * surface to stdout/stderr or to wrap in a higher-level error message.
 */
export async function ensureComposeUp(
  config: ResolvedConfig,
  deps: EnsureComposeUpDeps,
): Promise<EnsureComposeUpResult> {
  const composeBase = composeBaseFor(config);

  // Route selection. `useDaemon` is the explicit override; otherwise probe
  // for a local docker binary. Detection runs once per call and is cached
  // nowhere — that's fine because each `ensureComposeUp` invocation is on a
  // fresh CLI process.
  const useDaemon =
    deps.useDaemon === true ||
    !isLocalDockerAvailable(deps.dockerProbe);

  if (useDaemon) {
    return await daemonComposeUp(config, composeBase, deps);
  }

  return await localComposeUp(config, composeBase, deps);
}

async function localComposeUp(
  config: ResolvedConfig,
  composeBase: ComposeBase,
  deps: EnsureComposeUpDeps,
): Promise<EnsureComposeUpResult> {
  // Probe: do we already have any running services for this project?
  // `ps --services --filter status=running` returns one service name per
  // line on stdout. Empty string ⇒ nothing running (or the project doesn't
  // exist yet — same outcome from our POV: we need to up).
  let alreadyUp = false;
  try {
    const { stdout } = await deps.exec(
      `${composeBase.base} ps --services --filter status=running`,
    );
    alreadyUp = stdout.trim().length > 0;
  } catch (err) {
    // If the probe fails (compose file missing, docker daemon down, etc.)
    // we'd usually want to surface "stack appears down" and try `up -d`
    // anyway — `up -d` will produce a clearer error than `ps` for the
    // common cases (compose file syntax, docker daemon not running).
    const msg = (err as Error).message ?? String(err);
    deps.warn?.(
      `warn: docker compose ps for ${composeBase.projectName} failed (continuing to up -d): ${msg.split("\n")[0]}\n`,
    );
  }

  if (alreadyUp) {
    return { broughtUp: false, alreadyUp: true, composeBase, route: "local" };
  }

  deps.write?.(
    `Bringing up docker compose stack for project ${composeBase.projectName}...\n`,
  );

  const composeEnv = buildComposeEnvFromSession(
    config,
    deps.env ?? process.env,
    deps.pathOpts ?? {},
  );

  try {
    await deps.exec(`${composeBase.base} up -d --remove-orphans`, {
      env: composeEnv,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Take the first line — compose error tails can be hundreds of lines of
    // BuildKit output that drown the actual cause. Caller can re-run with
    // `docker compose ... up -d` directly to see the full output.
    const head = msg.split("\n").slice(0, 3).join("\n");
    throw new ComposeUpError(
      `docker compose up -d failed for project ${composeBase.projectName}: ${head}\n` +
        `Try running \`${composeBase.base} up -d --remove-orphans\` directly to see the full output, ` +
        `or check that Docker is running.`,
    );
  }

  return { broughtUp: true, alreadyUp: false, composeBase, route: "local" };
}

async function daemonComposeUp(
  config: ResolvedConfig,
  composeBase: ComposeBase,
  deps: EnsureComposeUpDeps,
): Promise<EnsureComposeUpResult> {
  if (!deps.fetch) {
    throw new ComposeUpError(
      `docker compose up -d cannot run: no local docker binary, and no fetch ` +
        `wired for the daemon-route fallback. Wire deps.fetch in the dispatcher ` +
        `or run from a host that has docker installed.`,
    );
  }
  const env = deps.env ?? process.env;
  const daemonUrl =
    deps.daemonUrl ?? env.ARIANNA_DAEMON_URL ?? DEFAULT_DAEMON_URL_FOR_CLI;

  // The daemon needs a profile name to route the request. Sprint backwards-
  // compat (legacy single-tenant): when no profile resolved, send the literal
  // "default" — the daemon's resolveProfileContext maps that back to legacy
  // paths the same way it does for any other endpoint.
  const profileForDaemon =
    config.profile && !config.isLegacy ? config.profile : "default";

  // Surface routing intent on stdout so operators in the openclaw container
  // see WHICH stack is being brought up and via WHICH route. Fast-path is
  // silent (alreadyUp returns 200 with broughtUp:false and we mirror the
  // local-route behavior).
  deps.write?.(
    `Bringing up docker compose stack for project ${composeBase.projectName} via daemon at ${daemonUrl}...\n`,
  );

  // Build the POST body. We always send a JSON object; the daemon defaults
  // to writePrelude=true unless we explicitly send `{ writePrelude: false }`.
  // The current call sites (runBootstrap on the daemon route) always pass
  // a boolean so the daemon's behavior is fully driven by the CLI flag.
  const body: { writePrelude?: boolean } = {};
  if (deps.daemonWritePrelude !== undefined) {
    body.writePrelude = deps.daemonWritePrelude;
  }

  let res: Response;
  try {
    res = await deps.fetch(`${daemonUrl}/compose-up?profile=${encodeURIComponent(profileForDaemon)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new ComposeUpError(
      `daemon /compose-up unreachable at ${daemonUrl}: ${msg}. ` +
        `Set ARIANNA_DAEMON_URL to override (default: ${DEFAULT_DAEMON_URL_FOR_CLI}).`,
    );
  }

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const errBody = await res.text();
      if (errBody) detail = `${res.status}: ${errBody.slice(0, 500)}`;
    } catch {
      // body unreadable — keep status-only
    }
    throw new ComposeUpError(
      `daemon /compose-up failed for project ${composeBase.projectName}: ${detail}`,
    );
  }

  // Daemon returns `{ ok: true, broughtUp: boolean, alreadyUp: boolean,
  // preludeWritten?: boolean, preludeSkipReason?: string,
  // vesselBootstrapped?: boolean, vesselBootstrapError?: string }`. We
  // propagate through so callers get the same shape as the local route —
  // operators see "already up" silently, fresh up loudly. The prelude
  // fields surface what the daemon actually did with imported-messages.jsonl
  // so the CLI can log it. The vesselBootstrapped fields close the openclaw
  // container blocker (validation abfd4b13) — the daemon now POSTs
  // /bootstrap to vessel itself after bring-up, since the CLI inside an
  // openclaw container can't read the host's imported-messages.jsonl.
  let parsed: {
    broughtUp?: boolean;
    alreadyUp?: boolean;
    preludeWritten?: boolean;
    preludeSkipReason?: string;
    vesselBootstrapped?: boolean;
    vesselBootstrapError?: string;
  } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // Body wasn't JSON — assume it ran and brought up. Better to over-claim
    // "broughtUp: true" than to silently drop the result.
  }
  return {
    broughtUp: parsed.broughtUp ?? true,
    alreadyUp: parsed.alreadyUp ?? false,
    composeBase,
    route: "daemon",
    daemonPreludeWritten: parsed.preludeWritten,
    daemonPreludeSkipReason: parsed.preludeSkipReason,
    daemonVesselBootstrapped: parsed.vesselBootstrapped,
    daemonVesselBootstrapError: parsed.vesselBootstrapError,
  };
}
