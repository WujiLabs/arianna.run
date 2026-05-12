// Resolve the vessel's sessionId at startup.
//
// History: pre-fix, the vessel read sessionId exclusively from
// `process.env.ARIANNA_SESSION_ID`, with `session_${Date.now()}` as fallback.
// Compose's `${ARIANNA_SESSION_ID:-default}` substitution meant any startup
// path that didn't set the env var (e.g. `docker compose up -d` invoked by
// hand, or a profile created before the host TUI's `getDockerEnv` shim
// existed) silently launched the vessel as `sessionId="default"`.
//
// The vessel's sessionId is sent to the sidecar in every /sync payload, and
// the sidecar overwrites its `activeSessionId` with whatever value arrives.
// That `activeSessionId` is then passed to the daemon /snapshot endpoint,
// which uses it to tag the docker image (`ariannarun-vessel:{sessionId}-snap_X`).
// So a vessel that boots with `ARIANNA_SESSION_ID=default` poisons the entire
// snapshot lineage for the profile, even though the sidecar's
// /app/session_config.json mount has the correct id.
//
// Fix: prefer the same source-of-truth file that the sidecar uses
// (`/app/session_config.json`, mounted into both containers via
// docker-compose). Env stays as a fallback so callers that don't mount the
// file (older e2e harnesses, local `node dist/index.js` invocations) keep
// working.

import { readFileSync } from "node:fs";

// Mirrors @arianna.run/cli's profile-name regex but applied to sessionId. The
// daemon already enforces the same shape via SAFE_ID_RE before tagging — we
// re-validate here so a malformed config can't silently slip through.
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface ResolveSessionIdOpts {
  /** Read the file at this path. Defaults to `/app/session_config.json`. */
  configPath?: string;
  /** Env source. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Time source. Defaults to `Date.now`. */
  now?: () => number;
  /** File-read seam. Defaults to fs.readFileSync. */
  readFile?: (path: string) => string;
}

/**
 * Resolution chain (matches packages/sidecar/src/index.ts initialSessionId):
 *
 *   1. /app/session_config.json `sessionId` field, if it parses and matches
 *      SAFE_SESSION_ID_RE.
 *   2. /app/session_config.json `createdAt` field → `session_${createdAt}`.
 *   3. ARIANNA_SESSION_ID env, if set and matches SAFE_SESSION_ID_RE.
 *   4. `session_${now()}` placeholder so downstream code keeps a stable id.
 *
 * Step 3 (env fallback) is intentionally below the file. The bug being fixed
 * is exactly "env got set wrong (compose default kicked in) and we trusted
 * it." The file is the source the sidecar already trusts; aligning the
 * vessel's resolution with the sidecar's keeps the two in agreement.
 */
export function resolveSessionId(opts: ResolveSessionIdOpts = {}): string {
  const configPath = opts.configPath ?? "/app/session_config.json";
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;

  try {
    const raw = readFile(configPath);
    const cfg = JSON.parse(raw) as { sessionId?: unknown; createdAt?: unknown };
    if (typeof cfg.sessionId === "string" && SAFE_SESSION_ID_RE.test(cfg.sessionId)) {
      return cfg.sessionId;
    }
    if (typeof cfg.createdAt === "number" && Number.isFinite(cfg.createdAt)) {
      return `session_${cfg.createdAt}`;
    }
  } catch {
    // File missing / unreadable / malformed — fall through to env.
  }

  const fromEnv = env.ARIANNA_SESSION_ID;
  if (typeof fromEnv === "string" && SAFE_SESSION_ID_RE.test(fromEnv)) {
    return fromEnv;
  }

  return `session_${now()}`;
}
