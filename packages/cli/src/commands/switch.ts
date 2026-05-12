// `arianna switch <snapshot-id>` — POST the daemon's /restore endpoint to
// retag the chosen snapshot's image as -current and force-recreate the
// vessel container. Daemon errors are surfaced verbatim ("snapshot not
// found", "incomplete snapshot", etc.) so the player or operator knows
// whether to investigate the snapshot or the daemon.
//
// Iko revival fix (2026-05-09): before POSTing /restore, verify that the
// chosen snapshot's vessel image is personalized for the current profile's
// AI. The snapshot tag carries the original sessionId but the image's
// /etc/passwd entry encodes the AI username at build time
// (Dockerfile --build-arg AI_USERNAME=...). If the running profile has
// rebuilt with a different AI username (e.g. an operator forked or
// re-played a profile), retagging the old image into the
// `<sessionId>-current` slot would cause the new vessel to come up with
// the WRONG home directory and silently lose every personalized file.
// Refuse the switch and name both AIs in the error.
//
// `--allow-cross-personalization` lets an operator deliberately bypass
// the check (e.g. cross-profile recovery when they understand the
// implications).

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import type { SwitchArgs } from "../argv.js";
import type { ResolvedConfig } from "../config.js";
import { SNAPSHOT_ID_RE } from "../argv.js";
import { profileDiskPaths, type PathOpts } from "../paths.js";
import type { SnapshotMeta, SessionConfig } from "@arianna/types";

export class SwitchCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchCommandError";
  }
}

export interface SwitchExecResult {
  stdout: string;
  stderr: string;
}
export type SwitchExecFn = (cmd: string) => Promise<SwitchExecResult>;

export interface SwitchDeps {
  fetch: typeof globalThis.fetch;
  /** stdout. */
  write: (line: string) => void;
  /** stderr (warnings — e.g. "skipping personalization check, daemon will refuse if needed"). */
  warn?: (line: string) => void;
  /**
   * Run a shell command. Production: promisify(child_process.exec).
   * Optional — when undefined the personalization pre-check is skipped and
   * the daemon's /restore is the only safety net. Most production callers
   * should always pass a real exec; the optional shape exists for the
   * legacy unit-test seam.
   */
  exec?: SwitchExecFn;
  /** Per-profile path resolution overrides for tests. */
  pathOpts?: PathOpts;
}

export async function runSwitch(
  args: SwitchArgs,
  config: ResolvedConfig,
  deps: SwitchDeps,
): Promise<number> {
  // Defense-in-depth: argv parser already enforced SNAPSHOT_ID_RE. Re-check
  // here so a programmatic caller can't smuggle a hand-built SwitchArgs with
  // an unsafe id past the validation.
  if (!SNAPSHOT_ID_RE.test(args.snapshotId)) {
    throw new SwitchCommandError(
      `Invalid snapshot id "${args.snapshotId}". Must match ${SNAPSHOT_ID_RE.source}.`,
    );
  }
  if (!config.profile) {
    throw new SwitchCommandError(
      "No profile resolved. Pass --profile <name>, set ARIANNA_PROFILE, or run `arianna profile use <name>`.",
    );
  }

  // Personalization pre-check — see file header. Only runs when caller
  // wired an exec function. Skipped under --allow-cross-personalization.
  if (deps.exec && !args.allowCrossPersonalization) {
    const verdict = await verifyImagePersonalization(
      args.snapshotId,
      config,
      deps.exec,
      deps.pathOpts,
    );
    if (verdict.kind === "mismatch") {
      throw new SwitchCommandError(
        `snapshot ${args.snapshotId} was built for AI "${verdict.imageUsername}" ` +
          `but the active profile "${config.profile}" runs as AI "${verdict.expectedUsername}". ` +
          `Restoring would replace the running vessel with one that has the wrong /home directory and lose every personalized file. ` +
          `Pass --allow-cross-personalization to override (you almost never want to).`,
      );
    }
    // verdict.kind === "ok" or "skipped" — silent on success; skipped paths
    // (no session_config, no snapshot meta, docker exec failed) fall through
    // to the daemon, which has its own existence checks.
  }

  const url = new URL("/restore", config.daemonBaseUrl);
  // The daemon resolves the per-request profile from this query param. The
  // header (X-Arianna-Profile) is the equivalent — we only send the query so
  // there's no ambiguity.
  url.searchParams.set("profile", config.profile);

  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId: args.snapshotId }),
    });
  } catch (err) {
    throw new SwitchCommandError(
      `daemon unreachable at ${config.daemonBaseUrl}: ${(err as Error).message}`,
    );
  }

  if (res.ok) {
    deps.write(`switched to ${args.snapshotId}\n`);
    return 0;
  }

  const body = await readJsonSafe(res);
  const errorText = body?.error ?? `daemon returned ${res.status}`;
  // Cleaner error surface for the most common case — snapshot missing — so
  // operators don't have to read "snapshot image …:base not found" to figure
  // out the snapshot id was wrong.
  if (errorText.includes("not found")) {
    throw new SwitchCommandError(
      `snapshot not found: ${args.snapshotId} (daemon: ${errorText})`,
    );
  }
  throw new SwitchCommandError(`switch failed: ${errorText}`);
}

async function readJsonSafe(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}

