import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  DAEMON_PORT_BASE,
  SIDECAR_PORT_BASE,
  VESSEL_PORT_BASE,
} from "./port-allocator.js";
import { assertValidProfileName } from "./profile.js";

export interface ComposeOverrideInputs {
  profile: string;
  portOffset: number;
  /**
   * Optional AI username for the vessel image's `AI_USERNAME` build-arg.
   * When omitted, the build-args block is not emitted and any subsequent
   * `docker compose build vessel` falls back to the Dockerfile's ARG default
   * (`vessel`). Set this to the value from the profile's
   * `session_config.json.aiUsername` so an operator-direct rebuild
   * (`docker compose -f .. -f workspace/profiles/<name>/compose.override.yml
   * build vessel`) preserves the AI's identity instead of producing a vessel
   * with /home/vessel/ where /home/<aiUsername>/ used to live. The CLI's
   * `arianna profile fix` reads aiUsername from session_config.json and
   * passes it through; the ad-hoc `arianna profile create` path passes it
   * once the lobby has chosen a name (currently a re-render after
   * session_config.json is written).
   */
  aiUsername?: string;
}

/**
 * Render the per-profile compose.override.yml. Additive: the base
 * docker-compose.yml stays single-tenant on 3000/8000/9000 with
 * `container_name: arianna-vessel`, and each profile lays an override on top
 * that remaps host ports, renames the vessel container, and rebinds the
 * sidecar's state mounts to the profile-scoped paths.
 *
 * Per the #37 eng-review-locked decision the daemon is ONE shared process at
 * 127.0.0.1:9000 — it routes per-profile via ?profile= or
 * X-Arianna-Profile, so the daemon port is NOT shifted by port_offset.
 *
 * Per-profile image namespacing (vessel.image): the override emits
 * `image: ariannarun-vessel-{profile}:latest` so an operator-direct
 * `docker compose ... build vessel` lands the result in a per-profile
 * Docker image repo. Without this, every profile's rebuild overwrites
 * the global `ariannarun-vessel:latest`, and a subsequent
 * `docker compose up --force-recreate vessel` for a DIFFERENT profile
 * picks up the wrong AI's identity (canary-002's Wren stomping
 * canary-001's Lume — the 2026-05-10 Lume re-test that surfaced this).
 * The build-arg block above guards rebuild identity; this image override
 * guards rebuild ISOLATION between profiles. Note: the daemon's
 * session-scoped tagging (Phase 4) still tags into the global
 * `ariannarun-vessel:{sessionId}-{slot}` repo via ARIANNA_VESSEL_TAG env;
 * because the override's scalar `image:` field replaces (not merges with)
 * the base's `ariannarun-vessel:${ARIANNA_VESSEL_TAG:-latest}`, daemon-
 * driven /restore for profiles with this override no longer respects the
 * env-injected snapshot tag — restore for those profiles becomes "boot
 * the latest per-profile build" rather than "boot a specific snapshot".
 * That's a known follow-up: the daemon needs a parallel
 * `docker tag ariannarun-vessel:{sid}-{slot} ariannarun-vessel-{profile}:{sid}-{slot}`
 * step (or the override needs to inline the template var AND the daemon
 * needs to tag in per-profile space). Tracked in the report.
 *
 * Compose merge semantics — why `!override`:
 * Compose v2's default merge rule for list-typed fields (`ports`, `volumes`,
 * `extra_hosts`, `depends_on`, …) is CONCAT, not REPLACE. Without an explicit
 * tag, an override that says `ports: ["127.0.0.1:3005:3000"]` produces a
 * merged list of `["127.0.0.1:3000:3000", "127.0.0.1:3005:3000"]` — a single
 * profile invisibly bound to BOTH ports, and two profiles up simultaneously
 * collide on 8000. The `!override` tag (compose-spec §13 "Reset / Override
 * values") tells the merge engine to fully replace the base list. We apply
 * it to:
 *   - vessel.ports / sidecar.ports — fixes the double-bind
 *   - vessel.volumes — rebinds session_config to the profile dir so the
 *     vessel resolves sessionId from this profile's file instead of the
 *     legacy single-tenant one (the snapshot-tagging-default-* bug fix)
 *   - sidecar.volumes — rebinds session_config + sidecar-state to the
 *     profile dir so multi-profile state doesn't leak through legacy
 *     workspace/{session_config.json,sidecar-state} bind mounts
 *
 * Other potentially-list fields (`extra_hosts`, `depends_on`, the vessel's
 * `environment` map) are NOT redefined here, so the base value passes
 * through unchanged. If a future override starts redefining one of those
 * list fields, it must add `!override` too — see compose-override.test.ts
 * for the contract drift catcher.
 *
 * Path interpolation safety: `assertValidProfileName` enforces
 * `^[a-z][a-z0-9-]{0,30}$` at every CLI boundary; we re-assert here as
 * defense-in-depth so a programmatic caller can't smuggle a path-traversal
 * or YAML-injecting name into the volume strings or container_name.
 */
