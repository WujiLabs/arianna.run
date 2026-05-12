import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:net";

import {
  portsLockPath,
  profileOverridePath,
  profilesDir,
  type PathOpts,
} from "./paths.js";

export const VESSEL_PORT_BASE = 3000;
export const SIDECAR_PORT_BASE = 8000;
export const DAEMON_PORT_BASE = 9000;
export const MAX_OFFSET = 99;
export const STALE_LOCK_MS = 60_000;

export interface AllocateOpts extends PathOpts {
  /** Don't bind-test; only check the in-repo overrides. Test seam. */
  skipBindTest?: boolean;
  /** Fail closed if the lock can't be acquired within this many ms. Default 5000. */
  acquireTimeoutMs?: number;
  /** Test seam — supply a fake port-availability check. */
  isPortFree?: (port: number) => Promise<boolean>;
}

export class PortAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortAllocationError";
  }
}

/**
 * Run `fn` while holding `~/.arianna/ports.lock`. Implements an O_EXCL
 * lockfile with stale-lock cleanup at 60s. This is "POSIX advisory locking"
 * in the practical sense — sufficient for single-machine multi-process
 * coordination, which is the only environment the daemon binds to.
 */
export async function withPortLock<T>(
  fn: () => Promise<T>,
  opts: AllocateOpts = {},
): Promise<T> {
  const lockPath = portsLockPath(opts);
  const timeoutMs = opts.acquireTimeoutMs ?? 5000;
  mkdirSync(dirname(lockPath), { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        closeSync(fd);
      }

      try {
        return await fn();
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          // Lock already gone (cleaned up by another process detecting our
          // staleness). Nothing to do.
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Lock exists. If it's stale, wipe it and retry.
      if (lockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Race: another waiter unlinked it first. Retry the open.
        }
        continue;
      }

      if (Date.now() - start > timeoutMs) {
        throw new PortAllocationError(
          `Could not acquire ${lockPath} within ${timeoutMs}ms (held by another process).`,
        );
      }
      // Backoff: 50ms, fixed. Don't bother exponential — the lock holder is
      // doing one bind-test + a few file writes, which finishes fast.
      await sleep(50);
    }
  }
}

function lockIsStale(lockPath: string): boolean {
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return false;

    // Mtime exceeds the threshold. Before declaring the lock stale, check
    // whether the PID that wrote it is still alive — protects a legitimate
    // long-running lock-holder (e.g. a slow filesystem) from having its lock
    // stolen out from under it. If the PID is dead (or unreadable), proceed
    // with stale cleanup.
    let lockedPid: number | null = null;
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const parsed = JSON.parse(raw) as { pid?: number };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
        lockedPid = parsed.pid;
      }
    } catch {
      // Unreadable lockfile after this many seconds → treat as stale.
      return true;
    }

    if (lockedPid === null) return true;
    return !pidIsAlive(lockedPid);
  } catch {
    return false;
  }
}

// `kill(pid, 0)` returns success if the process is alive (or success-with-
// EPERM if it exists but we don't have permission to signal it). ESRCH means
// no such process. Any other error → assume alive (be conservative; only
// declare dead when we have solid evidence).
function pidIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pick the lowest free offset in [0..99]. "Free" means:
 *   - No `workspace/profiles/*` declares it (we read existing
 *     compose.override.yml files to harvest taken offsets).
 *   - bind-test on 127.0.0.1:{3000+offset} succeeds (catches conflicts with
 *     other tenants on the host).
 *
 * Caller must already hold the ports lock (see allocateOffset). This split
 * lets `arianna profile list` show the in-repo offsets without racing for the
 * lock just to read.
 */
export function readTakenOffsets(opts: PathOpts = {}): Set<number> {
  const taken = new Set<number>();
  const root = profilesDir(opts);
  if (!existsSync(root)) return taken;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const overridePath = profileOverridePath(entry.name, opts);
    if (!existsSync(overridePath)) continue;
    const offset = readOffsetFromOverride(overridePath);
    if (offset !== null) taken.add(offset);
  }
  return taken;
}

// Pulls the vessel host port out of a compose.override.yml. We don't need a
// full YAML parser — every override we generate has a deterministic shape, so
// a focused regex is enough. Bad/missing overrides return null and are simply
// skipped (the bind-test catches collisions with anything we missed).
const OFFSET_PORT_RE = /127\.0\.0\.1:(\d{4,5}):3000/;
function readOffsetFromOverride(path: string): number | null {
  try {
    const text = readFileSync(path, "utf-8");
    const m = OFFSET_PORT_RE.exec(text);
    if (!m) return null;
    const port = Number(m[1]);
    const offset = port - VESSEL_PORT_BASE;
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) return null;
    return offset;
  } catch {
    return null;
  }
}

/**
 * Allocate a fresh offset. Must be wrapped in `withPortLock` by the caller.
 *
 * Strategy: scan in-repo overrides → lowest unused offset → bind-test all
 * three host-facing ports (3000+/8000+/9000+) to be sure nothing else on the
 * machine is squatting on them. If a candidate fails, retry with the next.
 */
export async function allocateOffset(opts: AllocateOpts = {}): Promise<number> {
  const taken = readTakenOffsets(opts);
  const isFree = opts.isPortFree ?? defaultPortFree;

  for (let offset = 0; offset <= MAX_OFFSET; offset++) {
    if (taken.has(offset)) continue;
    if (opts.skipBindTest) return offset;
    if (
      (await isFree(VESSEL_PORT_BASE + offset)) &&
      (await isFree(SIDECAR_PORT_BASE + offset)) &&
      (await isFree(DAEMON_PORT_BASE + offset))
    ) {
      return offset;
    }
  }

  throw new PortAllocationError(
    `No free port offset available in [0..${MAX_OFFSET}].`,
  );
}

/**
 * Convenience: acquire the lock, scan, allocate, and return the offset. Most
 * callers just want this — the split exists for tests and for `profile list`.
 */
export async function allocateOffsetLocked(opts: AllocateOpts = {}): Promise<number> {
  return withPortLock(() => allocateOffset(opts), opts);
}

// Tries to bind on 127.0.0.1:port. Releases immediately. Loopback only
// because the daemon (and per the locked decisions, all profile traffic)
// binds to loopback only.
function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export const _internal = { defaultPortFree, lockIsStale };
