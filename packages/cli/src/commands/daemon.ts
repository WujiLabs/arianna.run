// `arianna daemon start | stop | status` — explicit lifecycle for the shared
// host daemon. Per the eng-review-locked decision (#37 D3) there is exactly
// one daemon process bound to 127.0.0.1:9000 serving all profiles, so this
// module deliberately does NOT take a profile argument.
//
// Production wires the spawn/exec/fetch hooks to real Node primitives. Tests
// inject fakes via the deps interface.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn as cpSpawn } from "node:child_process";

import type { DaemonArgs, DaemonSubcommand } from "../argv.js";
import { resolveAriannaHome, findRepoRoot, type PathOpts } from "../paths.js";
import {
  DEFAULT_DAEMON_URL_FOR_CLI,
  isLocalDockerAvailable,
} from "../compose-up.js";

export const DAEMON_PORT = 9000;
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_HEALTH_TIMEOUT_MS = 15_000;
export const DAEMON_STOP_TIMEOUT_MS = 10_000;
export const DAEMON_LOCK_TIMEOUT_MS = 5_000;
export const DAEMON_LOCK_STALE_MS = 60_000;

/**
 * Build the daemon endpoint URL for `daemon status`. Honors `ARIANNA_DAEMON_URL`
 * (same env var the bootstrap daemon-route uses, set by openclaw containers
 * to `http://host.docker.internal:9000`); when unset, auto-swaps to
 * `host.docker.internal:9000` if no local docker binary is detected (the
 * canonical "we're running inside a container" signal), otherwise defaults
 * to `127.0.0.1:9000` (the laptop dev flow).
 *
 * Validation aea28db5 caught the env-honoring half: `arianna daemon status`
 * from inside an openclaw container was hard-coding 127.0.0.1:9000 even when
 * the operator had exported `ARIANNA_DAEMON_URL=http://host.docker.internal:9000`.
 * Validation a09486c9 (Talin run, 2026-05-09) caught the second half: when
 * the env var was NOT set, status still reported "not running" inside the
 * container because loopback isn't the host. The auto-swap mirrors the
 * pattern compose-up.ts (DEFAULT_DAEMON_URL_FOR_CLI) and the vessel/sidecar
 * URL resolution use — env wins; without env, the container case picks
 * host.docker.internal automatically.
 *
 * The auto-swap is read-only: only `daemon status` (and other read-only
 * status probes) calls this. `daemon start` / `daemon stop` deliberately
 * bypass it because they spawn / signal a local process that only makes
 * sense on loopback.
 *
 * Trailing slashes are stripped — the callers append `/health` and `/version`
 * directly. Empty env values are treated as unset.
 */
export function resolveDaemonBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  dockerProbe?: () => void,
): string {
  const raw = env.ARIANNA_DAEMON_URL;
  if (typeof raw === "string" && raw.length > 0) {
    return raw.replace(/\/+$/, "");
  }
  // No env override. If there's no local docker binary, we're almost
  // certainly inside an openclaw-style dev container — loopback won't reach
  // the host's daemon. Mirror compose-up's DEFAULT_DAEMON_URL_FOR_CLI.
  if (!isLocalDockerAvailable(dockerProbe)) {
    return DEFAULT_DAEMON_URL_FOR_CLI.replace(/\/+$/, "");
  }
  return `http://${DAEMON_HOST}:${DAEMON_PORT}`;
}

export class DaemonCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonCommandError";
  }
}

export interface SpawnedDaemon {
  pid: number;
  unref: () => void;
}

