// `arianna [--profile <name>] profile resume` — start the stopped containers
// of a previously-quit profile back up. Pairs with `profile quit`.
//
// Strategy:
//   - If the containers exist (stopped state), `docker compose start` brings
//     them back with the writable overlay intact.
//   - If the containers were removed (e.g. `docker compose down` was run
//     manually), fall back to `docker compose up -d`. Print a warning so
//     the user knows state may be reduced to the last image, not the last
//     live overlay.
//   - Wait for sidecar /health and vessel /health on the profile's own
//     ports before declaring success.

import { existsSync, readFileSync } from "node:fs";

import type { ProfileResumeArgs } from "../argv.js";
import { loadConfig } from "../arianna-config.js";
import {
  profileDir,
  profileOverridePath,
  profileSessionConfigPath,
  type PathOpts,
} from "../paths.js";
import { assertValidProfileName, PROFILE_NAME_RE } from "../profile.js";

export class ProfileResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileResumeError";
  }
}

/**
 * Production-side exec wrapper that also accepts an env override. Tests pass
 * a fake that records both the cmd and the env (so we can assert resume
 * passes the right vars to `up -d`). We don't reuse `CloneExecFn` directly
 * because that signature only takes a string — we'd lose env injection
 * coverage in tests.
 */
export type ExecWithEnvFn = (
  cmd: string,
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface ProfileResumeDeps extends PathOpts {
  write: (line: string) => void;
  warn?: (line: string) => void;
  /** Run a shell command, optionally with an env override (for `up -d`). */
  exec: ExecWithEnvFn;
  env?: NodeJS.ProcessEnv;
  /** Probe a URL. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Sleep between health probes. Defaults to setTimeout-based wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Total health-wait deadline in ms per service. Default: 30000. */
  healthDeadlineMs?: number;
}

export async function runProfileResume(
  args: ProfileResumeArgs,
  deps: ProfileResumeDeps,
): Promise<number> {
  assertValidProfileName(args.name);
  if (!PROFILE_NAME_RE.test(args.name)) {
    throw new ProfileResumeError(
      `Profile name "${args.name}" contains characters that would not be safe to interpolate into a shell command.`,
    );
  }

  const cfg = loadConfig(deps);
  const entry = cfg.profiles.get(args.name);
  const dir = profileDir(args.name, deps);
  if (!entry && !existsSync(dir)) {
    throw new ProfileResumeError(
      `No such profile "${args.name}" — not in ~/.arianna/config and no workspace dir.`,
    );
  }
  // Refuse the half-state where the workspace dir exists but the config
  // entry is gone — we'd otherwise default to port_offset=0 below, which
  // collides with the legacy single-tenant ports if the profile was
  // originally created at any offset > 0. The user should reconcile by
  // re-running `arianna profile create` (which re-allocates an offset)
  // or by hand-editing ~/.arianna/config.
  if (!entry) {
    throw new ProfileResumeError(
      `Profile "${args.name}" has a workspace dir but no entry in ~/.arianna/config. ` +
        `Cannot determine port_offset; refusing to guess. Re-add the entry or recreate the profile.`,
    );
  }

  const overridePath = profileOverridePath(args.name, deps);
  if (!existsSync(overridePath)) {
    throw new ProfileResumeError(
      `Profile "${args.name}" has no compose.override.yml at ${overridePath}.`,
    );
  }

  const projectName = `arianna-${args.name}`;
  const composeBase =
    `docker compose -p ${projectName} ` +
    `-f docker-compose.yml -f ${composeOverrideRelPath(args.name)}`;

  // Decide between `start` (containers exist, just stopped) and `up -d`
  // (containers removed). `compose ps -a --format json` lists every service
  // container including stopped/removed ones; empty output means nothing
  // exists for this project at all.
  let havePersistedContainers = false;
  try {
    const { stdout } = await deps.exec(`${composeBase} ps -a --format json`);
    havePersistedContainers = stdout.trim().length > 0;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    deps.warn?.(
      `warn: docker compose ps for ${projectName} failed: ${msg.split("\n")[0]}\n`,
    );
  }

  const composeEnv = buildComposeEnv(args.name, deps);

  if (!havePersistedContainers) {
    deps.warn?.(
      `warn: containers for "${args.name}" were removed; rebuilding via \`up -d\`.\n`,
    );
    try {
      await deps.exec(`${composeBase} up -d --remove-orphans`, { env: composeEnv });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      deps.warn?.(`error: docker compose up failed: ${msg.split("\n")[0]}\n`);
      return 1;
    }
  } else {
    try {
      await deps.exec(`${composeBase} start`, { env: composeEnv });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      deps.warn?.(`error: docker compose start failed: ${msg.split("\n")[0]}\n`);
      return 1;
    }
  }

  // Health gating: wait for sidecar /health then vessel /health on the
  // profile's own ports.
  const offset = entry.portOffset;
  const sidecarUrl = `http://127.0.0.1:${8000 + offset}/health`;
  const vesselUrl = `http://127.0.0.1:${3000 + offset}/health`;

  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = deps.healthDeadlineMs ?? 30000;

  if (!(await waitForHealth(sidecarUrl, fetchFn, sleep, deadline))) {
    deps.warn?.(
      `error: sidecar at ${sidecarUrl} did not become healthy within ${deadline}ms.\n`,
    );
    return 1;
  }
  if (!(await waitForHealth(vesselUrl, fetchFn, sleep, deadline))) {
    deps.warn?.(
      `error: vessel at ${vesselUrl} did not become healthy within ${deadline}ms.\n`,
    );
    return 1;
  }

  deps.write(`Profile "${args.name}" resumed.\n`);
  return 0;
}

function composeOverrideRelPath(name: string): string {
  return `workspace/profiles/${name}/compose.override.yml`;
}

// Build the env vars the vessel + sidecar containers expect. Mirrors the
// host TUI's `getDockerEnv` but profile-aware (reads
// workspace/profiles/<name>/session_config.json). When the file is missing
// or unreadable we return process.env unchanged.
function buildComposeEnv(
  name: string,
  deps: ProfileResumeDeps,
): NodeJS.ProcessEnv {
  const baseEnv = { ...(deps.env ?? process.env) } as NodeJS.ProcessEnv;
  const sessionPath = profileSessionConfigPath(name, deps);
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
    // Best-effort. A malformed session_config.json shouldn't block resume —
    // if `up -d` rebuild is the path, compose will use its defaults; if
    // `start` is the path, env wasn't going to be re-read anyway.
  }
  return baseEnv;
}

async function waitForHealth(
  url: string,
  fetchFn: typeof globalThis.fetch,
  sleep: (ms: number) => Promise<void>,
  deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetchFn(url);
      if (res.ok) return true;
    } catch {
      // not yet listening
    }
    await sleep(500);
  }
  return false;
}

