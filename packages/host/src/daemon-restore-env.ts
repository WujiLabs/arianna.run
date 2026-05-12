// Pure helpers for the daemon's /restore flow.
//
// The daemon's `docker compose ... up -d --force-recreate vessel` step needs
// to recreate the vessel container with the *current session's* identity —
// otherwise compose falls back to the docker-compose.yml defaults
// (`ARIANNA_SESSION_ID:-default`, `AI_NAME:-Vessel`, etc.) and the recreated
// vessel writes its sync state under the wrong sessionId. The daemon process
// itself was forked without those env vars set (operator-set in the shell at
// `docker compose up` time, never propagated into the daemon's process.env),
// so we have to read them from session_config.json and inject them per-call.
//
// These helpers are extracted into their own module so they can be tested
// without mocking dockerode or child_process.

import type { SessionConfig } from "@arianna/types";

/**
 * Per-profile vessel image repo name. Legacy single-tenant runs use the bare
 * `ariannarun-vessel` repo; named profiles use `ariannarun-vessel-{profile}`
 * so an operator-direct `docker compose build vessel` for one profile
 * doesn't stomp another profile's `:latest` tag (the canary-001/002 Lume
 * re-test surfaced this in commit 18ba363).
 *
 * Pure function — no docker calls. Caller decides what to do with the result
 * (mint a tag, list images by reference, etc.).
 */
export function vesselRepoForProfile(opts: {
  isLegacy: boolean;
  name: string;
  legacyRepo?: string;
}): string {
  const legacy = opts.legacyRepo ?? "ariannarun-vessel";
  return opts.isLegacy ? legacy : `${legacy}-${opts.name}`;
}

/**
 * Format a session-scoped tag as `{repo}:{sessionId}-{slot}`. The repo is
 * what `vesselRepoForProfile` returned; the slot is `base`, `current`, or
 * `snap_{ts}`. No validation — callers are responsible for SAFE_ID_RE
 * checking the sessionId before this builds a tag that ends up in a docker
 * shell command.
 */
export function vesselTagFor(repo: string, sessionId: string, slot: string): string {
  return `${repo}:${sessionId}-${slot}`;
}

/**
 * Build the env block to pass to `docker compose up -d --force-recreate vessel`
 * when restoring a snapshot. Returns a fresh object so callers can mutate the
 * result (e.g., add ARIANNA_VESSEL_TAG variants for forks) without affecting
 * the input.
 *
 * What this propagates:
 *   ARIANNA_VESSEL_TAG  — image tag slot for the recreated vessel
 *   ARIANNA_SESSION_ID  — must match the snapshot's sessionId or the recreated
 *                         vessel will sync to the wrong sidecar session file
 *   AI_NAME             — display name baked into the image at build time but
 *                         also read at runtime via env (e.g. /etc/motd)
 *   AI_USERNAME         — system username, must match the image's home dir
 *   MODEL_ID, PROVIDER  — vessel passes these to pi-ai for LLM dispatch
 *   API_KEY             — credential for the LLM provider
 *
 * What this does NOT propagate (intentional): operator-set env in the shell
 * at first `docker compose up` time (e.g., DEBUG flags, OPENROUTER_API_KEY
 * fallbacks). Those don't survive a restore, by design — the only source of
 * truth for session identity is session_config.json.
 */
export function buildRestoreEnv(
  baseEnv: NodeJS.ProcessEnv,
  config: SessionConfig,
  vesselTagSlot: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ARIANNA_VESSEL_TAG: vesselTagSlot,
    ARIANNA_SESSION_ID: config.sessionId,
    AI_NAME: config.aiName,
    AI_USERNAME: config.aiUsername,
    MODEL_ID: config.modelId,
    PROVIDER: config.provider,
    API_KEY: config.externalLlmApiKey,
  };
}