export interface DaemonDeps extends PathOpts {
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /** Test seam — defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Environment for `ARIANNA_DAEMON_URL` resolution in `daemon status`.
   * Defaults to `process.env`. The `daemon start` and `daemon stop` paths
   * still target the local `127.0.0.1:9000` (they spawn / signal a process,
   * which only makes sense locally) — only `status` honors the URL override.
   */
  daemonEnv?: NodeJS.ProcessEnv;
  /**
   * Test seam — override the docker-binary detection probe used by
   * `resolveDaemonBaseUrl` for the auto-swap fallback. Production leaves this
   * undefined and the real `execSync('docker --version')` probe runs. Only
   * affects `daemon status` (the read-only path); start/stop don't auto-swap.
   */
  dockerProbe?: () => void;
  /**
   * Test seam — fork-and-detach the daemon process. Production wraps
   * Node's `child_process.spawn` with `detached: true, stdio: 'ignore'` and
   * unrefs the handle. Tests inject a function that returns a synthetic pid.
   */
  spawn?: (script: DaemonScript, logPath: string) => SpawnedDaemon;
  /**
   * Test seam — process.kill. Returns void on success, throws on failure
   * (mimics process.kill behaviour). Defaults to a wrapper around
   * `process.kill(pid, signal)` that swallows ESRCH.
   */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Test seam — current time. Defaults to Date.now. */
  now?: () => number;
  /** Test seam — sleep. Defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export type DaemonScript =
  | { kind: "compiled"; path: string }
  | { kind: "tsx"; path: string };

export async function runDaemon(args: DaemonArgs, deps: DaemonDeps): Promise<number> {
  switch (args.subcommand) {
    case "start":
      return cmdStart(deps);
    case "stop":
      return cmdStop(deps);
    case "status":
      return cmdStatus(deps);
  }
  // Exhaustiveness guard.
  const _exhaustive: never = args.subcommand;
  throw new DaemonCommandError(`Unhandled daemon subcommand: ${String(_exhaustive)}`);
}

async function cmdStart(deps: DaemonDeps): Promise<number> {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const ariannaHome = resolveAriannaHome(deps);
  mkdirSync(ariannaHome, { recursive: true });

  // The check-then-spawn sequence MUST be serialized: two concurrent
  // `arianna daemon start` invocations would both find /health down, both
  // spawn detached daemons, and the second one's listen(9000) would
  // EADDRINUSE — leaving the first daemon orphaned (not in pid file → not
  // reachable via `daemon stop`). Per the eng-review-locked decision the
  // daemon is single-tenant, so global serialization on a fast spawn path
  // is the right primitive.
  return await withDaemonLock(deps, async (): Promise<number> => {
    // Idempotent: if a daemon is already healthy on 9000, do nothing. We
    // check via /health instead of just "is the port bound" because a stale
    // TIME_WAIT socket or an unrelated process can squat on the port.
    const healthy = await checkHealth(fetcher);
    if (healthy.ok) {
      const existingPid = readPidFile(deps);
      deps.write(
        `daemon already running (${existingPid !== null ? `pid ${existingPid}` : "no pid file"}, ` +
          `${DAEMON_HOST}:${DAEMON_PORT}, healthy).\n`,
      );
      return 0;
    }

    // If the port is bound but /health doesn't answer, refuse to spawn — we
    // don't know what's listening.
    if (healthy.bound) {
      throw new DaemonCommandError(
        `Something is listening on ${DAEMON_HOST}:${DAEMON_PORT} but /health is not responding. ` +
          `Investigate before starting another daemon.`,
      );
    }

    // Resolve the daemon entry script. Production: dist/daemon.js if the
    // host package has been built; otherwise fall back to src/daemon.ts
    // under tsx.
    const script = resolveDaemonScript(deps);
    const logPath = join(ariannaHome, "daemon.log");

    const spawn = deps.spawn ?? defaultSpawn;
    const child = spawn(script, logPath);

    // Persist pid for `arianna daemon stop`. Atomic write via tmp + rename
    // so a concurrent `daemon stop` racing this one can't read a torn file.
    writePidFile(child.pid, deps);
    child.unref();

    // Wait for /health. If it doesn't come up, surface the log tail so
    // users can debug without hunting for the file. We don't kill the
    // process on timeout — it might still be coming up — but we do return
    // non-zero so callers (like a CI script) notice.
    const ready = await waitForHealth(fetcher, deps);
    if (!ready) {
      deps.warn?.(
        `warn: daemon did not respond to /health within ${DAEMON_HEALTH_TIMEOUT_MS}ms ` +
          `(pid ${child.pid}, log: ${logPath}). Check the log for errors.\n`,
      );
      return 1;
    }

    deps.write(
      `daemon started (pid ${child.pid}, ${DAEMON_HOST}:${DAEMON_PORT}, log: ${logPath}).\n`,
    );
    return 0;
  });
}

async function cmdStop(deps: DaemonDeps): Promise<number> {
  // Same lock as cmdStart so a concurrent start can't write a fresh pid
  // while we're tearing down the previous daemon (or vice versa). Without
  // this, `daemon stop` could SIGTERM the old pid and then `daemon start`
  // wipes our pid-file removal by writing a new one.
  return await withDaemonLock(deps, async (): Promise<number> => {
    const pid = readPidFile(deps);
    if (pid === null) {
      deps.write("daemon not running (no pid file).\n");
      return 0;
    }

    const kill = deps.kill ?? defaultKill;

    // Check the process is actually alive — otherwise the pid file is
    // stale, probably from an unclean shutdown.
    if (!isPidAlive(pid, kill)) {
      deps.write(`daemon not running (stale pid ${pid}; cleaning up pid file).\n`);
      removePidFile(deps);
      return 0;
    }

    try {
      kill(pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        deps.write(`daemon not running (pid ${pid} disappeared).\n`);
        removePidFile(deps);
        return 0;
      }
      throw new DaemonCommandError(
        `Failed to signal daemon (pid ${pid}): ${(err as Error).message}`,
      );
    }

    // Poll until the pid is gone or we hit the timeout. Don't escalate to
    // SIGKILL automatically — the daemon owns docker handles and a hard
    // kill could leave containers in awkward states.
    const sleep = deps.sleep ?? defaultSleep;
    const now = deps.now ?? Date.now;
    const start = now();
    while (now() - start < DAEMON_STOP_TIMEOUT_MS) {
      if (!isPidAlive(pid, kill)) {
        removePidFile(deps);
        deps.write(`daemon stopped (pid ${pid}).\n`);
        return 0;
      }
      await sleep(100);
    }

    deps.warn?.(
      `warn: daemon (pid ${pid}) did not exit within ${DAEMON_STOP_TIMEOUT_MS}ms after SIGTERM. ` +
        `Run \`kill -9 ${pid}\` if you need to force it.\n`,
    );
    return 1;
  });
}

async function cmdStatus(deps: DaemonDeps): Promise<number> {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const pid = readPidFile(deps);
  // Honor ARIANNA_DAEMON_URL so `arianna daemon status` works from inside an
  // openclaw container (validation aea28db5). When the env var is unset,
  // auto-swap to host.docker.internal if no local docker is detected
  // (validation a09486c9 — Talin run, 2026-05-09 — caught the second half:
  // status still reported "not running" inside the container without env).
  // The pid file is still local-only — when running inside a container
  // against a remote daemon there's no pid file to find, and that's fine:
  // /health is the source of truth.
  const baseUrl = resolveDaemonBaseUrl(
    deps.daemonEnv ?? process.env,
    deps.dockerProbe,
  );

  // /health is the source of truth. The pid file is informational.
  const health = await checkHealth(fetcher, baseUrl);

  if (pid !== null) {
    const kill = deps.kill ?? defaultKill;
    const alive = isPidAlive(pid, kill);
    deps.write(`pid:        ${pid}${alive ? "" : " (dead — stale pid file)"}\n`);
  } else {
    deps.write(`pid:        (no pid file)\n`);
  }
  deps.write(`endpoint:   ${baseUrl}\n`);
  deps.write(`port bound: ${health.bound ? "yes" : "no"}\n`);
  deps.write(`health:     ${health.ok ? "ok" : health.bound ? "bound but not ok" : "not running"}\n`);
  if (health.ok && health.body) {
    deps.write(`response:   ${health.body}\n`);
  }

  // Gap 13 (validation agent abf126be, 2026-05-09): a daemon predating the
  // current codebase reported "healthy" via /health, masking that it lacked
  // newer endpoints. Surface version + commit + uptime so operators can
  // detect staleness at a glance. Best-effort — older daemons that don't
  // expose /version are fine; we just print "(unavailable)" so the field is
  // visible in the dashboard.
  if (health.ok) {
    const version = await fetchDaemonVersion(fetcher, baseUrl);
    if (version === null) {
      deps.write(`version:    (unavailable — daemon predates GET /version, restart to refresh)\n`);
    } else {
      const commit = version.commit ? ` commit=${version.commit}` : "";
      const uptime = formatUptime(version.uptime_ms);
      deps.write(`version:    ${version.version}${commit} uptime=${uptime}\n`);
    }
  }

  return health.ok ? 0 : 1;
}

// Gap 13: GET /version returns { version, uptime_ms, commit? }. Returns null
// on any error (missing endpoint = pre-/version daemon → operator should
// restart to refresh).
async function fetchDaemonVersion(
  fetcher: typeof globalThis.fetch,
  baseUrl: string = `http://${DAEMON_HOST}:${DAEMON_PORT}`,
): Promise<{ version: string; uptime_ms: number; commit?: string } | null> {
  const url = `${baseUrl}/version`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3_000);
    let res: Response;
    try {
      res = await fetcher(url, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string; uptime_ms?: number; commit?: string };
    if (typeof body.version !== "string" || typeof body.uptime_ms !== "number") {
      return null;
    }
    return {
      version: body.version,
      uptime_ms: body.uptime_ms,
      commit: typeof body.commit === "string" && body.commit.length > 0 ? body.commit : undefined,
    };
  } catch {
    return null;
  }
}

// Gap 13 helper: render uptime as h/m/s for the status dashboard. Days+ get
// surfaced explicitly since the validation case (4h46m) showed even a few
// hours of staleness mattered.
function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

// Resolve the daemon script. We prefer the compiled JS if it exists since
// that's what production users get after `pnpm build`. The dev path falls
// back to the .ts source under tsx. Honors `opts.repoRoot` explicitly so
// tests don't accidentally inherit the real arianna repo root via the
// cwd-walking fallback in findRepoRoot.
export function resolveDaemonScript(opts: PathOpts = {}): DaemonScript {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts);
  if (!repoRoot) {
    throw new DaemonCommandError(
      "Could not find the arianna repo root. Run from inside an arianna checkout, " +
        "or install via the curl-pipeable installer.",
    );
  }
  const compiled = join(repoRoot, "packages", "host", "dist", "daemon.js");
  if (existsSync(compiled)) {
    return { kind: "compiled", path: compiled };
  }
  const tsxSrc = join(repoRoot, "packages", "host", "src", "daemon.ts");
  if (existsSync(tsxSrc)) {
    return { kind: "tsx", path: tsxSrc };
  }
  throw new DaemonCommandError(
    `Daemon script not found at ${compiled} or ${tsxSrc}. ` +
      `Run \`pnpm --filter @arianna/tui build\` to build the daemon first.`,
  );
}

function defaultSpawn(script: DaemonScript, logPath: string): SpawnedDaemon {
  // Open the log file for append. Both stdout/stderr go here so the user has
  // somewhere to look when /health doesn't respond.
  mkdirSync(dirname(logPath), { recursive: true });
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");

  // Detach so the daemon outlives the CLI process. We pass execArgv for the
  // tsx-loader case; the compiled JS case runs node directly.
  const execArgv: string[] = script.kind === "tsx" ? ["--import", "tsx/esm"] : [];

  const child = cpSpawn(process.execPath, [...execArgv, script.path], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });

  if (typeof child.pid !== "number") {
    throw new DaemonCommandError("Failed to spawn daemon (no pid returned).");
  }

  return {
    pid: child.pid,
    unref: () => child.unref(),
  };
}

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface HealthCheck {
  /** True if a TCP connection to DAEMON_PORT succeeded (or fetch returned). */
  bound: boolean;
  /** True if /health returned 2xx. */
  ok: boolean;
  /** Trimmed body, if any. */
  body?: string;
}

