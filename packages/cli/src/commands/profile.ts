import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";

import type {
  ProfileArgs,
  ProfileCreateFlags,
  ProfileDeleteFlags,
} from "../argv.js";
import { loadConfig, saveConfig } from "../arianna-config.js";
import { writeComposeOverride } from "../compose-override.js";
import {
  allocateOffset,
  withPortLock,
  type AllocateOpts,
} from "../port-allocator.js";
import {
  DEFAULT_DAEMON_URL_FOR_CLI,
  isLocalDockerAvailable,
} from "../compose-up.js";
import {
  noDefaultAllowedSentinelPath,
  profileDir,
  profileOverridePath,
  type PathOpts,
} from "../paths.js";
import {
  resolveProfile,
  ImplicitDefaultBlockedError,
} from "../profile-resolver.js";
import { blankCanvasLobby } from "../lobby-copy.js";
import { runProfileImport } from "./profile-import.js";
import { runProfileSave, type ProfileSaveDeps } from "./profile-save.js";
import {
  runProfileRestore,
  type ProfileRestoreDeps,
} from "./profile-restore.js";
import {
  runProfileQuit,
  type ProfileQuitDeps,
} from "./profile-quit.js";
import {
  runProfileResume,
  type ProfileResumeDeps,
} from "./profile-resume.js";
import { runProfileFix } from "./profile-fix.js";
import { runProfileFixPairings } from "./profile-fix-pairings.js";
import { runProfileSnapshotOverlay } from "./profile-snapshot-overlay.js";
import type { CloneExecFn } from "./_profile-clone-helpers.js";
import { assertValidProfileName, PROFILE_NAME_RE } from "../profile.js";
import {
  buildSessionConfig,
  SessionConfigError,
  SUPPORTED_PROVIDERS,
} from "../session-config.js";

export interface ProfileDeps extends AllocateOpts {
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /** Source of timestamps for created_at fields. Default: Date.now. */
  now?: () => number;
  /**
   * Run a shell command. Used by `profile delete` (docker compose down) and
   * by `save` + `restore` (docker tag + tarball ops via the shared
   * _profile-clone-helpers module). Tests pass a fake that records calls
   * and returns canned stdout/stderr. Production wires it to
   * promisify(child_process.exec) at the top-level dispatcher.
   */
  exec?: CloneExecFn;
  /**
   * Run a shell command with an optional env override. Used by `profile
   * resume` (which needs to pass session env to `docker compose up -d` when
   * containers were removed). Tests pass a recording fake; production
   * wires it to promisify(child_process.exec).
   */
  execWithEnv?: import("./profile-resume.js").ExecWithEnvFn;
  /** Test seam — current working directory. */
  cwd?: string;
  /** Test seam — temp dir base. */
  tmpDir?: string;
  /**
   * Test seam — defaults to process.env. Used by `--api-key-env` lookup and
   * by interactive-prompt TTY detection.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam for --api-key-env lookup. Defaults to reading from `env` (or
   * process.env). Must NOT read from disk — the option is intentionally
   * scoped to environment-variable indirection so users don't accidentally
   * reference arbitrary file paths.
   */
  readEnvKey?: (varName: string) => string | undefined;
  /**
   * Test seam for TTY detection. Defaults to `() => process.stdin.isTTY ?? false`.
   * When the function returns false and required session-config fields are
   * missing, `profile create` fails fast rather than blocking on stdin.
   */
  isTTY?: () => boolean;
  /**
   * Test seam for interactive prompts. Returns the raw value typed by the
   * user for the given prompt. Production reads from stdin via readline.
   * Tests typically inject a function that throws (asserts the non-interactive
   * branch was taken).
   */
  prompt?: (label: string, opts?: { hidden?: boolean }) => Promise<string>;
  /**
   * Gap 12: force the daemon-route create even when local docker IS
   * available. Mirrors `--use-daemon` on bootstrap. Default false. Production
   * dispatcher leaves this undefined; the auto-detect via
   * `isLocalDockerAvailable()` then handles the OpenClaw container case.
   */
  useDaemon?: boolean;
  /**
   * Gap 12: fetch implementation for the daemon-route create. Required when
   * the daemon path is taken. Production wires `globalThis.fetch`; tests
   * inject a vi.fn().
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Gap 12: daemon URL for the daemon-route create. Defaults to
   * `process.env.ARIANNA_DAEMON_URL ?? DEFAULT_DAEMON_URL_FOR_CLI`.
   */
  daemonUrl?: string;
  /**
   * Gap 12: probe used by `isLocalDockerAvailable` to decide which path to
   * take. Test seam — production leaves this undefined and the real
   * `execSync('docker --version')` probe runs.
   */
  dockerProbe?: () => void;
}

