// CLI runtime configuration. Resolves where the vessel, sidecar, and daemon
// live, threading the profile-resolver chain (flag > env > config-default >
// implicit-default during the sprint) and shifting host ports by the
// profile's port_offset.
//
// Env overrides VESSEL_BASE_URL/SIDECAR_BASE_URL/DAEMON_BASE_URL win over
// profile-derived URLs — useful for tests and for pointing the CLI at a
// remote stack.
//
// Container-aware host detection: when the CLI is invoked from a container
// without a local docker binary (canonical case: `arianna talk` running
// inside an OpenClaw dev container), 127.0.0.1 resolves to the container's
// own loopback — the host's vessel/sidecar are unreachable. We mirror the
// bc325ae `/compose-up` daemon-route fallback by swapping the host portion
// to `host.docker.internal` in that scenario. The probe is the same one
// `ensureComposeUp` uses (`docker --version` exit code), so both routing
// decisions stay in lockstep. Env overrides still win — operators with
// non-Docker-Desktop bridges set VESSEL_BASE_URL/SIDECAR_BASE_URL directly.

import { loadConfig } from "./arianna-config.js";
import { isLocalDockerAvailable } from "./compose-up.js";
import {
  resolveProfile,
  type ResolvedProfile,
  type ResolveProfileOpts,
} from "./profile-resolver.js";
import {
  DAEMON_PORT_BASE,
  SIDECAR_PORT_BASE,
  VESSEL_PORT_BASE,
} from "./port-allocator.js";
import type { PathOpts } from "./paths.js";

/**
 * Hostname used in the default vessel/sidecar URLs when no env override is
 * set and a local docker probe succeeds. The vessel/sidecar bind to
 * `127.0.0.1:{port}` on the host, so a same-host caller (laptop, CI, the
 * arianna repo's dev workflow) reaches them via loopback.
 */
export const LOCAL_HOST = "127.0.0.1";

/**
 * Hostname used in the default vessel/sidecar URLs when local docker is
 * missing. Docker Desktop synthesises this name inside every container so
 * loopback-bound host services are reachable. Bare-Linux Docker without
 * Desktop needs `--add-host=host.docker.internal:host-gateway` (which the
 * openclaw compose file already sets) or a manual VESSEL_BASE_URL override.
 */
export const HOST_DOCKER_INTERNAL = "host.docker.internal";

export interface ResolvedConfig {
  /** Resolved profile name, or null if none resolved (no flag/env/default). */
  profile: string | null;
  /** Where the profile name came from. "none" when profile is null. */
  profileSource: ResolvedProfile["source"];
  /** Port offset from the profile entry. 0 when no profile / unknown profile. */
  portOffset: number;
  /**
   * True when the resolved profile is the literal "default" AND has no
   * `~/.arianna/config` entry. Mirrors `ProfileContext.isLegacy` on the
   * daemon side — disk paths fall back to `workspace/...` instead of
   * `workspace/profiles/<name>/...` for these profiles.
   */
  isLegacy: boolean;
  vesselBaseUrl: string;
  sidecarBaseUrl: string;
  daemonBaseUrl: string;
}

export interface ResolveOptions extends PathOpts {
  /** From --profile flag. Already validated by the argv parser. */
  profile?: string;
  /** Test seam — defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** See ResolveProfileOpts.allowImplicitDefault. Default true at runtime. */
  allowImplicitDefault?: boolean;
  /**
   * Probe injected into `isLocalDockerAvailable` for deterministic tests of
   * the container-aware host swap. Throw to simulate "no docker", return
   * normally to simulate "docker present". Production callers leave this
   * undefined and the real `docker --version` probe runs.
   *
   * Only consulted when no env override is set for the corresponding URL —
   * VESSEL_BASE_URL/SIDECAR_BASE_URL still win over the auto-detected host.
   */
  dockerProbe?: () => void;
}

export function resolveConfig(opts: ResolveOptions = {}): ResolvedConfig {
  const env = opts.env ?? process.env;

  const resolverOpts: ResolveProfileOpts = {
    flag: opts.profile,
    env,
    homeDir: opts.homeDir,
    ariannaHome: opts.ariannaHome,
    repoRoot: opts.repoRoot,
    cwd: opts.cwd,
    allowImplicitDefault: opts.allowImplicitDefault ?? true,
  };

  const resolved = resolveProfile(resolverOpts);
  const portOffset = lookupOffset(resolved.name, opts);
  const isLegacy = resolved.name === "default" && !profileInConfig(resolved.name, opts);

  // Lazy-eval the docker probe: only invoked if we'd actually use the result
  // (i.e. at least one of vessel/sidecar URLs needs a default and no env
  // override is set). Saves the ~5-15ms execSync cost on the env-overridden
  // path, which is the canonical test setup.
  let cachedHost: string | undefined;
  const defaultHost = (): string => {
    if (cachedHost !== undefined) return cachedHost;
    cachedHost = isLocalDockerAvailable(opts.dockerProbe)
      ? LOCAL_HOST
      : HOST_DOCKER_INTERNAL;
    return cachedHost;
  };

  return {
    profile: resolved.name,
    profileSource: resolved.source,
    portOffset,
    isLegacy,
    vesselBaseUrl:
      env.VESSEL_BASE_URL ??
      `http://${defaultHost()}:${VESSEL_PORT_BASE + portOffset}`,
    sidecarBaseUrl:
      env.SIDECAR_BASE_URL ??
      `http://${defaultHost()}:${SIDECAR_PORT_BASE + portOffset}`,
    // Per the #37 locked decision the daemon is ONE shared process at
    // 127.0.0.1:9000 — it routes per-profile via ?profile= / X-Arianna-Profile
    // and is NEVER shifted by port_offset. Pointing a non-default profile's
    // daemonBaseUrl at 127.0.0.1:9001 would land on a port nothing's bound to.
    //
    // NOTE: The host portion intentionally stays `127.0.0.1` here, NOT the
    // container-aware default. The daemon-route fallback in compose-up.ts
    // (bc325ae) already swaps to `host.docker.internal:9000` via its own
    // `ARIANNA_DAEMON_URL ?? DEFAULT_DAEMON_URL_FOR_CLI` chain. Other commands
    // that need the daemon from inside a container should set
    // `DAEMON_BASE_URL=http://host.docker.internal:9000` explicitly until the
    // sister fix lands in those callers.
    daemonBaseUrl: env.DAEMON_BASE_URL ?? `http://127.0.0.1:${DAEMON_PORT_BASE}`,
  };
}

// Look up the port offset for a profile name from ~/.arianna/config. If the
// name isn't there (e.g. implicit-default before the user has run `arianna
// profile create default`), fall back to offset 0 — that's the legacy
// single-tenant set of ports.
function lookupOffset(name: string | null, opts: PathOpts): number {
  if (!name) return 0;
  try {
    const cfg = loadConfig(opts);
    return cfg.profiles.get(name)?.portOffset ?? 0;
  } catch {
    return 0;
  }
}

function profileInConfig(name: string | null, opts: PathOpts): boolean {
  if (!name) return false;
  try {
    return loadConfig(opts).profiles.has(name);
  } catch {
    return false;
  }
}