async function checkHealth(
  fetcher: typeof globalThis.fetch,
  baseUrl: string = `http://${DAEMON_HOST}:${DAEMON_PORT}`,
): Promise<HealthCheck> {
  const url = `${baseUrl}/health`;
  try {
    // 3s strikes the balance: long enough that a loaded host won't
    // misclassify a slow-but-healthy daemon as "not bound" (which would
    // trigger a duplicate spawn attempt), short enough that `daemon status`
    // still feels snappy when nothing's listening.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3_000);
    let res: Response;
    try {
      res = await fetcher(url, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    const body = (await res.text()).trim();
    return {
      bound: true,
      ok: res.ok,
      body: body.length > 0 ? body : undefined,
    };
  } catch {
    return { bound: false, ok: false };
  }
}

async function waitForHealth(
  fetcher: typeof globalThis.fetch,
  deps: DaemonDeps,
): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const start = now();
  while (now() - start < DAEMON_HEALTH_TIMEOUT_MS) {
    const h = await checkHealth(fetcher);
    if (h.ok) return true;
    await sleep(200);
  }
  return false;
}

function isPidAlive(pid: number, kill: (pid: number, signal: NodeJS.Signals | 0) => void): boolean {
  if (pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return true;
  }
}

export function daemonPidPath(opts: PathOpts = {}): string {
  return join(resolveAriannaHome(opts), "daemon.pid");
}

function readPidFile(deps: DaemonDeps): number | null {
  const path = daemonPidPath(deps);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  } catch {
    // Fall through to null — caller treats unreadable pid file as absent.
  }
  return null;
}