/**
 * Backwards-compat helper for restore. The canonical image tag for a snapshot
 * is `{sessionId}-{snapshotId}` (computed from session_config.json's
 * sessionId). Snapshots taken before the vessel resolveSessionId fix landed
 * are tagged with whatever sessionId the buggy vessel echoed via /sync —
 * typically `default`, because compose's `${ARIANNA_SESSION_ID:-default}`
 * substitution kicked in. Those snapshots' meta JSON files DO record the
 * actual on-disk image tag in the `dockerImage` field (the sidecar wrote it
 * at snapshot time), so we can use that to bridge old → new.
 *
 * Per-profile namespacing complement (2026-05-10, follow-up to commit
 * 18ba363): `vesselRepo` now accepts a single repo OR a list of acceptable
 * repos. Pass `["ariannarun-vessel-foo", "ariannarun-vessel"]` to accept
 * both per-profile-namespaced snapshots (taken after the namespacing
 * landed) AND legacy global-namespace snapshots (taken before). The first
 * matching prefix wins — order the list with the preferred repo first.
 *
 * Returns the tag string from `meta.dockerImage` if and only if:
 *   - the meta file parses
 *   - dockerImage is a string
 *   - it starts with "{vesselRepo}:" for at least one candidate repo
 *     (rejects pointers to other repos)
 *   - the tag part matches `safeIdRegex` (defense against shell injection
 *     via a corrupted meta file)
 *
 * Returns null otherwise. Caller is responsible for verifying the image
 * actually exists in docker before using the tag.
 */
export function findFallbackImageTag(opts: {
  metaJson: string | null;
  vesselRepo: string | readonly string[];
  safeIdRegex: RegExp;
}): string | null {
  if (opts.metaJson == null) return null;
  let meta: { dockerImage?: unknown };
  try {
    meta = JSON.parse(opts.metaJson) as { dockerImage?: unknown };
  } catch {
    return null;
  }
  if (typeof meta.dockerImage !== "string") return null;
  const candidates = Array.isArray(opts.vesselRepo)
    ? opts.vesselRepo
    : [opts.vesselRepo as string];
  for (const repo of candidates) {
    const prefix = `${repo}:`;
    if (!meta.dockerImage.startsWith(prefix)) continue;
    const tagPart = meta.dockerImage.slice(prefix.length);
    if (!opts.safeIdRegex.test(tagPart)) return null;
    return meta.dockerImage;
  }
  return null;
}

/**
 * Parse `{repo}:{sessionId}-{snapshotId}` tags into `{ snapshotId, sessionId,
 * repo, tag }` records. Snapshot tags are the ones where `snapshotId` starts
 * with `snap_` — that filters out the per-session slot tags (`-base`,
 * `-current`) and the repo-level pointers (`:latest`). It catches every
 * snapshot mint path we have today: sidecar /sync (`snap_TIMESTAMP`),
 * profile-snapshot-overlay (`snap_overlay_TIMESTAMP`), and operator-named
 * rescue tags (`snap_post_209_*`, `snap_pre_209_*` observed in canary-fresh-1).
 *
 * Used by:
 *   - daemon GET /snapshot-images so the sidecar's orphan-cleanup can ask
 *     "what snapshots actually exist as docker images?" rather than reading
 *     meta JSON files. Meta files are written only by the daemon's /sync-
 *     driven snapshot path; snapshot-overlay and operator-direct tags skip
 *     that step, so meta-file enumeration is not a faithful "what exists"
 *     query (canary-fresh-1 2026-05-11: 8 docker tags lacked meta files,
 *     including 4 snap_overlay_* tags whose pairings cleanupOrphanHistories
 *     wiped on the next sidecar startup).
 *   - arianna profile fix-pairings: needs the sessionId to seed the
 *     reconstructed pairing JSON file.
 *
 * Filters:
 *   - tag must match `{accepted-repo}:` (one of the candidates passed in)
 *   - the portion after `:` must split on the LAST `-snap_` marker into a
 *     `sessionId` part and a slot part — anchoring on `-snap_` (rather
 *     than the first `-`) keeps the parser robust against any future
 *     sessionId that introduces a `-` (SAFE_ID_RE allows it; current mints
 *     don't use it, but this future-proofs the split)
 *   - both parts must match safeIdRegex (defense against any future tag
 *     format drift that smuggles shell metachars)
 *   - the slot part must start with `snap_` by construction (we anchored
 *     on `-snap_`)
 *
 * Returns deduplicated records (a snapshot can be tagged into both the
 * per-profile namespace AND the legacy global namespace — the per-profile
 * record wins via the candidates ordering). Caller passes `vesselRepo` with
 * the preferred repo first.
 */