export class ProfileCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileCommandError";
  }
}

export async function runProfile(
  args: ProfileArgs,
  deps: ProfileDeps,
): Promise<number> {
  switch (args.subcommand) {
    case "list":
      return cmdList(deps);
    case "create":
      return cmdCreate(args.name!, args.create ?? {}, deps);
    case "use":
      return cmdUse(args.name!, deps);
    case "current":
      return cmdCurrent(deps);
    case "delete":
      return cmdDelete(args.name!, args.deleteFlags!, deps);
    case "import":
      return runProfileImport(args.importArgs!, deps);
    case "save": {
      const exec = requireExec(deps, "save");
      const saveDeps: ProfileSaveDeps = { ...deps, exec };
      return runProfileSave(args.saveArgs!, saveDeps);
    }
    case "restore": {
      const exec = requireExec(deps, "restore");
      const restoreDeps: ProfileRestoreDeps = { ...deps, exec };
      return runProfileRestore(args.restoreArgs!, restoreDeps);
    }
    case "quit": {
      const exec = requireExec(deps, "quit");
      const quitDeps: ProfileQuitDeps = { ...deps, exec };
      return runProfileQuit(args.quitArgs!, quitDeps);
    }
    case "resume": {
      const exec = requireExecWithEnv(deps, "resume");
      const resumeDeps: ProfileResumeDeps = { ...deps, exec };
      return runProfileResume(args.resumeArgs!, resumeDeps);
    }
    case "fix":
      return runProfileFix(args.fixArgs!, deps);
    case "snapshot-overlay": {
      const exec = requireExec(deps, "snapshot-overlay");
      return runProfileSnapshotOverlay(args.snapshotOverlayArgs!, {
        ...deps,
        exec,
      });
    }
    case "fix-pairings":
      return runProfileFixPairings(args.fixPairingsArgs!, deps);
  }
}

function requireExecWithEnv(
  deps: ProfileDeps,
  sub: string,
): import("./profile-resume.js").ExecWithEnvFn {
  if (!deps.execWithEnv) {
    throw new ProfileCommandError(
      `Internal: profile ${sub} requires an execWithEnv dependency to be wired by the dispatcher.`,
    );
  }
  return deps.execWithEnv;
}

function requireExec(deps: ProfileDeps, sub: string): CloneExecFn {
  if (!deps.exec) {
    throw new ProfileCommandError(
      `Internal: profile ${sub} requires an exec dependency to be wired by the dispatcher.`,
    );
  }
  return deps.exec;
}

// Re-export so the index dispatcher can recognize profile-import / save /
// restore / quit / resume / fix errors at the same level as ProfileCommandError.
export { ProfileImportCommandError } from "./profile-import.js";
export { ProfileSaveError } from "./profile-save.js";
export { ProfileRestoreError } from "./profile-restore.js";
export { ProfileQuitError } from "./profile-quit.js";
export { ProfileResumeError } from "./profile-resume.js";
export { ProfileFixError } from "./profile-fix.js";
export { ProfileFixPairingsError } from "./profile-fix-pairings.js";
export { ProfileSnapshotOverlayError } from "./profile-snapshot-overlay.js";

function cmdList(deps: ProfileDeps): number {
  const cfg = loadConfig(deps);
  if (cfg.profiles.size === 0) {
    deps.write("(no profiles configured)\n");
    return 0;
  }

  // Daemon is shared at 9000 across profiles per the #37 locked decision —
  // only vessel/sidecar shift by port_offset.
  const rows: string[][] = [];
  rows.push(["NAME", "OFFSET", "VESSEL", "SIDECAR", "DAEMON", "DEFAULT"]);
  for (const [name, entry] of cfg.profiles) {
    const isDefault = name === cfg.defaultProfile;
    rows.push([
      name,
      String(entry.portOffset),
      String(3000 + entry.portOffset),
      String(8000 + entry.portOffset),
      "9000 (shared)",
      isDefault ? "*" : "",
    ]);
  }
  deps.write(formatTable(rows));
  return 0;
}

