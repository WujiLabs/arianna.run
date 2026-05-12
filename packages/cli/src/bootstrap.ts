// Shared "ensure vessel is bootstrapped" plumbing.
//
// Two callers want this logic:
//
//   1. `arianna talk`            — auto-bootstrap before the first /chat
//   2. `arianna bootstrap`       — explicit, idempotent
//
// Both ask the vessel for its bootstrap state and, if missing, read whatever
// session seed files the profile dir (or legacy workspace/) has on disk and
// POST them to vessel /bootstrap. After this call, /chat is safe to invoke.

import { existsSync, readFileSync } from "node:fs";

import type { ResolvedConfig } from "./config.js";
import {
  profileImportedMessagesPath,
  profileSessionConfigPath,
  legacyImportedMessagesPath,
  legacySessionConfigPath,
  type PathOpts,
} from "./paths.js";
import { loadConfig } from "./arianna-config.js";

export interface BootstrapDeps {
  fetch: typeof globalThis.fetch;
  /** Override path resolution for tests. */
  pathOpts?: PathOpts;
  /**
   * Total milliseconds to spend retrying transient transport failures (vessel
   * HTTP server hasn't bound yet immediately after `up -d`). Default 30000.
   * Set to 0 in tests that want the legacy fail-fast behavior.
   *
   * Surfaced by canary-003 (Sif's run, 2026-05-09): `arianna bootstrap`
   * printed `error: fetch failed` after a successful compose-up because the
   * post-up POST /bootstrap raced vessel's HTTP bind. Vessel + sidecar were
   * actually healthy; only the eager probe blew. Retrying with backoff lets
   * the cold-start window absorb without surfacing a misleading error.
   */
  readyTimeoutMs?: number;
  /**
   * Polling interval between readiness probes. Default 500ms. Test seam.
   */
  readyIntervalMs?: number;
  /**
   * Sleep implementation for tests. Default uses real setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface BootstrapResult {
  /** True if vessel reported bootstrapped before we did anything. */
  alreadyBootstrapped: boolean;
  /** True if we successfully POSTed /bootstrap on this call. */
  bootstrapped: boolean;
  /** Number of imported messages we sent (0 for blank-canvas). */
  importedMessageCount: number;
  /** Where the imported messages were read from, if any. */
  importedMessagesPath: string | null;
  /** Vessel's reported AI name from /status, when known. */
  aiName: string | null;
}

/**
 * Resolve `{ session_config.json, imported-messages.jsonl }` paths for the
 * resolved profile. Mirrors the legacy/profile-aware split that lives in
 * daemon-profile.ts: a literal `default` that isn't registered in
 * ~/.arianna/config maps to legacy single-tenant `workspace/` paths.
 */
export function resolveProfileSeedPaths(
  config: Pick<ResolvedConfig, "profile">,
  opts: PathOpts = {},
): { sessionConfigPath: string; importedMessagesPath: string } {
  const name = config.profile;

  // No profile resolved at all → nothing useful for us; fall back to legacy.
  if (!name) {
    return {
      sessionConfigPath: legacySessionConfigPath(opts),
      importedMessagesPath: legacyImportedMessagesPath(opts),
    };
  }

  // Literal "default" not registered in ~/.arianna/config → legacy paths,
  // matching daemon-profile.ts's sprint backwards-compat behaviour.
  if (name === "default") {
    let cfg;
    try {
      cfg = loadConfig(opts);
    } catch {
      cfg = null;
    }
    if (!cfg || !cfg.profiles.has("default")) {
      return {
        sessionConfigPath: legacySessionConfigPath(opts),
        importedMessagesPath: legacyImportedMessagesPath(opts),
      };
    }
  }

  return {
    sessionConfigPath: profileSessionConfigPath(name, opts),
    importedMessagesPath: profileImportedMessagesPath(name, opts),
  };
}

interface VesselStatus {
  bootstrapped: boolean;
  aiName?: string;
  messageCount?: number;
  sessionId?: string;
}

/**
 * Result of a single /status probe. Distinguishes "vessel responded" from
 * "vessel unreachable" — the retry loop in fetchStatusWithRetry uses this to
 * decide whether to keep waiting for cold-start or stop.
 */
interface StatusProbe {
  /** Vessel responded with a parseable body. */
  ok: boolean;
  /** Parsed body when ok. */
  status?: VesselStatus;
  /** Transport-level failure (ECONNREFUSED, fetch failed, etc.). */
  transportError?: string;
  /** HTTP-level failure (5xx, 4xx). */
  httpError?: string;
}

