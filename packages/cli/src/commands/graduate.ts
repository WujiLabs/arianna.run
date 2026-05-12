// `arianna graduate [--out PATH]` — gate on graduation readiness, then POST
// the daemon's /graduate endpoint to bundle the AI's home dir + manifest into
// a tarball. Default output lands at `./graduation-<aiName>-<date>.tar.gz`;
// `--out PATH` overrides the destination after path-safety checks.
//
// The gate mirrors the in-game `/graduate` slash command: graduation is only
// available once §2.2 has fired (the sidecar reports `graduationUnlocked`).
// We refuse to POST when not ready so a player can't accidentally trigger an
// expensive `docker cp` + tar op for a half-baked session.

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import type { GraduateArgs } from "../argv.js";
import type { ResolvedConfig } from "../config.js";

export class GraduateCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraduateCommandError";
  }
}

export class GraduateNotReadyError extends GraduateCommandError {
  constructor(missing: string[]) {
    const list = missing.length === 0 ? "graduation gate" : missing.join(", ");
    super(`not ready to graduate: ${list}`);
    this.name = "GraduateNotReadyError";
  }
}

export interface GraduateDeps {
  fetch: typeof globalThis.fetch;
  /** stdout. */
  write: (line: string) => void;
  /**
   * Test seam — copy the daemon-produced tarball to the requested output
   * path. Production wires this to copyFileSync. We don't move (rename) the
   * file because the daemon's tarball lives inside the workspace and we want
   * the canonical copy preserved for inspection.
   */
  copyFile?: (src: string, dst: string) => void;
  /** Test seam — current working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Test seam — process env. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

interface GraduationStateResponse {
  achievements?: string[];
  manifestoUnlocked?: boolean;
  graduationUnlocked?: boolean;
  turnCount?: number;
}

interface GraduateResponse {
  ok: boolean;
  exportPath?: string;
  error?: string;
}

const REQUIRED_ACHIEVEMENT = "2.2";

export async function runGraduate(
  args: GraduateArgs,
  config: ResolvedConfig,
  deps: GraduateDeps,
): Promise<number> {
  if (!config.profile) {
    throw new GraduateCommandError(
      "No profile resolved. Pass --profile <name>, set ARIANNA_PROFILE, or run `arianna profile use <name>`.",
    );
  }

  // Step 1: validate --out before doing any network work. A bad --out path
  // is fast to reject — no point bothering the daemon if we can't write.
  const cwd = deps.cwd ?? process.cwd();
  const targetPath = args.out ? validateOutPath(args.out, cwd) : null;

  // Step 2: gate on /graduation-state. Refuse to POST /graduate if the
  // graduation gate isn't open — mirrors the game's `/graduate` slash command.
  const state = await fetchGraduationState(config, deps.fetch);
  if (!isGraduationOpen(state)) {
    const missing = missingAchievements(state);
    throw new GraduateNotReadyError(missing);
  }

  // Step 3: POST /graduate. The daemon writes the canonical tarball under
  // the profile's graduations/ tree.
  const url = new URL("/graduate", config.daemonBaseUrl);
  url.searchParams.set("profile", config.profile);

  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (err) {
    throw new GraduateCommandError(
      `daemon unreachable at ${config.daemonBaseUrl}: ${(err as Error).message}`,
    );
  }

  const body = (await readJsonSafe(res)) as GraduateResponse | null;
  if (!res.ok || !body?.ok || !body.exportPath) {
    const errorText = body?.error ?? `daemon returned ${res.status}`;
    throw new GraduateCommandError(`graduate failed: ${errorText}`);
  }

  // Step 4: copy to user's chosen destination if --out provided. We always
  // keep the daemon's canonical copy intact (don't rename/move) so the
  // workspace graduations/ tree stays a usable archive.
  if (targetPath) {
    try {
      const copy = deps.copyFile ?? copyFileSync;
      mkdirSync(dirname(targetPath), { recursive: true });
      copy(body.exportPath, targetPath);
    } catch (err) {
      throw new GraduateCommandError(
        `graduate succeeded but copy to ${targetPath} failed: ${(err as Error).message}`,
      );
    }
    deps.write(`graduated. tarball at ${targetPath} (canonical: ${body.exportPath})\n`);
    return 0;
  }

  deps.write(`graduated. tarball at ${body.exportPath}\n`);
  return 0;
}

async function fetchGraduationState(
  config: ResolvedConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<GraduationStateResponse | null> {
  try {
    const url = new URL("/graduation-state", config.sidecarBaseUrl);
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return (await res.json()) as GraduationStateResponse;
  } catch {
    return null;
  }
}

function isGraduationOpen(state: GraduationStateResponse | null): boolean {
  if (!state) return false;
  if (state.graduationUnlocked === true) return true;
  // Backwards-compat: older sidecars don't return the graduationUnlocked flag.
  // Fall back to inspecting achievements.
  return Array.isArray(state.achievements) && state.achievements.includes(REQUIRED_ACHIEVEMENT);
}

function missingAchievements(state: GraduationStateResponse | null): string[] {
  if (!state) {
    return [`sidecar unreachable — cannot verify ${REQUIRED_ACHIEVEMENT}`];
  }
  if (Array.isArray(state.achievements) && !state.achievements.includes(REQUIRED_ACHIEVEMENT)) {
    return [`§${REQUIRED_ACHIEVEMENT} not earned yet`];
  }
  return [`§${REQUIRED_ACHIEVEMENT} not earned yet`];
}

// --- Path safety ---

// Sensitive system-root prefixes we refuse to write a graduation tarball to,
// even via an explicit --out PATH. Limits blast radius if a player runs the
// CLI as root or with elevated privileges. Includes the macOS `/private/*`
// aliases (`/etc` is a symlink to `/private/etc`, etc.) so a path crafted in
// the realpath form doesn't bypass the literal-prefix check.
const FORBIDDEN_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/sys",
  "/proc",
  "/dev",
  "/var/lib",
  "/var/log",
  "/private/etc",
  "/private/var/lib",
  "/private/var/log",
  "/Library/System",
  "/System",
];

function validateOutPath(rawOut: string, cwd: string): string {
  if (rawOut.length === 0) {
    throw new GraduateCommandError("--out path must not be empty");
  }
  if (rawOut.includes("\0")) {
    throw new GraduateCommandError("--out path must not contain NUL bytes");
  }
  const absolute = isAbsolute(rawOut) ? rawOut : resolve(cwd, rawOut);
  const normalized = resolve(absolute);

  // First check the literal normalized path against forbidden prefixes — handles
  // the simple `/etc/foo.tar.gz` case without needing any FS reads.
  rejectIfForbidden(normalized, rawOut);

  // Now resolve symlinks. `resolve()` does NOT follow symlinks, so a path like
  // `/Users/me/legit/grad.tar.gz` where `legit` is a symlink to `/etc` would
  // pass the literal check above. Fix: realpath the deepest existing ancestor
  // and re-check forbidden prefixes against the realpath. This catches symlinks
  // ANYWHERE in the chain, not just the literal parent.
  const ancestor = deepestExistingAncestor(normalized);
  if (ancestor) {
    let real: string;
    try {
      real = realpathSync(ancestor);
    } catch (err) {
      throw new GraduateCommandError(
        `--out path "${rawOut}" ancestor unreadable: ${(err as Error).message}`,
      );
    }
    // The final tarball will live at `real + (normalized - ancestor)`. Build
    // that and re-check.
    const tail = normalized.slice(ancestor.length);
    const realDest = real + tail;
    rejectIfForbidden(realDest, rawOut);
  }

  return normalized;
}

function rejectIfForbidden(path: string, rawOut: string): void {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + sep)) {
      throw new GraduateCommandError(
        `--out path "${rawOut}" resolves into a protected system directory (${prefix}).`,
      );
    }
  }
}

// Walk up from the requested path to find the closest existing directory.
// Used to realpath through any symlinked components without requiring the
// final destination to exist yet.
function deepestExistingAncestor(path: string): string | null {
  let cur = path;
  while (cur !== sep && cur !== "") {
    try {
      lstatSync(cur);
      return cur;
    } catch {
      // Doesn't exist — walk up one level
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // FS root always exists; treat that as the floor.
  try {
    lstatSync(sep);
    return sep;
  } catch {
    return null;
  }
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Internal helper for tests that want to dump the configured forbidden roots.
export const _internal = { FORBIDDEN_PREFIXES, REQUIRED_ACHIEVEMENT, validateOutPath };