async function cmdCreate(
  name: string,
  flags: ProfileCreateFlags,
  deps: ProfileDeps,
): Promise<number> {
  const cfg = loadConfig(deps);
  if (cfg.profiles.has(name)) {
    throw new ProfileCommandError(
      `Profile "${name}" already exists. Delete it first or pick another name.`,
    );
  }

  // Gap 12 (validation agent abf126be, 2026-05-09): when the CLI runs from
  // inside an OpenClaw container the local filesystem is NOT the same as
  // the host's. Allocating a port + writing compose.override.yml + updating
  // ~/.arianna/config locally means the daemon (running on the host) can't
  // see any of it. Route those file writes through the daemon's
  // POST /profile-create endpoint when local docker is unavailable — same
  // isLocalDockerAvailable() heuristic bc325ae used for /compose-up. After a
  // successful daemon-route create we still write the container's own
  // ~/.arianna/config so subsequent `arianna talk` invocations from inside
  // the container resolve the profile to the right port_offset (the daemon
  // and the container each have their own config; SKILL.md "Profile-config
  // isolation" documents this).
  const routeViaDaemon =
    flags.useDaemon === true ||
    deps.useDaemon === true ||
    !isLocalDockerAvailable(deps.dockerProbe);
  if (routeViaDaemon) {
    if (hasAnyCreateFlag(flags)) {
      throw new ProfileCommandError(
        `--provider/--model/--api-key/--ai-name flags can't be used with daemon-route ` +
          `profile create (no local docker on PATH, or --use-daemon was passed). ` +
          `The daemon endpoint allocates the port + writes the compose override on the ` +
          `host, but session_config.json must be written via \`arianna profile import\` ` +
          `after this command succeeds, or via the lobby flow on the host.`,
      );
    }
    return await cmdCreateViaDaemon(name, deps);
  }

  const dir = profileDir(name, deps);

  // Atomically claim the profile directory. mkdirSync(recursive:false) fails
  // with EEXIST if it's already there — stronger than a separate existsSync
  // pre-check, which would let two concurrent `arianna profile create`
  // invocations both pass the check before either had written. EEXIST →
  // ProfileCommandError.
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ProfileCommandError(
        `Profile directory ${dir} already exists but is not in ~/.arianna/config. ` +
          `Remove it manually, run \`arianna profile use ${name}\` after the entry is added, ` +
          `or pick another name.`,
      );
    }
    throw err;
  }

  // From here on we own dir; any failure past the claim should remove it
  // (and the override file we may have written) before throwing, so a
  // botched create doesn't leave orphaned state blocking retry of the
  // same name.
  try {
    // Allocate inside the lock — keeps a concurrent `profile create` on
    // another shell from picking the same offset.
    const offset = await withPortLock(() => allocateOffset(deps), deps);

    // First pass: write the override without a known aiUsername. If the
    // user passed --provider/--model/--api-key/--ai-name we'll re-render
    // below with the freshly-derived aiUsername so the AI_USERNAME
    // build-arg is baked into the override from t=0. If they didn't, the
    // override stays username-less until a TUI lobby pass writes
    // session_config.json + `arianna profile fix <name>` is run.
    writeComposeOverride(profileOverridePath(name, deps), {
      profile: name,
      portOffset: offset,
    });

    const wantsSessionConfig = hasAnyCreateFlag(flags);
    if (wantsSessionConfig) {
      const filled = await fillCreateFlags(flags, deps);
      const session = buildSessionConfig({
        externalLlmApiKey: filled.externalLlmApiKey,
        provider: filled.provider,
        modelId: filled.modelId,
        aiName: filled.aiName,
        aiUsername: filled.aiUsername,
        cadence: filled.cadence,
        now: deps.now,
      });
      writeFileSync(
        join(dir, "session_config.json"),
        JSON.stringify(session, null, 2),
      );
      // Re-render the override now that we know aiUsername — bakes the
      // AI_USERNAME build-arg into the per-profile override so a future
      // operator-direct `docker compose build vessel` preserves the AI's
      // identity (2026-05-10 Mirin r2 + Pax fix).
      writeComposeOverride(profileOverridePath(name, deps), {
        profile: name,
        portOffset: offset,
        aiUsername: session.aiUsername,
      });
    }

    const now = deps.now ?? Date.now;
    cfg.profiles.set(name, { portOffset: offset, createdAt: now() });
    // First profile created becomes the default automatically — matches
    // AWS-CLI's behaviour where the first `aws configure` populates [default].
    if (!cfg.defaultProfile) {
      cfg.defaultProfile = name;
    }
    saveConfig(cfg, deps);

    deps.write(
      `Created profile "${name}" with port_offset=${offset} ` +
        `(vessel:${3000 + offset} sidecar:${8000 + offset} daemon:9000 [shared]).\n`,
    );
    if (wantsSessionConfig) {
      deps.write(`Wrote session_config.json with the supplied flags.\n`);
    }
    if (cfg.defaultProfile === name) {
      deps.write(`Set as default. Override with --profile or ARIANNA_PROFILE.\n`);
    }
    // Lobby copy: parity with the TUI's blank-canvas onboarding so an LLM
    // agent driving the CLI sees the same Filo voice + a "what to do next"
    // hint. Plain text — no ANSI escapes.
    deps.write("\n");
    deps.write(blankCanvasLobby({ profileName: name }));
    return 0;
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
}

