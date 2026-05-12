// Vessel-side crash reporter — invoked by run.sh after the vessel process
// exits with a non-clean (non-42) exit code. Reads the captured stderr,
// redacts API-key-shaped tokens, and POSTs the report to the sidecar
// /vessel-crash endpoint. Fire-and-forget: callers background this script
// so the respawn loop is never blocked by network or sidecar slowness.
//
// Coalescing: a single 60-second window across crashes. We persist the
// timestamp of the last successful POST in the state dir; subsequent
// crashes within the window count toward `respawnCountInWindow` but skip
// the POST. The next crash after the window closes posts with the count
// of crashes that occurred while the window was open.
//
// Standalone — no @arianna/types or other workspace imports — so the
// vessel core tarball stays minimal at runtime. The shape is duplicated
// inline; sidecar parses defensively via parseCrashPayload anyway.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

interface CrashReportPayload {
  sessionId: string;
  exitCode: number;
  stderrTail: string;
  timestamp: number;
  respawnCountInWindow: number;
}

export interface ReportCrashOpts {
  sidecarBaseUrl: string;
  sessionId: string;
  exitCode: number;
  stderrFile: string | null;
  stateDir: string;
  /** Last N stderr lines retained; default 50, env override
   * VESSEL_STDERR_TAIL_LINES respected by main(). */
  tailLines?: number;
  /** Coalescing window in ms — only one POST per window. Default 60_000. */
  windowMs?: number;
  /** Test seam: pin "now". */
  now?: () => number;
  /** Test seam: replace global fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Test seam: redirect log output. */
  log?: (msg: string) => void;
}

export const DEFAULT_TAIL_LINES = 50;
export const DEFAULT_WINDOW_MS = 60_000;
export const POST_TIMEOUT_MS = 3_000;

