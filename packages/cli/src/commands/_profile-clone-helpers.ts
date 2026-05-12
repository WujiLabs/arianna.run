// Shared helpers for profile-cloning operations: docker tag retag, session
// state file copy with sessionId rename, snapshot-history copy with sessionId
// rewrite. Used by `arianna fork` (live → live) and
// `arianna profile restore` (tarball → live). Extracted to keep the two
// commands sharing one canonical implementation of the rename pattern.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const VESSEL_REPO = "ariannarun-vessel";

// Mirrors the daemon's `SAFE_ID_RE`. Session IDs are interpolated into
// `docker tag` and `docker images --filter` shell commands, so we validate
// the character set before shelling out — defense-in-depth against a
// hand-edited or corrupted session_config.json (or a maliciously-crafted
// tarball manifest in the restore case).
export const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface CloneExecResult {
  stdout: string;
  stderr: string;
}
export type CloneExecFn = (cmd: string) => Promise<CloneExecResult>;

export class ProfileCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileCloneError";
  }
}

/**
 * Single-quote the filter to prevent shell glob expansion of the trailing
 * `*` against cwd.
 */
export function listTagsCmd(sessionId: string): string {
  return `docker images --filter 'reference=${VESSEL_REPO}:${sessionId}-*' --format '{{.Repository}}:{{.Tag}}'`;
}

export function parseSlotFromTag(tag: string, sessionId: string): string | null {
  const colonIdx = tag.indexOf(":");
  if (colonIdx === -1) return null;
  const repo = tag.slice(0, colonIdx);
  if (repo !== VESSEL_REPO) return null;
  const versionAndSlot = tag.slice(colonIdx + 1);
  const prefix = `${sessionId}-`;
  if (!versionAndSlot.startsWith(prefix)) return null;
  return versionAndSlot.slice(prefix.length);
}

/**
 * Refuse to proceed if any docker tag already exists for `dstSessionId`.
 * Idempotency guard against re-running a clone that previously partial-failed
 * after retag.
 */
export async function assertNoDstTags(
  dstSessionId: string,
  exec: CloneExecFn,
): Promise<void> {
  if (!SAFE_SESSION_ID_RE.test(dstSessionId)) {
    throw new ProfileCloneError(
      `Refusing to query docker for unsafe sessionId "${dstSessionId}".`,
    );
  }
  const r = await exec(listTagsCmd(dstSessionId));
  if (r.stdout.trim().length > 0) {
    throw new ProfileCloneError(
      `Docker already has tags for dst sessionId ${dstSessionId}: refusing to overwrite.`,
    );
  }
}

export interface RetagResult {
  retagged: number;
  srcTags: string[];
}

/**
 * List `${VESSEL_REPO}:${srcSessionId}-*` tags and `docker tag` each into the
 * dst sessionId namespace. Source-side tags untouched. Returns the number of
 * tags retagged plus the original src tag list (handy for manifests).
 */
export async function retagDockerImages(
  srcSessionId: string,
  dstSessionId: string,
  exec: CloneExecFn,
): Promise<RetagResult> {
  if (!SAFE_SESSION_ID_RE.test(srcSessionId)) {
    throw new ProfileCloneError(
      `Source sessionId "${srcSessionId}" contains characters that aren't safe to interpolate into a docker command. Expected ${SAFE_SESSION_ID_RE.source}.`,
    );
  }
  if (!SAFE_SESSION_ID_RE.test(dstSessionId)) {
    throw new ProfileCloneError(
      `Destination sessionId "${dstSessionId}" contains characters that aren't safe to interpolate into a docker command. Expected ${SAFE_SESSION_ID_RE.source}.`,
    );
  }

  const srcTagList = await exec(listTagsCmd(srcSessionId));
  const srcTags = srcTagList.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (srcTags.length === 0) {
    throw new ProfileCloneError(
      `No docker tags found for source sessionId ${srcSessionId}. ` +
        `Source must have at least an ariannarun-vessel:${srcSessionId}-base tag.`,
    );
  }

  let retagged = 0;
  for (const oldTag of srcTags) {
    const slot = parseSlotFromTag(oldTag, srcSessionId);
    if (slot === null) continue;
    const newTag = `${VESSEL_REPO}:${dstSessionId}-${slot}`;
    await exec(`docker tag ${oldTag} ${newTag}`);
    retagged++;
  }

  return { retagged, srcTags };
}

/**
 * Copy a sidecar session-state file from `${srcSessionId}.json` to
 * `${dstSessionId}.json`. The JSON content has no embedded sessionId, so we
 * just rename the filename. Returns true if a file was copied, false if the
 * source didn't exist.
 *
 * `srcSessionsDir` is the source `sidecar-state/sessions` dir (absolute or
 * relative to cwd). `dstSessionsDir` will be created if missing.
 */
export function copySessionStateFile(
  srcSessionsDir: string,
  dstSessionsDir: string,
  srcSessionId: string,
  dstSessionId: string,
): boolean {
  mkdirSync(dstSessionsDir, { recursive: true });
  const srcFile = join(srcSessionsDir, `${srcSessionId}.json`);
  if (!existsSync(srcFile)) return false;
  copyFileSync(srcFile, join(dstSessionsDir, `${dstSessionId}.json`));
  return true;
}

/**
 * Copy snapshot-history pairing files (`snap_*.json`) from src to dst,
 * rewriting any embedded `sessionId` field to `dstSessionId`. Skips files
 * whose embedded sessionId doesn't match `srcSessionId` (foreign sessions).
 * Returns the count of files actually copied.
 *
 * Compact JSON output matches the sidecar's `writeSnapshotPairingAtomic`
 * format.
 */
export function copySnapshotHistories(
  srcHistDir: string,
  dstHistDir: string,
  srcSessionId: string,
  dstSessionId: string,
): number {
  mkdirSync(dstHistDir, { recursive: true });
  if (!existsSync(srcHistDir)) return 0;

  let copied = 0;
  for (const f of readdirSync(srcHistDir)) {
    if (!f.endsWith(".json")) continue;
    const raw = readFileSync(join(srcHistDir, f), "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // skip malformed
    }
    if (
      typeof parsed.sessionId === "string" &&
      parsed.sessionId !== srcSessionId
    ) {
      continue; // foreign session
    }
    const rewritten = { ...parsed, sessionId: dstSessionId };
    writeFileSync(join(dstHistDir, f), JSON.stringify(rewritten));
    copied++;
  }
  return copied;
}
