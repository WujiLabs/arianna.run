// Pure profile-context resolver for the daemon. Maps an inbound request
// (query string + headers) to the workspace paths, container/compose
// identifiers, and downstream URLs the endpoint handler should use.
//
// Eng-review-locked rules (#37):
//   - --profile / X-Arianna-Profile / ?profile= validate the same name regex
//     used everywhere else in the codebase.
//   - Missing param: during the sprint window we fall back to the configured
//     default profile, then to the literal "default" (legacy single-tenant).
//     Sentinel `workspace/profiles/default/.no-default-allowed` blocks the
//     fallback and forces an explicit profile.
//   - Unknown name (valid format, not in ~/.arianna/config) → 404, EXCEPT
//     name === "default" which is the backward-compat shorthand for the
//     legacy single-tenant flow. That case maps to the legacy paths
//     (workspace/session_config.json, workspace/snapshots/, etc.).
//   - Named profile in config → profile-aware paths
//     (workspace/profiles/<name>/...) and shifted host ports.
//
// The function is pure: takes inputs, returns either a ProfileContext or a
// DaemonProfileError. The HTTP handler renders the error to the right status
// code; the function never decides about response shape.

import { join } from "node:path";
import { existsSync } from "node:fs";

import { loadConfig } from "@arianna.run/cli/arianna-config";
import { isValidProfileName } from "@arianna.run/cli/profile";
import {
  noDefaultAllowedSentinelPath,
  profileDir,
  profileOverridePath,
  type PathOpts,
} from "@arianna.run/cli/paths";

export const VESSEL_PORT_BASE = 3000;
export const SIDECAR_PORT_BASE = 8000;
export const LEGACY_CONTAINER_NAME = "arianna-vessel";

export type DaemonProfileErrorCode =
  | "invalid-profile-name"
  | "missing-profile"
  | "implicit-default-blocked"
  | "unknown-profile";

export interface DaemonProfileError {
  code: DaemonProfileErrorCode;
  message: string;
  /** Suggested HTTP status — handler may choose to override. */
  status: 400 | 404;
}

export interface ProfileContext {
  /** Resolved profile name. "default" when in legacy fallback mode. */
  name: string;
  /**
   * True when the resolved profile is the literal "default" AND has no entry
   * in ~/.arianna/config. The daemon uses legacy paths and the unprofiled
   * compose project for these requests, preserving the existing
   * single-tenant TUI flow.
   */
  isLegacy: boolean;
  /** Where this resolution came from. */
  source: "query" | "header" | "config-default" | "implicit-default";
  containerName: string;
  /** Compose project name (`-p arianna-{name}`), or null for legacy. */
  composeProject: string | null;
  /** Path to the per-profile compose.override.yml, or null for legacy. */
  composeOverride: string | null;
  /** Port offset from ~/.arianna/config, or 0 for legacy/unconfigured. */
  portOffset: number;
  vesselUrl: string;
  sidecarUrl: string;
  sessionConfigPath: string;
  snapshotsDir: string;
  sidecarStateDir: string;
}

export interface DaemonProfileOpts extends PathOpts {
  /** Default true. When false, missing-profile returns 400 with no fallback. */
  allowImplicitDefault?: boolean;
  /** Test seam — defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface RequestProfileInput {
  /** Raw `?profile=` query string value, or null if absent. */
  query: string | null;
  /** Raw `x-arianna-profile` header value, or null if absent. */
  header: string | null;
}

/**
 * Resolve the profile context for a daemon request. Returns either a
 * ProfileContext or a DaemonProfileError; the caller renders the error.
 *
 * Validation order:
 *   1. If query and header both present and differ → 400 (caller chooses one).
 *   2. If neither present:
 *      a. allowImplicitDefault === false → 400.
 *      b. Otherwise consult `~/.arianna/config` default; if no default,
 *         fall through to the literal "default".
 *      c. Sentinel `workspace/profiles/default/.no-default-allowed` blocks
 *         the implicit "default" fallback (NOT the config-default — a
 *         user-named profile is fine).
 *   3. Validate name against the regex.
 *   4. Look up the entry in `~/.arianna/config`:
 *      - found → profile-aware context (port offset shift, profile dirs)
 *      - missing AND name === "default" → legacy context
 *      - missing AND name !== "default" → 404 unknown-profile
 */
