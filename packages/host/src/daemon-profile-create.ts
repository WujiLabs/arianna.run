// Gap 12 (validation agent abf126be, 2026-05-09): pure-business-logic helper
// for the daemon's POST /profile-create endpoint. The HTTP shell in
// daemon.ts validates the inputs and renders the response; this module owns
// the actual create flow so it can be unit-tested without spinning up an
// HTTP server.
//
// Mirrors `arianna profile create`'s cmdCreate (packages/cli/src/commands/
// profile.ts) using the same primitives:
//   - assertValidProfileName (regex enforcement)
//   - mkdirSync(recursive:false) atomic claim of the profile dir
//   - withPortLock + allocateOffset under the ports.lock flock
//   - writeComposeOverride
//   - loadConfig + saveConfig
//
// Inversion-of-control: the helper takes plain inputs (name, optional
// explicit offset) and returns a discriminated union of {ok, ...} or
// {error, code, status} so the HTTP layer can map directly to the response.
// No fetch, no Response, no req/res — pure file + lock operations.

import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { loadConfig, saveConfig } from "@arianna/cli/arianna-config";
import { writeComposeOverride } from "@arianna/cli/compose-override";
import {
  allocateOffset,
  withPortLock,
  type AllocateOpts,
} from "@arianna/cli/port-allocator";
import { profileDir, profileOverridePath, type PathOpts } from "@arianna/cli/paths";
import { isValidProfileName } from "@arianna/cli/profile";

export type ProfileCreateInputs = {
  name: string;
  /**
   * Optional explicit port_offset request. When set, the allocator still
   * runs (under flock) and we 409 if its choice doesn't match — we never
   * silently honor a possibly-colliding explicit offset.
   */
  portOffset?: number | null;
} & PathOpts &
  Pick<AllocateOpts, "skipBindTest" | "isPortFree" | "acquireTimeoutMs">;

export type ProfileCreateOk = {
  ok: true;
  name: string;
  portOffset: number;
  vesselPort: number;
  sidecarPort: number;
  daemonPort: number;
  profileDir: string;
  composeOverride: string;
  isDefault: boolean;
};

export type ProfileCreateError = {
  ok: false;
  status: 400 | 409 | 500;
  error: string;
  code:
    | "missing-name"
    | "invalid-profile-name"
    | "invalid-port-offset"
    | "profile-exists"
    | "profile-dir-exists"
    | "offset-unavailable"
    | "internal-error";
};

/**
 * Run the profile-create flow on the host. Returns the daemon's response
 * shape directly. The HTTP wrapper in daemon.ts maps {ok:false}→writeHead
 * with the recommended status; {ok:true}→200.
 *
 * Side effects on success:
 *   - mkdirs workspace/profiles/<name>/
 *   - writes workspace/profiles/<name>/compose.override.yml
 *   - mutates ~/.arianna/config (adds [profile name] + sets [default] if
 *     this is the first profile)
 *
 * Side effects on failure:
 *   - any partially-written state is removed before returning. Caller
 *     never has to clean up.
 */
export async function handleProfileCreate(
  inputs: ProfileCreateInputs,
): Promise<ProfileCreateOk | ProfileCreateError> {
  const { name, portOffset: explicitOffsetRaw, ...pathOpts } = inputs;

  if (!name) {
    return {
      ok: false,
      status: 400,
      error: "Missing required query param: name",
      code: "missing-name",
    };
  }
  if (!isValidProfileName(name)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid profile name "${name}". Must match ^[a-z][a-z0-9-]{0,30}$.`,
      code: "invalid-profile-name",
    };
  }

  let explicitOffset: number | null;
  try {
    explicitOffset = normalizeExplicitOffset(explicitOffsetRaw);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: (err as Error).message,
      code: "invalid-port-offset",
    };
  }

  const cfg = loadConfig(pathOpts);
  if (cfg.profiles.has(name)) {
    return {
      ok: false,
      status: 409,
      error: `Profile "${name}" already exists in ~/.arianna/config.`,
      code: "profile-exists",
    };
  }

  const dir = profileDir(name, pathOpts);
  // Atomic dir claim — same pattern as cmdCreate. Two parallel /profile-create
  // requests for the same name race here; one wins, the other gets EEXIST.
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return {
        ok: false,
        status: 409,
        error: `Profile directory ${dir} already exists but is not in ~/.arianna/config.`,
        code: "profile-dir-exists",
      };
    }
    throw err;
  }

  // From here on we own dir. Any failure cleans it up before returning.
  try {
    const offset = await withPortLock(() => allocateOffset(pathOpts), pathOpts);

    if (explicitOffset !== null && explicitOffset !== offset) {
      cleanupDir(dir);
      return {
        ok: false,
        status: 409,
        error:
          `Requested port_offset=${explicitOffset} is not free; allocator would pick ${offset}. ` +
          `Re-issue without port_offset to accept the allocator's choice.`,
        code: "offset-unavailable",
      };
    }

    writeComposeOverride(profileOverridePath(name, pathOpts), {
      profile: name,
      portOffset: offset,
    });

    cfg.profiles.set(name, { portOffset: offset, createdAt: Date.now() });
    if (!cfg.defaultProfile) cfg.defaultProfile = name;
    saveConfig(cfg, pathOpts);

    return {
      ok: true,
      name,
      portOffset: offset,
      vesselPort: 3000 + offset,
      sidecarPort: 8000 + offset,
      daemonPort: 9000,
      profileDir: dir,
      composeOverride: profileOverridePath(name, pathOpts),
      isDefault: cfg.defaultProfile === name,
    };
  } catch (err) {
    cleanupDir(dir);
    return {
      ok: false,
      status: 500,
      error: (err as Error).message,
      code: "internal-error",
    };
  }
}

function normalizeExplicitOffset(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(raw) || raw < 0 || raw > 99) {
    throw new Error(`Invalid port_offset "${raw}": must be an integer in [0, 99].`);
  }
  return raw;
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