function writePidFile(pid: number, deps: DaemonDeps): void {
  const path = daemonPidPath(deps);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic via tmp + rename. The daemon stop path reads from this file — if a
  // concurrent `daemon start` interleaved a write, stop could read a torn pid.
  // Tmp+rename ensures readers always see one full pid value.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${pid}\n`);
  renameSync(tmp, path);
}

function removePidFile(deps: DaemonDeps): void {
  const path = daemonPidPath(deps);
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

export function daemonLockPath(opts: PathOpts = {}): string {
  return join(resolveAriannaHome(opts), "daemon.lock");
}

/**
 * Serialize daemon start/stop with an O_EXCL lockfile. Same primitive as the
 * port-allocator's `withPortLock` but scoped to a separate file so we don't
 * conflate "allocating ports" with "spawning the daemon" (different cadences;
 * port lock is per-profile-create, daemon lock is per-start/stop).
 *
 * Stale-lock cleanup mirrors the port allocator: if the lockfile is older than
 * 60s AND the recorded pid is dead, the lock is wiped and we retry. Without
 * this a crashed `arianna daemon start` would leave the lockfile behind and
 * brick all future invocations.
 */
async function withDaemonLock<T>(
  deps: DaemonDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = daemonLockPath(deps);
  mkdirSync(dirname(lockPath), { recursive: true });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const start = now();

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: now() }));
      } finally {
        closeSync(fd);
      }
      try {
        return await fn();
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          // Lock already gone (cleaned up by another process detecting
          // staleness). Nothing to do.
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      if (lockIsStale(lockPath, deps)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Race: another waiter unlinked it first. Retry the open.
        }
        continue;
      }

      if (now() - start > DAEMON_LOCK_TIMEOUT_MS) {
        throw new DaemonCommandError(
          `Could not acquire ${lockPath} within ${DAEMON_LOCK_TIMEOUT_MS}ms (held by another process).`,
        );
      }
      await sleep(50);
    }
  }
}