// Gap 12: daemon-route fallback for `arianna profile create`. POSTs to
// /profile-create on the host daemon and lets it run the same allocator +
// override-write + config-update logic on the host's filesystem. After the
// daemon write succeeds we ALSO write the container's local
// ~/.arianna/config so that subsequent `arianna talk` invocations resolve
// the profile to the correct port_offset (the daemon's config and the
// container's config are independent — see SKILL.md "Profile-config
// isolation"). The local profile directory is NOT created — the daemon owns
// it on the host filesystem; the container never needs it for any command
// that talks to the daemon (talk/events/status all flow over HTTP).
async function cmdCreateViaDaemon(
  name: string,
  deps: ProfileDeps,
): Promise<number> {
  const fetcher = deps.fetch ?? globalThis.fetch;
  if (!fetcher) {
    throw new ProfileCommandError(
      `profile create cannot route via the daemon: no fetch wired. ` +
        `Run from a host that has docker installed, or wire deps.fetch in tests.`,
    );
  }
  const env = deps.env ?? process.env;
  const daemonUrl =
    deps.daemonUrl ?? env.ARIANNA_DAEMON_URL ?? DEFAULT_DAEMON_URL_FOR_CLI;

  let res: Response;
  try {
    res = await fetcher(
      `${daemonUrl}/profile-create?name=${encodeURIComponent(name)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
  } catch (err) {
    throw new ProfileCommandError(
      `daemon /profile-create unreachable at ${daemonUrl}: ${(err as Error).message}. ` +
        `Set ARIANNA_DAEMON_URL to override (default: ${DEFAULT_DAEMON_URL_FOR_CLI}).`,
    );
  }

  let body: {
    ok?: boolean;
    name?: string;
    portOffset?: number;
    isDefault?: boolean;
    error?: string;
    code?: string;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new ProfileCommandError(
      `daemon /profile-create returned ${res.status} with non-JSON body.`,
    );
  }

  if (!res.ok || body.ok !== true) {
    const detail = body.error ?? `${res.status}`;
    const codeHint = body.code ? ` (code=${body.code})` : "";
    throw new ProfileCommandError(
      `daemon /profile-create failed for "${name}": ${detail}${codeHint}`,
    );
  }
  if (typeof body.portOffset !== "number" || !Number.isInteger(body.portOffset)) {
    throw new ProfileCommandError(
      `daemon /profile-create returned an invalid portOffset for "${name}": ${String(body.portOffset)}`,
    );
  }
  const offset = body.portOffset;

  // Mirror the allocation into the container's own ~/.arianna/config so
  // local profile resolution (resolveProfile) can find it. The local config
  // is ONLY the name → port_offset mapping; the actual override + state
  // live on the host where the daemon wrote them. If the local config write
  // fails we surface a warning but don't fail the command — the daemon
  // write is authoritative and the operator can re-run
  // `arianna profile use <name>` by hand.
  const localCfg = loadConfig(deps);
  if (!localCfg.profiles.has(name)) {
    const now = deps.now ?? Date.now;
    localCfg.profiles.set(name, { portOffset: offset, createdAt: now() });
    if (!localCfg.defaultProfile) localCfg.defaultProfile = name;
    try {
      saveConfig(localCfg, deps);
    } catch (err) {
      deps.warn?.(
        `warn: daemon-side create succeeded but local ~/.arianna/config write failed: ` +
          `${(err as Error).message}. Run \`arianna profile use ${name}\` to retry.\n`,
      );
    }
  }

  deps.write(
    `Created profile "${name}" via daemon at ${daemonUrl} (port_offset=${offset} ` +
      `vessel:${3000 + offset} sidecar:${8000 + offset} daemon:9000 [shared]).\n`,
  );
  if (body.isDefault) {
    deps.write(`Set as default on the host. Override with --profile or ARIANNA_PROFILE.\n`);
  }
  return 0;
}

