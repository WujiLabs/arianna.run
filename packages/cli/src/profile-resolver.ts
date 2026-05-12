import { existsSync } from "node:fs";

import {
  noDefaultAllowedSentinelPath,
  type PathOpts,
} from "./paths.js";
import { loadConfig } from "./arianna-config.js";
import { assertValidProfileName } from "./profile.js";

export type ProfileSource = "flag" | "env" | "config-default" | "implicit-default" | "none";

export interface ResolveProfileOpts extends PathOpts {
  /** From `--profile <name>`. Already validated upstream by the argv parser. */
  flag?: string;
  /** Test seam — defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * If true, fall back to the literal name "default" when neither flag, env,
   * nor config-default is set. Used during the sprint for backwards
   * compatibility with the existing single-tenant TUI flow per eng-review D4
   * ("during sprint, missing-profile may fall back to default for backward
   * compat with the existing TUI"). The dev-workspace sentinel
   * `workspace/profiles/default/.no-default-allowed` blocks this.
   */
  allowImplicitDefault?: boolean;
}

export interface ResolvedProfile {
  /** Profile name, or null if not resolved (e.g. allowImplicitDefault=false and nothing set). */
  name: string | null;
  /** Where the resolution came from. */
  source: ProfileSource;
}

export class NoProfileResolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProfileResolvedError";
  }
}

export class ImplicitDefaultBlockedError extends Error {
  constructor() {
    super(
      "Implicit default profile blocked: workspace/profiles/default/.no-default-allowed " +
        "exists. Pass --profile <name> or run `arianna profile use <name>` first.",
    );
    this.name = "ImplicitDefaultBlockedError";
  }
}

/**
 * Resolution order per eng-review D4:
 *   1. --profile flag (already validated by argv parser)
 *   2. ARIANNA_PROFILE env
 *   3. `~/.arianna/config` [default] profile = X
 *   4. (optional, sprint backwards-compat) literal "default"
 *
 * Returns `{ name: null, source: "none" }` only if (4) is disabled and
 * nothing else matched. Throws ImplicitDefaultBlockedError if the chosen
 * source ends up being implicit-default but the dev sentinel is present.
 */
export function resolveProfile(opts: ResolveProfileOpts = {}): ResolvedProfile {
  if (opts.flag) {
    return { name: assertValidProfileName(opts.flag), source: "flag" };
  }

  const env = opts.env ?? process.env;
  if (env.ARIANNA_PROFILE) {
    return { name: assertValidProfileName(env.ARIANNA_PROFILE), source: "env" };
  }

  const cfg = loadConfig(opts);
  if (cfg.defaultProfile) {
    return { name: cfg.defaultProfile, source: "config-default" };
  }

  if (opts.allowImplicitDefault) {
    if (sentinelExists(opts)) throw new ImplicitDefaultBlockedError();
    return { name: "default", source: "implicit-default" };
  }

  return { name: null, source: "none" };
}

/**
 * Like resolveProfile but throws NoProfileResolvedError instead of returning
 * `{ name: null }`. For commands that need a profile no matter what.
 */
export function requireProfile(opts: ResolveProfileOpts = {}): { name: string; source: ProfileSource } {
  const { name, source } = resolveProfile(opts);
  if (!name) {
    throw new NoProfileResolvedError(
      "No profile resolved. Pass --profile <name>, set ARIANNA_PROFILE, or " +
        "run `arianna profile use <name>` to set a default.",
    );
  }
  return { name, source };
}

function sentinelExists(opts: PathOpts): boolean {
  try {
    return existsSync(noDefaultAllowedSentinelPath(opts));
  } catch {
    return false;
  }
}