function lockIsStale(lockPath: string, deps: DaemonDeps): boolean {
  try {
    const stat = statSync(lockPath);
    // Use Date.now() (real wall-clock) here, NOT deps.now. The `mtimeMs`
    // returned by stat is wall-clock time; mixing it with a mocked monotonic
    // `now()` produces nonsense (an injected `now=()=>0` would treat every
    // lockfile as fresh because `0 - 1.7e12` is hugely negative).
    if (Date.now() - stat.mtimeMs <= DAEMON_LOCK_STALE_MS) return false;

    // Beyond the staleness threshold — but only declare stale if the
    // recorded pid is actually dead. A legitimately slow lock-holder
    // (heavy-loaded machine) shouldn't have its lock stolen.
    let lockedPid: number | null = null;
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const parsed = JSON.parse(raw) as { pid?: number };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
        lockedPid = parsed.pid;
      }
    } catch {
      return true;
    }
    if (lockedPid === null) return true;
    const kill = deps.kill ?? defaultKill;
    return !isPidAlive(lockedPid, kill);
  } catch {
    return false;
  }
}

export const _internal = {
  checkHealth,
  isPidAlive,
  readPidFile,
  writePidFile,
  daemonPidPath,
  withDaemonLock,
  lockIsStale,
};

export type { DaemonSubcommand };