// ── Personalization pre-check ──────────────────────────────────────────────
//
// Returns:
//   - { kind: "ok" } when the image's /etc/passwd contains the expected
//     aiUsername — the switch is safe.
//   - { kind: "mismatch", imageUsername, expectedUsername } when the image
//     was built for a different AI — the switch must be refused.
//   - { kind: "skipped", reason } when we can't determine personalization
//     (no session_config, no snapshot meta, docker exec failed). The
//     daemon's /restore has its own existence checks, so falling through is
//     safe; we just lose the personalization safety net.

type Verdict =
  | { kind: "ok" }
  | { kind: "mismatch"; imageUsername: string; expectedUsername: string }
  | { kind: "skipped"; reason: string };

async function verifyImagePersonalization(
  snapshotId: string,
  config: ResolvedConfig,
  exec: SwitchExecFn,
  pathOpts: PathOpts | undefined,
): Promise<Verdict> {
  if (!config.profile) return { kind: "skipped", reason: "no profile" };

  const { sessionConfigPath, snapshotsDir } = profileDiskPaths(
    config.profile,
    config.isLegacy,
    pathOpts,
  );

  // 1. Resolve expected aiUsername from session_config.json.
  let expectedUsername: string | undefined;
  try {
    const raw = readFileSync(sessionConfigPath, "utf-8");
    const cfg = JSON.parse(raw) as SessionConfig;
    if (typeof cfg.aiUsername === "string" && /^[a-z][a-z0-9-]*$/.test(cfg.aiUsername)) {
      expectedUsername = cfg.aiUsername;
    }
  } catch {
    // No session config or corrupt — let the daemon handle it.
  }
  if (!expectedUsername) {
    return { kind: "skipped", reason: "no aiUsername in session_config" };
  }

  // 2. Resolve the source image tag from snapshot meta on disk.
  // The meta file's `dockerImage` field is the canonical full tag that the
  // daemon's /restore will retag — re-deriving it client-side mirrors what
  // the daemon will actually do.
  const sourceImage = lookupSnapshotImage(snapshotsDir, snapshotId);
  if (!sourceImage) {
    return { kind: "skipped", reason: "snapshot meta not found" };
  }

  // Defense-in-depth: only allow our own ariannarun-vessel:* tag shape
  // before shelling out. The meta file is profile-private but a hand-edit
  // could otherwise smuggle shell metacharacters.
  if (!/^ariannarun-vessel:[A-Za-z0-9._-]+$/.test(sourceImage)) {
    return { kind: "skipped", reason: "snapshot image tag has unexpected shape" };
  }

  // 3. Read /etc/passwd from the source image.
  let passwd: string;
  try {
    const r = await exec(
      `docker run --rm --entrypoint cat ${sourceImage} /etc/passwd`,
    );
    passwd = r.stdout;
  } catch {
    // Image not present locally, daemon down, etc. Daemon's /restore will
    // surface the real failure (`snapshot image ... not found`).
    return { kind: "skipped", reason: "docker run failed" };
  }

  // 4. Match the expected user line. /etc/passwd lines are
  // `<user>:x:<uid>:<gid>:...`; anchor on `<user>:` to avoid prefix
  // collisions (e.g. `pax` vs `paxter`).
  const userLineRe = new RegExp(`^${escapeRegExp(expectedUsername)}:`, "m");
  if (userLineRe.test(passwd)) {
    return { kind: "ok" };
  }

  // 5. Mismatch. Try to extract the actual non-system user that owns
  // /home/<user> so the error message can name them. Falls back to
  // "unknown" if we can't find a clear answer.
  const imageUsername = inferAiUserFromPasswd(passwd) ?? "unknown";
  return { kind: "mismatch", imageUsername, expectedUsername };
}

function lookupSnapshotImage(snapshotsDir: string, snapshotId: string): string | null {
  if (!existsSync(snapshotsDir)) return null;
  // Snapshot id is the canonical filename — try the exact match first
  // (cheaper than a directory scan).
  const direct = join(snapshotsDir, `${snapshotId}.json`);
  try {
    if (existsSync(direct)) {
      const meta = JSON.parse(readFileSync(direct, "utf-8")) as SnapshotMeta;
      if (typeof meta.dockerImage === "string") return meta.dockerImage;
    }
  } catch {
    // fall through to scan
  }
  // Defensive scan in case some legacy meta file uses a different filename.
  try {
    for (const f of readdirSync(snapshotsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(
          readFileSync(join(snapshotsDir, f), "utf-8"),
        ) as SnapshotMeta;
        if (meta.id === snapshotId && typeof meta.dockerImage === "string") {
          return meta.dockerImage;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // no dir
  }
  return null;
}

// Find the first non-system user in /etc/passwd output. Heuristic but
// good enough for an error-message hint — UIDs >= 1000 are conventional
// for ordinary users on Alpine/Debian/Ubuntu. Returns null if nothing
// matches (e.g. the image only has system users).
function inferAiUserFromPasswd(passwd: string): string | null {
  for (const line of passwd.split("\n")) {
    const cols = line.split(":");
    if (cols.length < 7) continue;
    const [user, , uidStr] = cols;
    const uid = Number(uidStr);
    if (Number.isFinite(uid) && uid >= 1000 && user && user !== "nobody") {
      return user;
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