export interface SnapshotImageRecord {
  /** The snapshotId portion (everything after the first `-` in the tag). */
  snapshotId: string;
  /** The sessionId portion (everything before the first `-` in the tag). */
  sessionId: string;
  /** Source repo the tag was found under. */
  repo: string;
  /** Full `{repo}:{sessionId}-{snapshotId}` tag string (for logs / rescue). */
  tag: string;
}

export function parseSnapshotImageTags(opts: {
  tags: readonly string[];
  vesselRepo: readonly string[];
  safeIdRegex: RegExp;
}): SnapshotImageRecord[] {
  const seen = new Map<string, SnapshotImageRecord>();
  // Anchor on `-snap_` (the snapshot-slot prefix). Splitting on the FIRST
  // `-` would have a latent bug if a sessionId ever contained a `-` —
  // SAFE_ID_RE allows it even though current mints (`session_${Date.now()}`)
  // don't. Anchoring on the slot prefix is unambiguous: every snapshot tag
  // we mint passes through `vesselTagFor(repo, sessionId, "snap_..." )`,
  // and the only non-snapshot slots (`base`, `current`) are filtered out
  // by the absent `-snap_` marker.
  const SNAP_SLOT_MARKER = "-snap_";
  for (const repo of opts.vesselRepo) {
    const prefix = `${repo}:`;
    for (const tag of opts.tags) {
      if (!tag.startsWith(prefix)) continue;
      const tagPart = tag.slice(prefix.length);
      // lastIndexOf would also work; the marker is rare enough that either
      // direction is unambiguous in practice. Use lastIndexOf to be
      // maximally lenient against any future weirdness.
      const markerIdx = tagPart.lastIndexOf(SNAP_SLOT_MARKER);
      if (markerIdx <= 0) continue;
      const sessionId = tagPart.slice(0, markerIdx);
      const snapshotId = tagPart.slice(markerIdx + 1); // skip the leading `-`
      if (!opts.safeIdRegex.test(sessionId)) continue;
      if (!opts.safeIdRegex.test(snapshotId)) continue;
      // Defense-in-depth — the marker guarantees `snap_` prefix already,
      // but verify in case the marker ever evolves.
      if (!snapshotId.startsWith("snap_")) continue;
      if (!seen.has(snapshotId)) {
        seen.set(snapshotId, { snapshotId, sessionId, repo, tag });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Pull a single key out of a docker-inspect-style env list (array of
 * "KEY=value" strings). Returns null when the key is missing.
 */
export function extractContainerEnv(
  envList: readonly string[] | undefined,
  key: string,
): string | null {
  const prefix = `${key}=`;
  const found = (envList ?? []).find((e) => e.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

/**
 * Verify that a recreated vessel container's env matches the expected
 * session identity. Throws with a clear, actionable message on mismatch
 * so the operator sees *why* restore failed instead of inheriting a
 * silently-wrong sidecar session file.
 */
export function assertContainerSessionId(
  envList: readonly string[] | undefined,
  expected: string,
): void {
  const actual = extractContainerEnv(envList, "ARIANNA_SESSION_ID");
  if (actual !== expected) {
    throw new Error(
      `restore: post-recreate vessel has ARIANNA_SESSION_ID=${
        actual ?? "<missing>"
      }, expected ${expected}. The session_config.json identity did not ` +
        `propagate to the container — env injection in compose up failed. ` +
        `Check daemon logs and that session_config.json is well-formed.`,
    );
  }
}
