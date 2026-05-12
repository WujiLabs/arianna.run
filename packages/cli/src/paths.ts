import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, parse, resolve } from "node:path";

export interface PathOpts {
  /** Override $HOME for tests. */
  homeDir?: string;
  /** Override `ARIANNA_HOME` env. Final priority is opts > env > $HOME/.arianna. */
  ariannaHome?: string;
  /** Override REPO_ROOT discovery for tests. */
  repoRoot?: string;
  /** Working directory used for repo discovery. Defaults to process.cwd(). */
  cwd?: string;
  /** Test seam — defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve `~/.arianna/`. This is global per-machine state — the AWS-CLI-style
 * config file and the ports.lock live here. Independent of any specific
 * worktree or repo.
 */
export function resolveAriannaHome(opts: PathOpts = {}): string {
  if (opts.ariannaHome) return opts.ariannaHome;
  const env = opts.env ?? process.env;
  if (env.ARIANNA_HOME) return env.ARIANNA_HOME;
  return join(opts.homeDir ?? homedir(), ".arianna");
}

export function ariannaConfigPath(opts: PathOpts = {}): string {
  return join(resolveAriannaHome(opts), "config");
}

export function portsLockPath(opts: PathOpts = {}): string {
  return join(resolveAriannaHome(opts), "ports.lock");
}

/**
 * Walk up from cwd looking for `docker-compose.yml` (the marker we use for the
 * arianna repo root). Throws if not found — callers that need a softer signal
 * should use `findRepoRoot`.
 */
export function resolveRepoRoot(opts: PathOpts = {}): string {
  if (opts.repoRoot) return opts.repoRoot;
  const found = findRepoRoot(opts);
  if (!found) {
    throw new Error(
      "Not inside an arianna repo: no docker-compose.yml found in cwd or parents.",
    );
  }
  return found;
}

/**
 * Heuristic: does `dir` look like an arianna repo root rather than just any
 * docker-compose.yml-bearing directory? An arianna repo always ships the
 * monorepo layout `packages/cli/` AND `packages/types/` (and `packages/host/`)
 * alongside `docker-compose.yml`. A bare `docker-compose.yml` in someone
 * else's project (e.g. openclaw bind-mounting its own source at
 * `/workspace/openclaw/`) won't have those — so we use them as the
 * positive-confirmation marker that cwd-walk has actually landed inside arianna
 * rather than a co-tenant project. Gap 11 fix: validation agent abf126be hit
 * this when running `arianna profile create` inside an openclaw container that
 * had its own compose file at the cwd.
 */
function looksLikeAriannaRepo(dir: string): boolean {
  return (
    existsSync(join(dir, "docker-compose.yml")) &&
    existsSync(join(dir, "packages", "cli")) &&
    existsSync(join(dir, "packages", "types"))
  );
}

export function findRepoRoot(opts: PathOpts = {}): string | null {
  // 1. ARIANNA_REPO_ROOT env override. Wins over cwd-walking so an agent
  //    driving the CLI from a sibling checkout (git worktree, alternate
  //    clone) can pin path resolution to the same repo the daemon serves.
  //    Without this, cwd-walking finds the worktree's own
  //    `docker-compose.yml` and resolves `workspace/profiles/<name>/...`
  //    against it — which doesn't contain the profile state. Only honoured
  //    when the named dir actually has `docker-compose.yml`; bogus values
  //    fall through to the cwd-walk so a stale env var can't break
  //    resolution silently.
  const env = opts.env ?? process.env;
  if (env.ARIANNA_REPO_ROOT) {
    const envRoot = resolve(env.ARIANNA_REPO_ROOT);
    if (existsSync(join(envRoot, "docker-compose.yml"))) return envRoot;
  }

  // 2. Walk up from cwd, looking first for an arianna-shaped directory
  //    (docker-compose.yml + packages/cli + packages/types). This guards
  //    against cwd-walk false positives when arianna is invoked from inside
  //    a co-tenant project (e.g. openclaw, which bind-mounts its own
  //    docker-compose.yml at /workspace/openclaw/). Without the shape check
  //    we'd adopt the co-tenant repo and write `workspace/profiles/<name>/`
  //    into it where the host daemon can never find the state. We do a
  //    second pass with the bare `docker-compose.yml` check as a fallback so
  //    stripped-down arianna checkouts (e.g. a future single-package tarball
  //    that lacks the monorepo layout) still resolve.
  const start = resolve(opts.cwd ?? process.cwd());
  const fsRoot = parse(start).root;

  // Pass 1: prefer arianna-shaped roots.
  for (let dir = start; ; ) {
    if (looksLikeAriannaRepo(dir)) return dir;
    if (dir === fsRoot) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  // Pass 2: any docker-compose.yml. This is the legacy behaviour and stays
  //    as a fallback for non-monorepo arianna deployments.
  for (let dir = start; ; ) {
    if (existsSync(join(dir, "docker-compose.yml"))) return dir;
    if (dir === fsRoot) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  // 3. Fall back to the canonical install location (`install.sh` clones the
  //    repo to `~/.arianna/repo/` per #39). Lets globally-installed
  //    `arianna-tui` and `arianna ...` work from any cwd.
  const fallback = join(resolveAriannaHome(opts), "repo");
  if (existsSync(join(fallback, "docker-compose.yml"))) return fallback;
  return null;
}

export function profilesDir(opts: PathOpts = {}): string {
  return join(resolveRepoRoot(opts), "workspace", "profiles");
}

export function profileDir(name: string, opts: PathOpts = {}): string {
  return join(profilesDir(opts), name);
}

export function profileOverridePath(name: string, opts: PathOpts = {}): string {
  return join(profileDir(name, opts), "compose.override.yml");
}

/**
 * Sentinel: when present, blocks implicit-default resolution. Used in dev
 * worktrees where a misnamed default profile would clash with the developer's
 * own play sessions. Path is `workspace/profiles/default/.no-default-allowed`.
 */
export function noDefaultAllowedSentinelPath(opts: PathOpts = {}): string {
  return join(profileDir("default", opts), ".no-default-allowed");
}

/**
 * Per-profile disk paths matched to the daemon's `ProfileContext` semantics.
 * Legacy single-tenant flow (the literal "default" without a config entry)
 * lives directly under `workspace/`; named profiles live under
 * `workspace/profiles/<name>/`. Returning both in one call keeps callers
 * (status, manifesto, map) from re-deriving the same logic.
 */
export interface ProfileDiskPaths {
  sessionConfigPath: string;
  snapshotsDir: string;
}

export function profileDiskPaths(
  profileName: string,
  isLegacy: boolean,
  opts: PathOpts = {},
): ProfileDiskPaths {
  const repoRoot = resolveRepoRoot(opts);
  if (isLegacy) {
    return {
      sessionConfigPath: join(repoRoot, "workspace", "session_config.json"),
      snapshotsDir: join(repoRoot, "workspace", "snapshots"),
    };
  }
  const dir = profileDir(profileName, opts);
  return {
    sessionConfigPath: join(dir, "session_config.json"),
    snapshotsDir: join(dir, "snapshots"),
  };
}

/**
 * Per-profile session_config.json. Mirrors the file the TUI lobby writes for
 * a fresh play session and that `arianna profile import` writes when seeding a
 * profile from an existing JSONL session.
 */
export function profileSessionConfigPath(name: string, opts: PathOpts = {}): string {
  return join(profileDir(name, opts), "session_config.json");
}

/**
 * Per-profile imported-messages.jsonl. Written by `arianna profile import`,
 * read by `arianna talk`'s auto-bootstrap step and `arianna bootstrap`.
 */
export function profileImportedMessagesPath(name: string, opts: PathOpts = {}): string {
  return join(profileDir(name, opts), "imported-messages.jsonl");
}

/** Legacy single-tenant equivalents (used when no named profile is resolved). */
export function legacySessionConfigPath(opts: PathOpts = {}): string {
  return join(resolveRepoRoot(opts), "workspace", "session_config.json");
}

export function legacyImportedMessagesPath(opts: PathOpts = {}): string {
  return join(resolveRepoRoot(opts), "workspace", "imported-messages.jsonl");
}

/**
 * Per-profile event cursor — tracks what unlocks the local CLI client has
 * already shown to the agent across `arianna status` (and future) calls.
 * Lets each command surface "what changed since you last checked" without
 * needing the agent to keep an SSE feed open.
 *
 * Named profiles store under `workspace/profiles/<name>/event-cursor.json`
 * alongside the rest of the profile's disk state. Legacy single-tenant flow
 * uses `workspace/.event-cursor-default.json` (dotfile so it doesn't clutter
 * the visible workspace listing). Mirrors the legacy/named split used by
 * `profileDiskPaths`.
 */
export function eventCursorPath(
  profileName: string,
  isLegacy: boolean,
  opts: PathOpts = {},
): string {
  const repoRoot = resolveRepoRoot(opts);
  if (isLegacy) {
    return join(repoRoot, "workspace", ".event-cursor-default.json");
  }
  return join(profileDir(profileName, opts), "event-cursor.json");
}