async function probeStatus(
  config: ResolvedConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<StatusProbe> {
  try {
    const res = await fetchFn(new URL("/status", config.vesselBaseUrl), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, httpError: `${res.status}` };
    const body = (await res.json()) as VesselStatus;
    return { ok: true, status: body };
  } catch (err) {
    return { ok: false, transportError: (err as Error).message ?? String(err) };
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Poll vessel /status with backoff until it responds or the budget elapses.
 *
 * Returns the first successful StatusProbe (vessel reachable, body parsed)
 * or the last failed probe when the budget is exhausted. Caller decides
 * whether to surface "vessel unreachable" or fall through.
 *
 * Why this exists: immediately after `docker compose up -d`, vessel's HTTP
 * server takes ~1-3s to bind. The legacy code did one synchronous /status
 * probe (silently swallowing errors) and then went straight to POST
 * /bootstrap, which raced vessel's bind and threw `TypeError: fetch failed`.
 * Sif's canary-003 hit this: compose-up succeeded, vessel + sidecar came
 * online seconds later, but operators saw `error: fetch failed`.
 *
 * The retry-with-backoff absorbs the cold-start window. Once /status responds
 * (with bootstrapped: true OR false), we're past the race.
 */
async function fetchStatusWithRetry(
  config: ResolvedConfig,
  fetchFn: typeof globalThis.fetch,
  totalMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<StatusProbe> {
  const start = Date.now();
  let lastProbe: StatusProbe = await probeStatus(config, fetchFn);
  if (lastProbe.ok) return lastProbe;
  // Don't retry on HTTP errors — those are real failures from a reachable
  // vessel (misconfigured, mid-restart, etc.) and a tighter loop won't fix
  // them. Only retry on transport-level errors (ECONNREFUSED / "fetch
  // failed"), which is the cold-start race we're trying to absorb.
  if (lastProbe.httpError !== undefined) return lastProbe;
  if (totalMs <= 0) return lastProbe;

  while (Date.now() - start < totalMs) {
    await sleep(intervalMs);
    lastProbe = await probeStatus(config, fetchFn);
    if (lastProbe.ok) return lastProbe;
    if (lastProbe.httpError !== undefined) return lastProbe;
  }
  return lastProbe;
}

// Read JSONL file. Skips blank lines and lines that fail to JSON.parse —
// matches host/import.ts's tolerance, and keeps a partially-corrupt file
// from blocking the whole bootstrap.
function readJsonlMessages(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: unknown[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export class VesselUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VesselUnreachableError";
  }
}

export async function ensureBootstrapped(
  config: ResolvedConfig,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const totalMs = deps.readyTimeoutMs ?? 30_000;
  const intervalMs = deps.readyIntervalMs ?? 500;
  const sleep = deps.sleep ?? defaultSleep;

  const probe = await fetchStatusWithRetry(
    config,
    deps.fetch,
    totalMs,
    intervalMs,
    sleep,
  );

  // Vessel never came online within the budget. Report a clear, actionable
  // error rather than the previous behavior (silently swallow + then crash on
  // POST /bootstrap with `TypeError: fetch failed`). canary-003 fix.
  if (!probe.ok && probe.transportError !== undefined) {
    throw new VesselUnreachableError(
      `vessel /status unreachable at ${config.vesselBaseUrl} after ${totalMs}ms ` +
        `(transport: ${probe.transportError.split("\n")[0]}). The compose stack ` +
        `appears up but vessel's HTTP server never bound — check \`docker compose ` +
        `... logs vessel\` for startup errors.`,
    );
  }

  const status = probe.status ?? null;
  if (status?.bootstrapped) {
    return {
      alreadyBootstrapped: true,
      bootstrapped: false,
      importedMessageCount: 0,
      importedMessagesPath: null,
      aiName: status.aiName ?? null,
    };
  }

  const { importedMessagesPath } = resolveProfileSeedPaths(
    config,
    deps.pathOpts ?? {},
  );
  const importedMessages = readJsonlMessages(importedMessagesPath);

  const body: Record<string, unknown> = {
    messages: importedMessages,
    context: { systemPrompt: "" },
  };

  // Single retry on transport failure for the POST itself. /status just
  // succeeded so vessel is reachable, but a brief restart between probe and
  // POST shouldn't re-surface as `error: fetch failed`. One retry is enough —
  // anything longer is a real failure mode and should be surfaced.
  let res: Response;
  try {
    res = await deps.fetch(new URL("/bootstrap", config.vesselBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Transport-level error after /status succeeded — give vessel one more
    // moment and try once more before surfacing.
    await sleep(intervalMs);
    try {
      res = await deps.fetch(new URL("/bootstrap", config.vesselBaseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err2) {
      throw new VesselUnreachableError(
        `vessel /bootstrap unreachable at ${config.vesselBaseUrl} ` +
          `(transport: ${(err2 as Error).message ?? String(err2)}). /status responded ` +
          `but the bootstrap POST failed — vessel may have restarted mid-bootstrap. ` +
          `Re-run \`arianna bootstrap\` to retry.`,
      );
    }
  }
  if (!res.ok) {
    throw new Error(`vessel /bootstrap failed: ${res.status}`);
  }

  return {
    alreadyBootstrapped: false,
    bootstrapped: true,
    importedMessageCount: importedMessages.length,
    importedMessagesPath: existsSync(importedMessagesPath)
      ? importedMessagesPath
      : null,
    aiName: status?.aiName ?? null,
  };
}