interface FilledCreateFlags {
  externalLlmApiKey: string;
  provider: string;
  modelId: string;
  aiName: string;
  aiUsername?: string;
  cadence?: "human" | "agent";
}

// Resolve the four required session-config fields from flags. When values are
// missing, prompt the TTY (or error). The returned record is suitable to pass
// straight into buildSessionConfig.
async function fillCreateFlags(
  flags: ProfileCreateFlags,
  deps: ProfileDeps,
): Promise<FilledCreateFlags> {
  const env = deps.env ?? process.env;
  const readEnvKey = deps.readEnvKey ?? ((varName: string) => env[varName]);

  // --api-key-env: validate and resolve the value first since it can't be
  // prompted for and a missing variable should error immediately.
  let externalLlmApiKey: string | undefined = flags.apiKey;
  if (flags.apiKeyEnv !== undefined) {
    if (!ENV_VAR_RE.test(flags.apiKeyEnv)) {
      throw new ProfileCommandError(
        `--api-key-env "${flags.apiKeyEnv}" is not a valid environment variable name (expected ${ENV_VAR_RE.source}).`,
      );
    }
    const v = readEnvKey(flags.apiKeyEnv);
    if (v === undefined || v === "") {
      throw new ProfileCommandError(
        `--api-key-env "${flags.apiKeyEnv}" is not set in the environment.`,
      );
    }
    externalLlmApiKey = v;
  }

  let provider = flags.provider;
  if (provider !== undefined && !(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ProfileCommandError(
      `--provider "${provider}" is not supported. Try: ${SUPPORTED_PROVIDERS.join(", ")}.`,
    );
  }

  let aiName = flags.aiName;
  const aiUsername = flags.aiUsername;
  let modelId = flags.model;

  // Prompt or error for any still-missing required field.
  const missing: string[] = [];
  if (!provider) missing.push("--provider");
  if (!modelId) missing.push("--model");
  if (!externalLlmApiKey) missing.push("--api-key (or --api-key-env)");
  if (!aiName) missing.push("--ai-name");

  if (missing.length > 0) {
    if (!isInteractive(deps)) {
      throw new ProfileCommandError(
        `Missing required flag(s) for non-interactive create: ${missing.join(", ")}. ` +
          `Either pass them explicitly or run from a TTY to be prompted.`,
      );
    }
    const ask = deps.prompt ?? defaultPrompt;
    if (!provider) {
      const v = (await ask(`provider [${SUPPORTED_PROVIDERS.join("|")}]: `)).trim();
      if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(v)) {
        throw new ProfileCommandError(
          `provider must be one of ${SUPPORTED_PROVIDERS.join(", ")}. Got "${v}".`,
        );
      }
      provider = v;
    }
    if (!modelId) {
      modelId = (await ask("model: ")).trim();
      if (!modelId) throw new ProfileCommandError("model is required.");
    }
    if (!externalLlmApiKey) {
      externalLlmApiKey = (await ask("api key: ", { hidden: true })).trim();
      if (!externalLlmApiKey) throw new ProfileCommandError("api key is required.");
    }
    if (!aiName) {
      aiName = (await ask("ai name: ")).trim();
      if (!aiName) throw new ProfileCommandError("ai name is required.");
    }
  }

  // After this point all four are non-empty strings. The non-null assertion is
  // safe; we just verified above.
  return {
    externalLlmApiKey: externalLlmApiKey!,
    provider: provider!,
    modelId: modelId!,
    aiName: aiName!,
    aiUsername,
    cadence: flags.cadence,
  };
}

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hasAnyCreateFlag(flags: ProfileCreateFlags): boolean {
  return (
    flags.model !== undefined ||
    flags.provider !== undefined ||
    flags.apiKey !== undefined ||
    flags.apiKeyEnv !== undefined ||
    flags.aiName !== undefined ||
    flags.aiUsername !== undefined ||
    flags.cadence !== undefined
  );
}