// POSIX-ish username constraint matching session-config.ts's
// AI_USERNAME_RE. Re-defined here (not imported) so the override generator
// has zero deps on session-config — keeps the renderer trivially testable
// and lets profile-fix.ts catch malformed session_config.json without
// triggering an exception in the renderer.
const AI_USERNAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export class InvalidAiUsernameError extends Error {
  constructor(value: string) {
    super(
      `aiUsername "${value}" is not a valid POSIX username (^[a-z][a-z0-9-]{0,31}$).`,
    );
    this.name = "InvalidAiUsernameError";
  }
}

export function renderComposeOverride(inputs: ComposeOverrideInputs): string {
  const { profile, portOffset, aiUsername } = inputs;
  assertValidProfileName(profile);
  // Defense-in-depth: aiUsername lands in compose YAML as a literal AND
  // becomes a Docker build-arg shell-interpolated by adduser/chown lines in
  // the Dockerfile. Validate the same way session-config.ts does so a
  // hand-edited session_config.json can't smuggle whitespace, quotes, or
  // shell metacharacters past the renderer.
  if (aiUsername !== undefined && !AI_USERNAME_RE.test(aiUsername)) {
    throw new InvalidAiUsernameError(aiUsername);
  }
  const vesselPort = VESSEL_PORT_BASE + portOffset;
  const sidecarPort = SIDECAR_PORT_BASE + portOffset;
  // Vessel build-args block — emitted only when aiUsername is known. Without
  // this, an operator-direct `docker compose build vessel` (run against the
  // base + this override) loses the AI's identity: the Dockerfile's ARG
  // default (`vessel`) takes over and the rebuilt image has /home/vessel/
  // instead of /home/<aiUsername>/, breaking embodiment. Setting the
  // build-arg here makes the per-profile override the source of truth for
  // the username at rebuild time, decoupled from the
  // `arianna profile create --build-arg AI_USERNAME=...` flow that runs
  // once at create time. See CLAUDE.md > "Vessel Container Architecture"
  // and the 2026-05-10 Mirin r2 / Pax re-test surfacing this.
  const vesselBuildBlock = aiUsername
    ? [
        "    build:",
        "      args:",
        `        AI_USERNAME: ${aiUsername}`,
      ]
    : [];
  return [
    `# Generated by \`arianna profile create ${profile}\`. Do not hand-edit —`,
    `# regenerate via \`arianna profile recreate ${profile}\` if drift is needed.`,
    `# Profile: ${profile}  port_offset: ${portOffset}`,
    `# Daemon is host-side and shared across profiles at 127.0.0.1:${DAEMON_PORT_BASE} (not in compose).`,
    "services:",
    "  vessel:",
    `    container_name: arianna-vessel-${profile}`,
    // Per-profile image repo. See header comment "Per-profile image
    // namespacing" for why this is a flat `:latest` and what the daemon
    // restore implication is.
    `    image: ariannarun-vessel-${profile}:latest`,
    ...vesselBuildBlock,
    `    ports: !override`,
    `      - "127.0.0.1:${vesselPort}:3000"`,
    `    volumes: !override`,
    // Per-profile session_config.json mount. Base docker-compose.yml mounts
    // ./workspace/session_config.json → /app/session_config.json; without an
    // override the vessel for profile X would resolve sessionId from the
    // legacy single-tenant file, not from this profile's. The vessel's
    // sessionId is then echoed back in /sync, the sidecar trusts it, and
    // snapshots get tagged with the wrong sessionId. !override is required
    // because compose's default merge for `volumes:` is concat, not replace.
    `      - "./workspace/profiles/${profile}/session_config.json:/app/session_config.json:ro"`,
    "  sidecar:",
    "    environment:",
    `      ARIANNA_PROFILE: ${profile}`,
    `    ports: !override`,
    `      - "127.0.0.1:${sidecarPort}:8000"`,
    `    volumes: !override`,
    `      - "./workspace/profiles/${profile}/session_config.json:/app/session_config.json:ro"`,
    `      - "./workspace/profiles/${profile}/sidecar-state:/app/sidecar-state"`,
    "",
  ].join("\n");
}

export function writeComposeOverride(path: string, inputs: ComposeOverrideInputs): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderComposeOverride(inputs));
}