export function resolveProfileContext(
  input: RequestProfileInput,
  opts: DaemonProfileOpts = {},
): ProfileContext | DaemonProfileError {
  const allowImplicitDefault = opts.allowImplicitDefault ?? true;

  let raw: string | null = null;
  let source: ProfileContext["source"] = "query";

  if (input.query && input.header && input.query !== input.header) {
    return {
      code: "invalid-profile-name",
      message:
        "Conflicting profile values: ?profile= and X-Arianna-Profile must agree.",
      status: 400,
    };
  }
  if (input.query) {
    raw = input.query;
    source = "query";
  } else if (input.header) {
    raw = input.header;
    source = "header";
  }

  if (raw === null) {
    if (!allowImplicitDefault) {
      return {
        code: "missing-profile",
        message:
          "Missing profile: pass ?profile=<name> or set the X-Arianna-Profile header.",
        status: 400,
      };
    }
    const cfg = safeLoadConfig(opts);
    if (cfg.defaultProfile) {
      raw = cfg.defaultProfile;
      source = "config-default";
    } else {
      // Sentinel only blocks the literal "default" fallback. A named
      // config-default is a deliberate choice the developer made.
      if (sentinelExists(opts)) {
        return {
          code: "implicit-default-blocked",
          message:
            `Implicit default blocked by ${noDefaultAllowedSentinelPath(opts)}. ` +
            `Pass ?profile=<name> or X-Arianna-Profile to choose explicitly.`,
          status: 400,
        };
      }
      raw = "default";
      source = "implicit-default";
    }
  }

  if (!isValidProfileName(raw)) {
    return {
      code: "invalid-profile-name",
      message: `Invalid profile name: "${raw}". Must match ^[a-z][a-z0-9-]{0,30}$.`,
      status: 400,
    };
  }

  const cfg = safeLoadConfig(opts);
  const entry = cfg.profiles.get(raw);

  if (!entry) {
    if (raw === "default") {
      // Backward-compat: legacy single-tenant flow.
      return legacyContext(opts, source);
    }
    return {
      code: "unknown-profile",
      message: `Unknown profile "${raw}": not in ~/.arianna/config. Run \`arianna profile create ${raw}\` first.`,
      status: 404,
    };
  }

  return profileAwareContext(raw, entry.portOffset, source, opts);
}

function legacyContext(
  opts: PathOpts,
  source: ProfileContext["source"],
): ProfileContext {
  const repoRoot = mustResolveRepoRoot(opts);
  return {
    name: "default",
    isLegacy: true,
    source,
    containerName: LEGACY_CONTAINER_NAME,
    composeProject: null,
    composeOverride: null,
    portOffset: 0,
    vesselUrl: `http://127.0.0.1:${VESSEL_PORT_BASE}`,
    sidecarUrl: `http://127.0.0.1:${SIDECAR_PORT_BASE}`,
    sessionConfigPath: join(repoRoot, "workspace", "session_config.json"),
    snapshotsDir: join(repoRoot, "workspace", "snapshots"),
    sidecarStateDir: join(repoRoot, "workspace", "sidecar-state"),
  };
}

function profileAwareContext(
  name: string,
  portOffset: number,
  source: ProfileContext["source"],
  opts: PathOpts,
): ProfileContext {
  const dir = profileDir(name, opts);
  return {
    name,
    isLegacy: false,
    source,
    containerName: `arianna-vessel-${name}`,
    composeProject: `arianna-${name}`,
    composeOverride: profileOverridePath(name, opts),
    portOffset,
    vesselUrl: `http://127.0.0.1:${VESSEL_PORT_BASE + portOffset}`,
    sidecarUrl: `http://127.0.0.1:${SIDECAR_PORT_BASE + portOffset}`,
    sessionConfigPath: join(dir, "session_config.json"),
    snapshotsDir: join(dir, "snapshots"),
    sidecarStateDir: join(dir, "sidecar-state"),
  };
}

function safeLoadConfig(opts: PathOpts): ReturnType<typeof loadConfig> {
  try {
    return loadConfig(opts);
  } catch {
    return { defaultProfile: null, profiles: new Map() };
  }
}

function sentinelExists(opts: PathOpts): boolean {
  try {
    return existsSync(noDefaultAllowedSentinelPath(opts));
  } catch {
    return false;
  }
}

// resolveRepoRoot would walk up from cwd; for the daemon we always pass
// repoRoot explicitly via opts. If callers ever forget, fail loud.
function mustResolveRepoRoot(opts: PathOpts): string {
  if (!opts.repoRoot) {
    throw new Error(
      "daemon-profile: repoRoot must be supplied (daemon resolves it from __dirname).",
    );
  }
  return opts.repoRoot;
}

/**
 * Build the `docker compose ...` argument prefix for a profile context.
 * Returns a string suitable for shell interpolation.
 *
 * Examples:
 *   legacy   → "docker compose"
 *   alpha    → "docker compose -p arianna-alpha -f docker-compose.yml -f workspace/profiles/alpha/compose.override.yml"
 */
export function composeBaseCommand(ctx: ProfileContext, repoRoot: string): string {
  if (ctx.isLegacy) return "docker compose";
  // Use forward slashes; docker compose accepts them on macOS and Linux.
  // Keep paths repo-relative so the command is shorter and cwd-stable.
  const overrideRel = ctx.composeOverride
    ? ctx.composeOverride.startsWith(repoRoot + "/")
      ? ctx.composeOverride.slice(repoRoot.length + 1)
      : ctx.composeOverride
    : null;
  const parts = ["docker", "compose", "-p", ctx.composeProject!, "-f", "docker-compose.yml"];
  if (overrideRel) parts.push("-f", overrideRel);
  return parts.join(" ");
}