function isInteractive(deps: ProfileDeps): boolean {
  if (deps.isTTY) return deps.isTTY();
  return Boolean(process.stdin.isTTY);
}

async function defaultPrompt(label: string, opts?: { hidden?: boolean }): Promise<string> {
  // Lazy import — keeps the cost off the cold-start path of non-interactive
  // CLI invocations (most of them).
  const readline = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: !opts?.hidden });
  try {
    if (opts?.hidden) {
      // Suppress echo while reading — same trick as `read -s`. We can't get
      // perfect masking without a tty raw mode, but we can avoid printing the
      // value to the screen.
      stdout.write(label);
      // @ts-expect-error - private but stable: rl._writeToOutput is no-op'd.
      rl._writeToOutput = () => {};
      const ans = await rl.question("");
      stdout.write("\n");
      return ans;
    }
    return await rl.question(label);
  } finally {
    rl.close();
  }
}

function cmdUse(name: string, deps: ProfileDeps): number {
  const cfg = loadConfig(deps);
  if (!cfg.profiles.has(name)) {
    throw new ProfileCommandError(
      `Profile "${name}" not found. Run \`arianna profile create ${name}\` first.`,
    );
  }
  cfg.defaultProfile = name;
  saveConfig(cfg, deps);
  deps.write(`Default profile set to "${name}".\n`);
  return 0;
}

function cmdCurrent(deps: ProfileDeps): number {
  // `current` is read-only. Allow the implicit-default fallback so the
  // command shows what an unspecified `arianna talk` would target during the
  // backwards-compat sprint window.
  let resolved: ReturnType<typeof resolveProfile>;
  try {
    resolved = resolveProfile({ ...deps, allowImplicitDefault: true });
  } catch (err) {
    if (err instanceof ImplicitDefaultBlockedError) {
      deps.write(
        "(no profile resolved — implicit default blocked by " +
          `${noDefaultAllowedSentinelPath(deps)})\n`,
      );
      return 0;
    }
    throw err;
  }
  if (!resolved.name) {
    deps.write("(no profile resolved)\n");
    return 0;
  }
  deps.write(`${resolved.name}\t(source: ${resolved.source})\n`);
  return 0;
}