/**
 * Strip API-key-shaped tokens from stderr. Mirrors the sidecar's
 * `redactSecrets` (intentionally duplicated — the vessel runtime can't
 * depend on the sidecar package; defense-in-depth is also done sidecar-side
 * on receipt). Keep these regexes in sync with packages/sidecar/src/crashes.ts.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*=\s*[^\s"'`]+/g,
      "$1=<redacted>",
    )
    .replace(
      /\b(Authorization\s*:\s*Bearer)\s+\S+/gi,
      "$1 <redacted>",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "<redacted>")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{12,}/g, "<redacted>")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted>")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "<redacted>",
    );
}

/** Tail the last `n` non-empty lines of `text`. */
export function tailLines(text: string, n: number): string {
  if (n <= 0) return "";
  const lines = text.split("\n");
  // Trim trailing empty line introduced by a final "\n".
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

interface CoalesceState {
  /** Unix ms of the last POST that actually went out. -1 = never. */
  lastPostedAt: number;
  /** Unix-ms timestamps of recent crashes (within the last window). */
  recentCrashes: number[];
}

/**
 * Decide whether THIS crash should POST. Updates state to reflect the
 * latest crash; the caller persists the returned state regardless of the
 * decision (so even suppressed crashes are counted toward the next window).
 */
export function decideCoalesce(
  state: CoalesceState,
  now: number,
  windowMs: number,
): { shouldPost: boolean; respawnCountInWindow: number; nextState: CoalesceState } {
  const cutoff = now - windowMs;
  const recent = state.recentCrashes.filter((t) => t >= cutoff);
  recent.push(now);
  // Cap memory: even in a wedged loop, never let the in-memory array grow
  // unbounded. 1000 crashes in 60s is already pathological.
  const capped = recent.slice(-1000);

  // -1 = never posted; treat as "outside any window" so the first crash always
  // POSTs. Without this guard the first call would suppress (since -1 is
  // numerically >= any negative cutoff).
  const lastPostInWindow =
    state.lastPostedAt >= 0 && state.lastPostedAt >= cutoff;
  const shouldPost = !lastPostInWindow;

  const nextState: CoalesceState = {
    lastPostedAt: shouldPost ? now : state.lastPostedAt,
    recentCrashes: capped,
  };
  return { shouldPost, respawnCountInWindow: capped.length, nextState };
}

const STATE_FILE = "coalesce-state.json";

export function loadState(stateDir: string): CoalesceState {
  const path = `${stateDir}/${STATE_FILE}`;
  if (!existsSync(path)) {
    return { lastPostedAt: -1, recentCrashes: [] };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CoalesceState>;
    return {
      lastPostedAt: typeof parsed.lastPostedAt === "number" ? parsed.lastPostedAt : -1,
      recentCrashes: Array.isArray(parsed.recentCrashes)
        ? parsed.recentCrashes.filter((t): t is number => typeof t === "number")
        : [],
    };
  } catch {
    return { lastPostedAt: -1, recentCrashes: [] };
  }
}

export function saveState(stateDir: string, state: CoalesceState): void {
  mkdirSync(stateDir, { recursive: true });
  const path = `${stateDir}/${STATE_FILE}`;
  // Tempfile + rename so two crash-helpers racing each other can't tear
  // the state file mid-write. The double-post race is still possible if
  // helper-B reads before helper-A's rename lands — that's accepted (the
  // task explicitly tolerates rare double-posts) — but a corrupt JSON
  // is not, since loadState would silently degrade to empty state and
  // we'd lose the lastPostedAt high-water mark.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Read the captured stderr file. Returns "" if the file is missing or
 * unreadable — never throws. The caller still POSTs (the exit code alone
 * is useful even without stderr).
 */
function readStderr(path: string | null, tailN: number): string {
  if (!path || !existsSync(path)) return "";
  try {
    const raw = readFileSync(path, "utf-8");
    return tailLines(raw, tailN);
  } catch {
    return "";
  }
}

/**
 * Post the crash report to the sidecar. Always returns (never throws):
 * the caller is fire-and-forget and must not block respawn on network
 * issues. Returns true on success for tests.
 */
async function postReport(
  url: string,
  payload: CrashReportPayload,
  fetchFn: typeof globalThis.fetch,
  log: (m: string) => void,
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      log(`[report-crash] sidecar returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`[report-crash] POST failed: ${String(err)}`);
    return false;
  }
}

/**
 * Programmatic entry point — used by tests and by the CLI shim below.
 * Never throws. Returns a small struct describing what happened so tests
 * can assert. The runtime caller (run.sh) ignores the return value.
 */
export interface ReportCrashResult {
  posted: boolean;
  /** True when the POST was suppressed by coalescing. */
  suppressed: boolean;
  payload: CrashReportPayload | null;
  respawnCountInWindow: number;
}

export async function reportCrash(opts: ReportCrashOpts): Promise<ReportCrashResult> {
  const now = (opts.now ?? Date.now)();
  const tailN = opts.tailLines ?? DEFAULT_TAIL_LINES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const log = opts.log ?? (() => { /* silent by default */ });
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  const stderrRaw = readStderr(opts.stderrFile, tailN);
  const stderrTail = redactSecrets(stderrRaw);

  // Coalescing — load state, decide, persist, regardless of POST outcome.
  const prev = loadState(opts.stateDir);
  const { shouldPost, respawnCountInWindow, nextState } = decideCoalesce(
    prev,
    now,
    windowMs,
  );

  // Persist updated coalesce state ASAP so even a crashing helper leaves
  // tracking accurate. Best-effort — a write failure here just means the
  // next call may double-post; we'd rather double-post than not at all.
  try {
    saveState(opts.stateDir, nextState);
  } catch (err) {
    log(`[report-crash] saveState failed: ${String(err)}`);
  }

  if (!shouldPost) {
    return { posted: false, suppressed: true, payload: null, respawnCountInWindow };
  }

  const payload: CrashReportPayload = {
    sessionId: opts.sessionId,
    exitCode: opts.exitCode,
    stderrTail,
    timestamp: now,
    respawnCountInWindow,
  };
  const url = joinUrl(opts.sidecarBaseUrl, "/vessel-crash");
  const posted = await postReport(url, payload, fetchFn, log);
  return { posted, suppressed: false, payload, respawnCountInWindow };
}

function joinUrl(base: string, path: string): string {
  if (base.endsWith("/") && path.startsWith("/")) {
    return base.slice(0, -1) + path;
  }
  if (!base.endsWith("/") && !path.startsWith("/")) {
    return `${base}/${path}`;
  }
  return base + path;
}

// ----- CLI entrypoint -----
//
// Argv shape (run.sh sets these):
//   --exit-code <int>
//   --stderr-file <path>      (optional)
//   --state-dir <path>
//
// Env reads:
//   SIDECAR_BASE_URL          required (defaults to http://sidecar:8000)
//   ARIANNA_SESSION_ID        required (set by docker-compose)
//   VESSEL_STDERR_TAIL_LINES  optional (default 50)

function parseArgv(argv: string[]): {
  exitCode: number;
  stderrFile: string | null;
  stateDir: string;
} {
  const out = { exitCode: 1, stderrFile: null as string | null, stateDir: "/tmp/arianna-vessel-crashes" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--exit-code" && val !== undefined) {
      out.exitCode = parseInt(val, 10) || 0;
      i++;
    } else if (flag === "--stderr-file" && val !== undefined) {
      out.stderrFile = val.length > 0 ? val : null;
      i++;
    } else if (flag === "--state-dir" && val !== undefined) {
      out.stateDir = val;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv.slice(2));
  const sidecarBaseUrl = process.env.SIDECAR_BASE_URL ?? "http://sidecar:8000";
  const sessionId = process.env.ARIANNA_SESSION_ID ?? "";
  if (!sessionId) {
    // No session id → can't attribute the crash. Still bail cleanly so the
    // respawn loop isn't impacted.
    return;
  }
  const tailLinesEnv = process.env.VESSEL_STDERR_TAIL_LINES;
  const tailLinesN = tailLinesEnv ? parseInt(tailLinesEnv, 10) : undefined;

  await reportCrash({
    sidecarBaseUrl,
    sessionId,
    exitCode: args.exitCode,
    stderrFile: args.stderrFile,
    stateDir: args.stateDir,
    tailLines: Number.isFinite(tailLinesN) && tailLinesN! > 0 ? tailLinesN : undefined,
    log: (m) => process.stderr.write(m + "\n"),
  });
}

// Run when invoked directly (`tsx src/report-crash.ts ...`). When imported
// as a library by tests, `import.meta.url` will not match argv[1].
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1] ?? "";
    return argv1.endsWith("/report-crash.ts") || argv1.endsWith("/report-crash.js");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // Surface async errors to log; never throw out of the process.
  main().catch((err) => {
    try {
      process.stderr.write(`[report-crash] fatal: ${String(err)}\n`);
    } catch {
      // ignore
    }
  });
}

// Re-export the parser for tests.
export { parseArgv };