async function cmdDelete(
  name: string,
  flags: ProfileDeleteFlags,
  deps: ProfileDeps,
): Promise<number> {
  // Defensive validation. The argv parser already enforced the regex but
  // runProfile may be called programmatically. The `name` is interpolated
  // into a `docker compose -p arianna-<name>` shell command below, so the
  // regex is also our shell-injection backstop.
  assertValidProfileName(name);
  // Belt-and-suspenders. Any future relaxation of PROFILE_NAME_RE that
  // permits shell metachars would silently break command construction; this
  // assert never fires under the current regex but documents the
  // requirement at the call site.
  if (!PROFILE_NAME_RE.test(name)) {
    throw new ProfileCommandError(
      `Profile name "${name}" contains characters that would not be safe to interpolate into a shell command.`,
    );
  }

  const cfg = loadConfig(deps);
  const dir = profileDir(name, deps);
  const inConfig = cfg.profiles.has(name);

  // Refuse if neither the config entry nor the workspace dir exists — nothing
  // to do, and any "yes I really mean it" override would just hide a typo.
  if (!inConfig && !existsSync(dir)) {
    throw new ProfileCommandError(
      `Profile "${name}" is not in ~/.arianna/config and has no workspace directory. Nothing to delete.`,
    );
  }

  // Default-profile guard. The config-default profile is the one `arianna
  // talk` etc. resolve to with no flag/env, so removing it silently turns the
  // CLI into a 404 machine. Force-only.
  if (cfg.defaultProfile === name && !flags.force) {
    throw new ProfileCommandError(
      `Profile "${name}" is the configured default. Refusing without --force. ` +
        `Run \`arianna profile use <other>\` first or pass --force to override.`,
    );
  }

  // Dev-workspace sentinel guard. Mirrors the resolveProfile rule: if
  // someone is in a checkout that explicitly opted out of an implicit
  // default profile, deleting the literal "default" entry without --force
  // is almost certainly a mistake.
  if (
    name === "default" &&
    existsSync(noDefaultAllowedSentinelPath(deps)) &&
    !flags.force
  ) {
    throw new ProfileCommandError(
      `Refusing to delete "default" while ${noDefaultAllowedSentinelPath(deps)} exists ` +
        `(dev-workspace marker that blocks implicit default). Pass --force to override.`,
    );
  }

  // Confirmation. Skip in non-TTY environments only when --yes was passed —
  // guards against accidental rm-rf in CI where stdin is closed.
  if (!flags.yes && isInteractive(deps)) {
    const ask = deps.prompt ?? defaultPrompt;
    const ans = (await ask(`Delete profile "${name}"? This is NOT reversible. [y/N] `)).trim().toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      deps.write("Aborted.\n");
      return 1;
    }
  } else if (!flags.yes && !isInteractive(deps)) {
    throw new ProfileCommandError(
      `Refusing to delete profile in a non-TTY environment without --yes. ` +
        `Pass --yes to confirm (and --force if "${name}" is the default).`,
    );
  }

  const removed: string[] = [];

  // Step 1: docker compose down. We pass the project flag explicitly so we
  // tear down only this profile's containers/images/volumes, not the legacy
  // single-tenant stack. If --skip-docker is set or no exec is wired, skip.
  // The profile name is regex-validated so safe to interpolate; we still
  // pass --rmi all -v explicitly so users can audit what was removed.
  if (!flags.skipDocker && deps.exec) {
    // Project name: docker compose normalises to lowercase + drops
    // non-alphanumeric — our regex already produces a compose-safe project.
    const projectName = `arianna-${name}`;
    try {
      await deps.exec(
        `docker compose -p ${projectName} down --rmi all -v --remove-orphans`,
      );
      removed.push(`docker compose project ${projectName} (containers/images/volumes)`);
    } catch (err) {
      // Don't crash the whole delete on docker errors — surface them and
      // proceed with filesystem + config cleanup. The most common cause is
      // "compose file not found" because the user never ran `docker compose
      // up` for this profile, in which case there's nothing to tear down
      // anyway.
      const msg = (err as Error).message ?? String(err);
      deps.warn?.(
        `warn: docker compose down for ${projectName} failed (continuing): ${msg.split("\n")[0]}\n`,
      );
    }
  }

  // Step 2: workspace dir.
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removed.push(`workspace/profiles/${name}/`);
  }

  // Step 3: config entry. Also clear defaultProfile if it pointed at us.
  if (inConfig) {
    cfg.profiles.delete(name);
    if (cfg.defaultProfile === name) cfg.defaultProfile = null;
    saveConfig(cfg, deps);
    removed.push(`[profile ${name}] section in ~/.arianna/config`);
  }

  deps.write(`Deleted profile "${name}":\n`);
  for (const item of removed) deps.write(`  - ${item}\n`);
  if (flags.skipDocker) {
    deps.write(
      `  (skipped docker compose down — re-run without --skip-docker to remove containers)\n`,
    );
  }
  return 0;
}

// Cheap right-padded text table — no need to pull in a dep for four columns.
function formatTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((r) => r[col].length)),
  );
  return (
    rows
      .map((row) =>
        row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd(),
      )
      .join("\n") + "\n"
  );
}

// Re-exported so the index dispatcher can pick which path-related options to
// pass without depending on every module directly.
export type ProfileCmdOpts = PathOpts;

// Re-export so tests can assert against the same instance.
export { SessionConfigError };
