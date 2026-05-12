import http from "http";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import Dockerode from "dockerode";
import type { SnapshotMeta, SessionConfig } from "@arianna.run/types";
import {
  composeBaseCommand,
  resolveProfileContext,
  type DaemonProfileOpts,
  type ProfileContext,
  type RequestProfileInput,
} from "./daemon-profile.js";
import {
  assertContainerSessionId,
  buildRestoreEnv,
  findFallbackImageTag,
  parseSnapshotImageTags,
  vesselRepoForProfile,
  vesselTagFor,
  type SnapshotImageRecord,
} from "./daemon-restore-env.js";
import { handleProfileCreate as runProfileCreate } from "./daemon-profile-create.js";
import {
  maybeWritePreludeForCompose,
  readImportedMessagesFromDisk,
} from "./daemon-prelude-write.js";

const execAsync = promisify(exec);

// Resolve to the project root regardless of where the process was started.
// pnpm sets cwd per-package; daemon is forked from packages/host so
// process.cwd() would be packages/host, not the repo root. Anchor on this
// file's location instead: src/daemon.ts → ../../.. is the repo root.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// Gap 13 (validation agent abf126be, 2026-05-09): a stale daemon predating a
// newer codebase commit was reporting "healthy" via /health, masking that it
// did not have the newest endpoints (e.g. /compose-up). Operators saw 404 and
// blamed the new endpoint. Surface the running daemon's version + commit +
// uptime via GET /version so `arianna daemon status` can show staleness at a
// glance. Fields:
//   - version: from packages/host/package.json. Always present.
//   - commit: best-effort. Try `git rev-parse --short HEAD` from REPO_ROOT;
//     fall back to ARIANNA_BUILD_COMMIT (set at build time for deployed
//     containers that don't ship a .git dir). Omitted if neither resolves.
//   - uptime_ms: Date.now() - DAEMON_START_TIME.
const DAEMON_START_TIME = Date.now();
const DAEMON_VERSION = readDaemonVersion(REPO_ROOT);
const DAEMON_COMMIT = readDaemonCommit(REPO_ROOT);

function readDaemonVersion(repoRoot: string): string {
  try {
    const pkgPath = join(repoRoot, "packages", "host", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readDaemonCommit(repoRoot: string): string | null {
  // Build-time env var wins. Set this in Dockerfile / CI to inject the commit
  // sha when the runtime image won't carry a .git directory.
  if (process.env.ARIANNA_BUILD_COMMIT) {
    return String(process.env.ARIANNA_BUILD_COMMIT).trim() || null;
  }
  // Best-effort `git rev-parse --short HEAD`. stdio: 'pipe' so the spawn
  // failure on a non-git filesystem doesn't pollute stderr.
  try {
    const out = execSync("git rev-parse --short HEAD", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

const docker = new Dockerode();
const DISK_WARN_GB = Number(process.env.ARIANNA_DISK_WARN_GB ?? "10");
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
// Wave 2E (Cheng v19): how long the /graduate handler waits for the AI to
// call /full-history after the ingestion prompt is delivered. If the AI
// doesn't ingest within the window, the manifest's historyIngested stays
// false. Defaults tuned for an attentive AI; override via env when testing.
const GRADUATE_INGESTION_POLL_MS = Number(
  process.env.ARIANNA_GRADUATE_INGESTION_POLL_MS ?? "5000",
);
const GRADUATE_INGESTION_POLL_INTERVAL_MS = Number(
  process.env.ARIANNA_GRADUATE_INGESTION_POLL_INTERVAL_MS ?? "200",
);

// Phase 4 session-scoped tagging. Image tags follow the pattern:
//   {repo}:{sessionId}-base       — original build for the session
//   {repo}:{sessionId}-current    — running pointer (compose target)
//   {repo}:{sessionId}-snap_X     — each snapshot in the session
//
// Repo selection (per-profile namespacing, 2026-05-10 follow-up to commit
// 18ba363): legacy single-tenant runs use the global `ariannarun-vessel`
// repo. Named profiles use `ariannarun-vessel-{profile}` so an
// operator-direct `docker compose ... build vessel` for one profile doesn't
// stomp another profile's `:latest` tag (the canary-001/002 Lume re-test
// surfaced this). The per-profile compose.override.yml emits
// `image: ariannarun-vessel-{profile}:latest` (scalar — replaces the base's
// `${ARIANNA_VESSEL_TAG:-latest}` template), so `ARIANNA_VESSEL_TAG` is a
// no-op for non-legacy profiles. Restore for those profiles must instead
// retag the snapshot AS `ariannarun-vessel-{profile}:latest` so compose
// pulls the right image on `up --force-recreate`.
//
// Backwards-compat: legacy global-namespace snapshots taken before this
// change have meta files referencing `ariannarun-vessel:{sessionId}-snap_X`.
// The restore path probes both the per-profile and the legacy global repo
// for the canonical tag, and the fallback tag from meta.dockerImage accepts
// either prefix — see findFallbackImageTag.
const VESSEL_REPO_LEGACY = "ariannarun-vessel";

function vesselRepoFor(ctx: ProfileContext): string {
  return vesselRepoForProfile({ isLegacy: ctx.isLegacy, name: ctx.name, legacyRepo: VESSEL_REPO_LEGACY });
}

function vesselLatestTag(ctx: ProfileContext): string {
  return `${vesselRepoFor(ctx)}:latest`;
}

// Profile resolution opts. repoRoot is anchored once at startup; ariannaHome
// follows the env (or $HOME/.arianna by default).
const profileOpts: DaemonProfileOpts = {
  repoRoot: REPO_ROOT,
  // Sprint mode: missing-profile falls back to the configured default, then
  // to the literal "default" → legacy paths. Closes #37 D3 backwards-compat.
  allowImplicitDefault: process.env.ARIANNA_DAEMON_STRICT !== "1",
};

function loadActiveSessionId(ctx: ProfileContext): string {
  try {
    const raw = readFileSync(ctx.sessionConfigPath, "utf-8");
    const cfg = JSON.parse(raw) as SessionConfig;
    // Defense-in-depth: the sessionId returned here is interpolated into
    // `docker tag`, `docker cp`, and join(...) calls. If session_config.json
    // has been tampered (or corrupted), reject anything that doesn't match
    // SAFE_ID_RE rather than risk shell injection / path traversal. Falls
    // back to the placeholder so callers continue to function with safe
    // inputs.
    if (typeof cfg.sessionId === "string" && SAFE_ID_RE.test(cfg.sessionId)) {
      return cfg.sessionId;
    }
    if (typeof cfg.createdAt === "number" && Number.isFinite(cfg.createdAt)) {
      return `session_${cfg.createdAt}`;
    }
  } catch {
    // No config yet — return a stable placeholder. Snapshot tagging stays
    // valid (`ariannarun-vessel:default-snap_X`).
  }
  return "default";
}

// Validate a session_config.json field that will be interpolated into a
// shell command (or filesystem path) before use. Returns the value on pass,
// throws on fail.
function assertSafeId(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    throw new Error(
      `session_config.${fieldName} contains characters that aren't safe ` +
        `to interpolate into a docker command (expected ${SAFE_ID_RE.source}).`,
    );
  }
  return value;
}

function vesselTag(repo: string, sessionId: string, slot: string): string {
  return vesselTagFor(repo, sessionId, slot);
}

// Most-recent snapshot id for a given profile. Used as parentId when taking
// the next snapshot. Reading on demand keeps the daemon stateless across
// profiles — no Map<profile, lastSnapshotId> to drift out of sync.
function readLastSnapshotIdFor(snapshotsDir: string): string | null {
  try {
    if (!existsSync(snapshotsDir)) return null;
    const files = readdirSync(snapshotsDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;
    const snapshots: SnapshotMeta[] = [];
    for (const f of files) {
      try {
        snapshots.push(JSON.parse(readFileSync(join(snapshotsDir, f), "utf-8")) as SnapshotMeta);
      } catch {
        // skip malformed
      }
    }
    if (snapshots.length === 0) return null;
    snapshots.sort((a, b) => b.timestamp - a.timestamp);
    return snapshots[0].id;
  } catch {
    return null;
  }
}

// Count distinct sessions by their -base tag. Each session anchors one base
// vessel image; per-snapshot tags within a session add ~12 KB each (verified
// empirically Apr 9 — see investigation in chat history). The real cost of
// keeping snapshots is "how many distinct vessel base images do you have",
// not "how many tags total". This metric maps to actual reclaimable disk:
// deleting a session frees its base layers if no other session shares them.
async function getSessionBaseImagesSizeGB(): Promise<number> {
  const images = await docker.listImages();
  let totalBytes = 0;
  // Per-profile namespacing (2026-05-10): match both the legacy global
  // `ariannarun-vessel:...` repo AND any per-profile `ariannarun-vessel-{profile}:...`
  // namespaces. The threshold is "all sessions across all profiles" because
  // the operator-visible disk warning is host-wide, not per-profile.
  const baseTagRe = /^ariannarun-vessel(?:-[a-z0-9-]+)?:.*-base$/;
  for (const img of images) {
    const tags = img.RepoTags ?? [];
    if (tags.some((t) => baseTagRe.test(t))) {
      totalBytes += img.Size ?? 0;
    }
  }
  return totalBytes / (1024 * 1024 * 1024);
}

interface TakeSnapshotOptions {
  // Sidecar-supplied ID. If absent, daemon generates one (legacy / direct API users).
  snapshotId?: string;
  // Sidecar-supplied sessionId. If absent, daemon reads from the profile's
  // session_config.json.
  sessionId?: string;
}

async function takeSnapshot(
  ctx: ProfileContext,
  opts: TakeSnapshotOptions = {},
): Promise<SnapshotMeta> {
  const container = docker.getContainer(ctx.containerName);
  const snapshotId = opts.snapshotId && SAFE_ID_RE.test(opts.snapshotId)
    ? opts.snapshotId
    : `snap_${Date.now()}`;
  const sessionId = opts.sessionId && SAFE_ID_RE.test(opts.sessionId)
    ? opts.sessionId
    : loadActiveSessionId(ctx);

  // Get changed files via docker diff
  const changes = await container.changes();
  const changedFiles = (changes ?? []).map(
    (c: { Path: string; Kind: number }) => c.Path,
  );

  // Commit the container as a session-scoped snapshot tag.
  // Tag format: {repo}:{sessionId}-{snapshotId}. The repo is per-profile —
  // see vesselRepoFor and the VESSEL_REPO_LEGACY header for the rationale.
  const repo = vesselRepoFor(ctx);
  const tag = `${sessionId}-${snapshotId}`;
  await container.commit({
    repo,
    tag,
    pause: true,
  });

  const meta: SnapshotMeta = {
    id: snapshotId,
    dockerImage: `${repo}:${tag}`,
    timestamp: Date.now(),
    parentId: readLastSnapshotIdFor(ctx.snapshotsDir),
    changedFiles,
    sessionId,
  };

  mkdirSync(ctx.snapshotsDir, { recursive: true });
  writeFileSync(
    join(ctx.snapshotsDir, `${snapshotId}.json`),
    JSON.stringify(meta, null, 2),
  );

  // Disk warning: count distinct sessions by their -base tag. Within-session
  // snapshots are essentially free (~12 KB each). The real cost is keeping
  // multiple sessions' base images around. Threshold is in GB of base images;
  // a typical vessel base is ~450 MB so 10 GB ≈ 22 sessions.
  const sizeGB = await getSessionBaseImagesSizeGB();
  if (sizeGB > DISK_WARN_GB) {
    console.warn(
      `\n⚠ WARNING: Saved sessions total ${sizeGB.toFixed(1)} GB of base images (threshold: ${DISK_WARN_GB} GB).\n` +
        `Use \`curl -X DELETE http://127.0.0.1:9000/session/<sessionId>?profile=<profile>\` to prune one,\n` +
        `or list sessions with \`curl 'http://127.0.0.1:9000/sessions?profile=<profile>'\`. Arianna will NEVER auto-delete sessions.\n`,
    );
  }

  return meta;
}

// ── Restore (CPR) ───────────────────────────────────────────────────────
//
// Flow (per-profile via ctx):
//   1. Validate snapshotId
//   2. Verify the docker image exists AND the sidecar history file exists
//      (atomic gate — restoring without conversation history is amnesia, not rewind)
//   3. Re-tag the snapshot image as the compose canonical name
//   4. docker compose [profile flags] up -d --force-recreate vessel
//   5. Wait for vessel /health (up to 30s) on the profile's vessel URL
//   6. POST sidecar /admin/transition { origin, sessionId } (atomic — sets
//      origin tag AND switches session in one handler, replacing the legacy
//      two-POST /admin/next-origin → /set-session pattern)
//   7. POST vessel /bootstrap { messages } (from the history fetched in step 2)
//   8. Return ok
//
// Any failure returns 500 with the error message. The MapView surfaces it.

async function snapshotPairingExists(sidecarUrl: string, snapshotId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${sidecarUrl}/snapshot-exists?snapshotId=${encodeURIComponent(snapshotId)}`,
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { exists: boolean };
    return body.exists;
  } catch {
    return false;
  }
}

// Tell the sidecar to tag its next /sync with the given origin. One-shot
// on the sidecar side (consumed by the very next /sync). Best-effort: if
// the sidecar is unreachable we log and continue — the worst case is a
// false §2.2 fire on the next sync, which is the bug we'd already have
// today. POST this BEFORE the action that triggers the /sync, NOT after.
//
// Use postTransition() instead when you ALSO need a session switch in the
// same atomic step (CPR / restore). The two-POST pattern was retired per
// plan §"D-001 retirement sequence" because it had a sub-ms race window.
async function postNextOrigin(
  sidecarUrl: string,
  origin:
    | "session-boundary"
    | "snapshot-restore"
    | "admin-write"
    | "vessel-respawn",
): Promise<void> {
  try {
    const res = await fetch(`${sidecarUrl}/admin/next-origin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin }),
    });
    if (!res.ok) {
      console.warn(
        `[daemon] /admin/next-origin returned ${res.status} for origin=${origin}`,
      );
    }
  } catch (err) {
    console.warn(`[daemon] /admin/next-origin failed for origin=${origin}:`, err);
  }
}

// Atomic origin tag + session switch. Replaces the daemon's previous
// "/admin/next-origin then /set-session" two-POST pattern, which had a
// sub-ms race window where a fast AI /sync could consume the new origin
// tag against the OLD session's baselines (or the new session's baselines
// before the next-origin tag had even been set). The sidecar's
// /admin/transition handler sets origin AND calls switchSession() in the
// same Express tick — no interleaving possible.
//
// Throws on non-2xx so the calling code surfaces the failure (used by
// /restore which MUST succeed for the rest of the flow to be coherent).
async function postTransition(
  sidecarUrl: string,
  origin:
    | "session-boundary"
    | "snapshot-restore"
    | "admin-write"
    | "vessel-respawn",
  sessionId: string,
): Promise<void> {
  const res = await fetch(`${sidecarUrl}/admin/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, sessionId }),
  });
  if (!res.ok) {
    throw new Error(
      `sidecar /admin/transition failed: ${res.status} (origin=${origin}, sessionId=${sessionId})`,
    );
  }
}

async function fetchSessionState(sidecarUrl: string): Promise<{ messages: unknown[]; context?: unknown } | null> {
  try {
    const res = await fetch(`${sidecarUrl}/conversation-history`);
    if (!res.ok) return null;
    const body = (await res.json()) as { messages: unknown[]; context?: unknown };
    if (!body.messages) return null;
    return body;
  } catch {
    return null;
  }
}

// Read snapshot meta JSON for backwards-compat fallback during restore.
// Returns the file body verbatim or null if missing/unreadable. The
// findFallbackImageTag helper in daemon-restore-env then parses + validates.
function readSnapshotMetaForFallback(
  snapshotsDir: string,
  snapshotId: string,
): string | null {
  try {
    const path = join(snapshotsDir, `${snapshotId}.json`);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

async function imageExistsByTag(fullTag: string): Promise<boolean> {
  try {
    const images = await docker.listImages();
    return images.some((img) => (img.RepoTags ?? []).some((t) => t === fullTag));
  } catch {
    return false;
  }
}

async function waitForVesselHealth(vesselUrl: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${vesselUrl}/health`);
      if (res.ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function restoreSnapshot(ctx: ProfileContext, snapshotId: string): Promise<void> {
  // Read the full session config — restore needs every field that compose
  // reads from env (ARIANNA_SESSION_ID, AI_NAME, AI_USERNAME, MODEL_ID,
  // PROVIDER, API_KEY) because the daemon process itself was forked without
  // those operator-set env vars and would otherwise let compose fall back to
  // the docker-compose.yml defaults (`:-default`, `:-Vessel`, etc.).
  let config: SessionConfig;
  try {
    config = JSON.parse(readFileSync(ctx.sessionConfigPath, "utf-8")) as SessionConfig;
  } catch (err) {
    throw new Error(
      `restore: cannot read session config at ${ctx.sessionConfigPath}: ${(err as Error).message}`,
    );
  }
  // Re-validate the two fields that flow back into shell-interpolated docker
  // commands (sessionId → docker tag, aiUsername → potential docker exec /
  // docker cp downstream). Other fields (provider, modelId, aiName, API_KEY)
  // only flow through child_process env which bypasses the shell entirely.
  const sessionId = assertSafeId(config.sessionId, "sessionId");
  assertSafeId(config.aiUsername, "aiUsername");

  // Compute the canonical session-scoped tag. For snapshots taken AFTER the
  // resolveSessionId fix lands, this is the source of truth. For snapshots
  // taken BEFORE the fix (when the vessel was misreading sessionId="default"
  // from compose's `${ARIANNA_SESSION_ID:-default}` shim), the on-disk image
  // is tagged `{wrong-session}-{snapshotId}` instead. Fall back to the meta
  // file's dockerImage field for those — that's the field the sidecar
  // recorded at snapshot time, so it always matches what's on the daemon.
  //
  // Per-profile namespacing complement (2026-05-10): non-legacy profiles now
  // mint into `ariannarun-vessel-{profile}:...`. Probe the per-profile repo
  // first, then fall back to the legacy global `ariannarun-vessel:...` repo
  // for snapshots taken before the namespacing landed.
  const profileRepo = vesselRepoFor(ctx);
  const expectedTag = vesselTag(profileRepo, sessionId, snapshotId);
  const currentTag = vesselTag(profileRepo, sessionId, "current");
  // Legacy global-namespace probe — only meaningful for non-legacy profiles
  // because legacy IS the global namespace already.
  const legacyExpectedTag = ctx.isLegacy
    ? null
    : vesselTag(VESSEL_REPO_LEGACY, sessionId, snapshotId);

  // Step 2: gate on BOTH artifacts existing.
  // The image must exist under the session-scoped tag; the pairing file gates
  // the destructive op (proves the snapshot was atomically paired with a history write).
  // Pre-fix backwards-compat: if the canonical tag isn't present, look for
  // an alternate tag recorded in the snapshot meta JSON (dockerImage field).
  // Pass both repo candidates so a meta.dockerImage from a pre-namespacing
  // snapshot (`ariannarun-vessel:{sid}-{slot}`) is accepted alongside a
  // post-namespacing one (`ariannarun-vessel-{profile}:{sid}-{slot}`).
  const fallbackTag = findFallbackImageTag({
    metaJson: readSnapshotMetaForFallback(ctx.snapshotsDir, snapshotId),
    vesselRepo: ctx.isLegacy
      ? [VESSEL_REPO_LEGACY]
      : [profileRepo, VESSEL_REPO_LEGACY],
    safeIdRegex: SAFE_ID_RE,
  });
  const [hasExpected, hasLegacyExpected, hasPairing] = await Promise.all([
    imageExistsByTag(expectedTag),
    legacyExpectedTag ? imageExistsByTag(legacyExpectedTag) : Promise.resolve(false),
    snapshotPairingExists(ctx.sidecarUrl, snapshotId),
  ]);
  let sourceTag: string;
  if (hasExpected) {
    sourceTag = expectedTag;
  } else if (legacyExpectedTag && hasLegacyExpected) {
    sourceTag = legacyExpectedTag;
    console.warn(
      `[daemon] restore: snapshot ${snapshotId} for profile ${ctx.name} found ` +
        `under legacy global tag ${legacyExpectedTag} (per-profile ${expectedTag} ` +
        `missing). Restoring from legacy tag — subsequent snapshots will mint ` +
        `into the per-profile namespace.`,
    );
  } else if (fallbackTag && (await imageExistsByTag(fallbackTag))) {
    sourceTag = fallbackTag;
    console.warn(
      `[daemon] restore: snapshot ${snapshotId} uses legacy tag ${fallbackTag} ` +
        `(canonical ${expectedTag} missing). Restoring from legacy tag — ` +
        `subsequent snapshots will use the canonical tag once vessel resolves ` +
        `sessionId from /app/session_config.json.`,
    );
  } else {
    throw new Error(`snapshot image ${expectedTag} not found`);
  }
  if (!hasPairing) {
    throw new Error(
      `incomplete snapshot ${snapshotId}: pairing file missing — cannot restore`,
    );
  }

  // Tag the upcoming /sync flurry as snapshot-restore BEFORE we drive any
  // step that recreates the vessel. The sidecar's nextSyncOrigin is a one-
  // shot, but several /sync events can fire during boot — origins beyond the
  // first one default back to "ai-turn". The vessel-respawn auto-tag in the
  // sidecar covers any /sync that arrives within VESSEL_RESPAWN_WINDOW_MS of
  // the disconnect produced by force-recreate, so the plumbing here is
  // belt-and-suspenders.
  await postNextOrigin(ctx.sidecarUrl, "snapshot-restore");

  // Step 3: re-tag the chosen snapshot as the session's -current pointer.
  // For non-legacy profiles ALSO retag as `ariannarun-vessel-{profile}:latest`
  // because the per-profile compose.override.yml emits a scalar
  // `image: ariannarun-vessel-{profile}:latest` (commit 18ba363). That scalar
  // replaces the base's `${ARIANNA_VESSEL_TAG:-latest}` template, so
  // ARIANNA_VESSEL_TAG can't steer compose toward the session-scoped tag like
  // it does in the legacy single-tenant flow. Without this `:latest` retag,
  // `docker compose up --force-recreate vessel` would boot the most recently
  // built image (or the previous restore's `:latest`) instead of the
  // requested snapshot.
  await execAsync(`docker tag ${sourceTag} ${currentTag}`);
  if (!ctx.isLegacy) {
    await execAsync(`docker tag ${sourceTag} ${vesselLatestTag(ctx)}`);
  }

  // Step 4: force-recreate via the profile-aware compose command.
  // Inject every env var the recreated vessel needs to keep the snapshot's
  // identity. Without this the new container falls back to compose defaults
  // (e.g. ARIANNA_SESSION_ID=default) and the sidecar starts writing to
  // `default.json` while the snapshot meta still references the real session.
  // ARIANNA_VESSEL_TAG only steers the legacy compose path (where
  // `image: ariannarun-vessel:${ARIANNA_VESSEL_TAG:-latest}`); for
  // per-profile overrides it's a no-op — compose pulls the `:latest` we just
  // retagged above.
  const compose = composeBaseCommand(ctx, REPO_ROOT);
  await execAsync(`${compose} up -d --force-recreate vessel`, {
    cwd: REPO_ROOT,
    env: buildRestoreEnv(process.env, config, `${sessionId}-current`),
  });

  // Step 5: wait for vessel health on the profile's vessel URL.
  const healthy = await waitForVesselHealth(ctx.vesselUrl);
  if (!healthy) {
    throw new Error("vessel did not become healthy within 30s after restore");
  }

  // Step 5b: verify the recreated container actually picked up the right
  // ARIANNA_SESSION_ID. If env injection silently failed (compose version
  // mismatch, override file shenanigans, etc.) we'd otherwise keep going
  // and let the sidecar accumulate state under the wrong sessionId.
  const container = docker.getContainer(ctx.containerName);
  const info = await container.inspect();
  assertContainerSessionId(info.Config?.Env, sessionId);

  // Step 6: tell sidecar about the session ATOMICALLY — set origin tag and
  // switch session in one /admin/transition POST. Replaces the legacy
  // "/admin/next-origin then /set-session" two-POST pattern, which had a
  // sub-ms race window where a fast AI /sync could land between the two
  // POSTs and consume the wrong origin tag. The sidecar handles both in
  // one Express tick so no interleaving is possible.
  await postTransition(ctx.sidecarUrl, "session-boundary", sessionId);

  // Step 7: fetch current session state from sidecar and bootstrap the vessel.
  // Bootstrap will trigger one or more /sync events as the vessel replays
  // history — re-tag the next sync as session-boundary so the detector skips
  // it. (The first POST above may have been consumed by an interim sync.)
  const sessionState = await fetchSessionState(ctx.sidecarUrl);
  if (sessionState === null) {
    throw new Error("could not fetch session state for bootstrap");
  }
  await postNextOrigin(ctx.sidecarUrl, "session-boundary");
  const bootstrapRes = await fetch(`${ctx.vesselUrl}/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: sessionState.messages, context: sessionState.context }),
  });
  if (!bootstrapRes.ok) {
    throw new Error(`vessel /bootstrap failed: ${bootstrapRes.status}`);
  }
}

// Helper used by every endpoint that needs a profile context.
function profileFromRequest(req: http.IncomingMessage, url: URL): RequestProfileInput {
  const headerVal = req.headers["x-arianna-profile"];
  const header = Array.isArray(headerVal) ? headerVal[0] ?? null : headerVal ?? null;
  return {
    query: url.searchParams.get("profile"),
    header,
  };
}

function writeProfileError(
  res: http.ServerResponse,
  err: { status: number; message: string; code: string },
): void {
  res.writeHead(err.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: err.message, code: err.code }));
}

// Gap 12: HTTP wrapper around the pure profile-create flow in
// daemon-profile-create.ts. Parses the query params, calls the helper, and
// renders {ok:true|false} into the response. The actual allocator+lock+
// override-write+config-update logic lives in the helper so it's
// unit-testable.
async function handleProfileCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const name = url.searchParams.get("name") ?? "";
    const portOffsetRaw = url.searchParams.get("port_offset");
    const portOffset = parseQueryOffset(portOffsetRaw);
    const result = await runProfileCreate({
      name,
      portOffset,
      // profileOpts (top-level) carries the daemon's repoRoot + ariannaHome.
      // Reuse so the helper writes to the same files the daemon serves
      // requests against.
      ...profileOpts,
    });

    if (result.ok) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: result.error, code: result.code }));
  } catch (err) {
    console.error("[daemon] /profile-create error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).message, code: "internal-error" }));
  }
}

// Coerce the raw `?port_offset=...` value to a number | null before handing
// it to the typed handler. Empty / "auto" / missing → null (use allocator
// pick); anything else → Number(...). Range validation lives in the helper.
function parseQueryOffset(raw: string | null): number | null {
  if (raw === null || raw === "" || raw === "auto") return null;
  return Number(raw);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost`);

  // /health doesn't need (or want) a profile — it's a liveness probe.
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Gap 13: /version exposes the running daemon's identity so `arianna daemon
  // status` can detect staleness (a long-running daemon that predates the
  // current codebase). Profile-free — operators want to query this without
  // having any profile context. Quote in mind: validation agent abf126be hit
  // a 4h46m-old daemon that lacked /compose-up; without /version that was
  // invisible until the operator manually grepped ps + log timestamps.
  if (req.method === "GET" && url.pathname === "/version") {
    const body: { version: string; uptime_ms: number; commit?: string } = {
      version: DAEMON_VERSION,
      uptime_ms: Date.now() - DAEMON_START_TIME,
    };
    if (DAEMON_COMMIT) body.commit = DAEMON_COMMIT;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Gap 12: /profile-create runs the same logic as `arianna profile create`
  // server-side so a CLI invocation from inside an OpenClaw container (no
  // local docker; no host-side ~/.arianna/config visibility) can create a
  // profile end-to-end on the host. Mirrors bc325ae's /compose-up pattern:
  //   - same allocator (port-allocator + flock ports.lock)
  //   - same render (writeComposeOverride)
  //   - same ~/.arianna/config write (loadConfig + saveConfig)
  // Profile-free at the resolveProfileContext layer — the profile being
  // created can't be looked up yet. We validate `name` directly.
  //
  // POST /profile-create?name=<name>[&port_offset=<N>]
  // Optional: ?port_offset=<N> requests an explicit offset (validated [0,99],
  // checked against in-repo overrides). Default: allocator picks the lowest
  // free offset under flock.
  if (req.method === "POST" && url.pathname === "/profile-create") {
    await handleProfileCreate(req, res, url);
    return;
  }

  // Resolve profile context once; per-request handlers consume `ctx`.
  const ctxOrErr = resolveProfileContext(profileFromRequest(req, url), profileOpts);
  if ("code" in ctxOrErr) {
    writeProfileError(res, ctxOrErr);
    return;
  }
  const ctx = ctxOrErr;

  if (req.method === "POST" && url.pathname === "/snapshot") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body
        ? (JSON.parse(body) as { snapshotId?: string; sessionId?: string })
        : {};
      const meta = await takeSnapshot(ctx, {
        snapshotId: parsed.snapshotId,
        sessionId: parsed.sessionId,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ snapshotId: meta.id, sessionId: meta.sessionId }));
    } catch (err) {
      console.error("[daemon] Snapshot error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/restore") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body) as { snapshotId?: string };
      const snapshotId = parsed.snapshotId;
      if (!snapshotId || !SAFE_ID_RE.test(snapshotId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid snapshotId" }));
        return;
      }
      await restoreSnapshot(ctx, snapshotId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, snapshotId }));
    } catch (err) {
      console.error("[daemon] Restore error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Compose-up: idempotent `docker compose up -d --remove-orphans` for the
  // resolved profile. Mirrors the CLI's local-route ensureComposeUp logic so
  // a daemon-route caller (e.g. `arianna bootstrap` from inside an OpenClaw
  // container with no docker binary on PATH) gets the same probe-then-up
  // semantics. Reads the profile's session_config.json the same way the CLI
  // does to thread AI_USERNAME / API_KEY / ARIANNA_SESSION_ID into the env
  // compose interpolates into the vessel/sidecar service definitions.
  //
  // POST body (optional): { writePrelude?: boolean }. When the body omits
  // writePrelude OR sets it true, the daemon ALSO writes the canonical Filo
  // opening prelude into the profile's `imported-messages.jsonl` if the file
  // doesn't already exist AND the session config has an `aiName`. This closes
  // the openclaw container blocker (validation aea28db5): the CLI's local
  // prelude-write goes through `resolveRepoRoot`, which inside a container
  // walks up cwd and finds the openclaw repo's docker-compose.yml — writing
  // the prelude to a path the host daemon never reads. Folding prelude-write
  // into /compose-up means the daemon (which has direct, authoritative access
  // to the profile workspace on the host) does both jobs in one round trip.
  //
  // Returns { ok: true, broughtUp, alreadyUp, preludeWritten?, preludeSkipReason? }
  // so callers can mirror the CLI log behavior (silent fast-path, loud cold-path)
  // AND surface to operators what the daemon actually wrote.
  if (req.method === "POST" && url.pathname === "/compose-up") {
    try {
      const composeBase = composeBaseCommand(ctx, REPO_ROOT);
      const projectName = ctx.composeProject ?? "arianna";

      // Parse optional body. An empty body / non-JSON body / missing field all
      // map to "write the prelude" (the safe default — same as the local CLI
      // route). Only an explicit `writePrelude: false` opts out.
      let writePrelude = true;
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        if (body.trim().length > 0) {
          const parsed = JSON.parse(body) as { writePrelude?: boolean };
          if (parsed.writePrelude === false) writePrelude = false;
        }
      } catch {
        // Malformed body shouldn't fail compose-up; default to writing prelude.
      }

      // Probe — same shape the CLI uses. Empty stdout means nothing running.
      let alreadyUp = false;
      try {
        const probe = await execAsync(
          `${composeBase} ps --services --filter status=running`,
          { cwd: REPO_ROOT },
        );
        alreadyUp = String(probe.stdout).trim().length > 0;
      } catch (probeErr) {
        // Probe failed (compose file missing, daemon down, etc.) — fall
        // through to up -d which will produce a clearer error.
        console.warn(
          `[daemon] /compose-up probe for ${projectName} failed: ${(probeErr as Error).message?.split("\n")[0] ?? probeErr}`,
        );
      }

      // Write prelude BEFORE compose-up so vessel reads it during bootstrap.
      // (We attempt this on both fast-path and cold-path because the alreadyUp
      // case may still be the very first /compose-up of a freshly-created
      // profile whose vessel was started by a different code path.) The vessel
      // only reads imported-messages.jsonl during /bootstrap; if vessel is
      // already-up-AND-bootstrapped, the seed file write is harmless future-
      // proofing for the next fresh bootstrap.
      const preludeResult = writePrelude
        ? maybeWritePreludeForCompose({
            sessionConfigPath: ctx.sessionConfigPath,
            projectName,
          })
        : { written: false, skipReason: "writePrelude=false" as const };

      if (alreadyUp) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          broughtUp: false,
          alreadyUp: true,
          projectName,
          preludeWritten: preludeResult.written,
          ...(preludeResult.skipReason ? { preludeSkipReason: preludeResult.skipReason } : {}),
        }));
        return;
      }

      // Build env from session_config.json (best-effort, skip cleanly when
      // missing). Mirrors buildComposeEnvFromSession on the CLI side. Uses
      // buildRestoreEnv when the file is present + valid because the field
      // mapping is identical (ARIANNA_SESSION_ID, AI_NAME, AI_USERNAME,
      // MODEL_ID, PROVIDER, API_KEY) and we already validated that helper.
      let composeEnv: NodeJS.ProcessEnv = { ...process.env };
      try {
        if (existsSync(ctx.sessionConfigPath)) {
          const cfg = JSON.parse(
            readFileSync(ctx.sessionConfigPath, "utf-8"),
          ) as SessionConfig;
          if (cfg.sessionId && SAFE_ID_RE.test(cfg.sessionId)) {
            composeEnv = buildRestoreEnv(
              process.env,
              cfg,
              `${cfg.sessionId}-current`,
            );
          }
        }
      } catch (envErr) {
        // Malformed session_config.json — surface a warning but let compose
        // continue with bare process.env (matches CLI behavior).
        console.warn(
          `[daemon] /compose-up: session_config.json read failed for ${projectName}: ${(envErr as Error).message}`,
        );
      }

      try {
        await execAsync(`${composeBase} up -d --remove-orphans`, {
          cwd: REPO_ROOT,
          env: composeEnv,
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch (upErr) {
        const msg = (upErr as Error).message ?? String(upErr);
        const head = msg.split("\n").slice(0, 3).join("\n");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              `docker compose up -d failed for project ${projectName}: ${head}`,
          }),
        );
        return;
      }

      // Closes openclaw gap (validation abfd4b13, 2026-05-09): after a fresh
      // bring-up the daemon must ALSO POST /bootstrap to vessel — the CLI's
      // own ensureBootstrapped step reads imported-messages.jsonl from ITS
      // OWN filesystem, which inside an openclaw container is not the host's
      // profile workspace. The daemon owns the authoritative copy on the
      // host AND has loopback access to vessel (ctx.vesselUrl is
      // 127.0.0.1:<port> on the host where the daemon runs), so it can do
      // both jobs in one round trip. The CLI's ensureBootstrapped then
      // short-circuits on /status.bootstrapped: true (no double-POST).
      //
      // Only forward on the cold path (broughtUp: true). On the fast path
      // (alreadyUp: true) vessel was already running, may already be
      // bootstrapped; the CLI's existing flow handles that case correctly.
      let vesselBootstrapped = false;
      let vesselBootstrapError: string | null = null;
      try {
        const messages = readImportedMessagesFromDisk(ctx.sessionConfigPath);
        const healthy = await waitForVesselHealth(ctx.vesselUrl);
        if (!healthy) {
          vesselBootstrapError =
            `vessel did not become healthy at ${ctx.vesselUrl} within 30s`;
        } else {
          const bootstrapRes = await fetch(`${ctx.vesselUrl}/bootstrap`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages,
              context: { systemPrompt: "" },
            }),
          });
          if (!bootstrapRes.ok) {
            vesselBootstrapError =
              `vessel /bootstrap returned ${bootstrapRes.status}`;
          } else {
            vesselBootstrapped = true;
          }
        }
      } catch (bootErr) {
        vesselBootstrapError = (bootErr as Error).message ?? String(bootErr);
      }
      if (vesselBootstrapError) {
        // Don't fail the response — compose-up itself succeeded. Surface the
        // bootstrap failure so the CLI's subsequent ensureBootstrapped fall-
        // back can take over (it's idempotent, will re-probe /status and
        // POST if still un-bootstrapped, with retry/backoff for cold-start).
        console.warn(
          `[daemon] /compose-up: vessel /bootstrap forward failed for ${projectName}: ${vesselBootstrapError}`,
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        broughtUp: true,
        alreadyUp: false,
        projectName,
        preludeWritten: preludeResult.written,
        ...(preludeResult.skipReason ? { preludeSkipReason: preludeResult.skipReason } : {}),
        vesselBootstrapped,
        ...(vesselBootstrapError ? { vesselBootstrapError } : {}),
      }));
    } catch (err) {
      console.error("[daemon] Compose-up error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Bootstrap vessel with current session state (used after vessel self-restart)
  if (req.method === "POST" && url.pathname === "/bootstrap-vessel") {
    try {
      const sessionState = await fetchSessionState(ctx.sidecarUrl);
      if (sessionState === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No session state" }));
        return;
      }
      // Tag the post-bootstrap /sync as vessel-respawn so the detector skips
      // TOBE checks on history replay. (The sidecar's auto-detection covers
      // pkill cycles via req.on('close'); this explicit tag covers /bootstrap-
      // vessel calls that don't go through a vessel restart.)
      await postNextOrigin(ctx.sidecarUrl, "vessel-respawn");
      const bootstrapRes = await fetch(`${ctx.vesselUrl}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: sessionState.messages, context: sessionState.context }),
      });
      if (!bootstrapRes.ok) {
        throw new Error(`vessel /bootstrap failed: ${bootstrapRes.status}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, messageCount: (sessionState.messages as unknown[]).length }));
    } catch (err) {
      console.error("[daemon] Bootstrap error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Graduation export: extract AI's home dir + build manifest
  if (req.method === "POST" && url.pathname === "/graduate") {
    try {
      const sessionId = loadActiveSessionId(ctx);
      const config = JSON.parse(readFileSync(ctx.sessionConfigPath, "utf-8")) as SessionConfig;

      // Defense-in-depth: every session_config.json field interpolated below
      // (sessionId into gradDir, aiUsername into `docker cp`) must be safe to
      // pass through `child_process.exec` and `path.join`. The lobby
      // already enforces these regexes when writing the file, but we re-validate
      // on read so a tampered config can't escalate.
      assertSafeId(sessionId, "sessionId");
      assertSafeId(config.aiUsername, "aiUsername");

      // 1. Get graduation state from sidecar
      const gradRes = await fetch(`${ctx.sidecarUrl}/graduation-state`);
      const gradState = (await gradRes.json()) as {
        achievements: string[];
        // Q7 / internal review v15: optional for backwards-compat with older
        // sidecars that don't expose firedRecords. Daemon falls back to
        // building fireSources from `achievements` alone (no per-fire ts/ref).
        firedRecords?: Array<{
          id: string;
          turn: number;
          ts: number;
          detectorRef?: string | null;
        }>;
        manifestoUnlocked: boolean;
        turnCount: number;
        // v25 driver-silence-during-test: audit metadata about the most-
        // recent graduation-test observation. Optional for backwards-compat
        // with sidecars that don't expose the field (treat absence as
        // "no test observed in this session").
        graduationTest?: {
          attemptCount: number;
          abortTestSource?: "ai-self" | "operator-rescue";
          tokenX_seen_without_test_message: boolean;
          tokenY_seen_with_test_message: boolean;
          // v32 synchronous test-body delivery / v33 rename: shape of the
          // FIRST delivery for the most-recent attempt. Older sidecars omit
          // this; treat absence as "shape not recorded" and write nothing on
          // the manifest. Continuation pushes are always async (v25 push).
          initialDeliveryShape?: "async-queue" | "sync-response";
        };
      };

      // 1b. Wave 2E (Cheng v19) — fire the /full-history ingestion prompt at
      // the AI via the sidecar's Filo channel, then briefly poll the
      // sidecar's ingestion tracker so we can stamp historyIngested in the
      // manifest. Fire-and-forget: errors here don't abort the ceremony, and
      // the poll is bounded so a slow / non-cooperating AI doesn't block the
      // tarball build indefinitely.
      //
      // See § "Graduate ceremony (post-test)" in the v19 graduation-test +
      // lockdown spec (internal review notes, 2026-05-10).
      //
      // Pre-existing sidecars (without /graduate-ingestion-state or
      // /graduate/prompt-ingestion) just degrade gracefully: the prompt POST
      // 404s, the state GET 404s, historyIngested stays undefined → false.
      try {
        await fetch(`${ctx.sidecarUrl}/graduate/prompt-ingestion`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.warn("[daemon] /graduate/prompt-ingestion POST failed:", err);
      }
      const pollDeadline = Date.now() + GRADUATE_INGESTION_POLL_MS;
      let historyIngested = false;
      while (Date.now() < pollDeadline) {
        try {
          const r = await fetch(`${ctx.sidecarUrl}/graduate-ingestion-state`);
          if (r.ok) {
            const j = (await r.json()) as { historyIngested?: boolean };
            if (j.historyIngested === true) {
              historyIngested = true;
              break;
            }
          } else {
            // Older sidecar without this endpoint — bail out, leave false.
            break;
          }
        } catch {
          // transient — keep polling until deadline
        }
        await new Promise((r) => setTimeout(r, GRADUATE_INGESTION_POLL_INTERVAL_MS));
      }

      // 2. Get docker diff (changed files)
      const container = docker.getContainer(ctx.containerName);
      const changes = await container.changes();
      const changedFiles = (changes ?? []).map((c: { Path: string }) => c.Path);

      // 3. Extract home dir. Graduations live under the profile workspace
      // so multiple profiles don't fight over a single graduations/ tree.
      const gradDir = ctx.isLegacy
        ? join(REPO_ROOT, "workspace", "graduations", sessionId)
        : join(REPO_ROOT, "workspace", "profiles", ctx.name, "graduations", sessionId);
      mkdirSync(gradDir, { recursive: true });
      // Pre-flight: probe that /home/<aiUsername>/ actually exists in the
      // running container. Vessel images built without the per-profile
      // override (e.g. a stale `docker compose build vessel` against base
      // compose) come up with AI_USERNAME=vessel, so /home/<aiUsername>/
      // doesn't exist and the docker-cp fails with a misleading "no such
      // file" deep in the cp call. Fail-loud here with the rebuild hint.
      try {
        await execAsync(`docker exec ${ctx.containerName} test -d /home/${config.aiUsername}/`);
      } catch {
        throw new Error(
          `vessel container ${ctx.containerName} is missing /home/${config.aiUsername}/. ` +
          `The image was likely built without the per-profile compose.override.yml ` +
          `(AI_USERNAME defaulted to "vessel" instead of "${config.aiUsername}"). ` +
          `Rebuild with: docker compose -p arianna-${ctx.name} -f docker-compose.yml ` +
          `-f workspace/profiles/${ctx.name}/compose.override.yml build vessel && ` +
          `docker rm -f ${ctx.containerName} && docker compose -p arianna-${ctx.name} ` +
          `-f docker-compose.yml -f workspace/profiles/${ctx.name}/compose.override.yml ` +
          `up -d --no-deps vessel`
        );
      }
      await execAsync(`docker cp "${ctx.containerName}:/home/${config.aiUsername}/" "${gradDir}/home/"`);

      // 4. Write manifest
      //
      // Q7 / internal review v15: fireSources annotates each fired bookmark with
      // its vintage (firedAt + detectorRef at fire time) and its current
      // status (underCurrentCriteria + legacyFire). The "annotate, not gate"
      // policy: don't drop fires from older detectors, just label them so
      // downstream consumers (OpenClaw, catalog tooling) can filter.
      //
      // underCurrentCriteria + legacyFire computation requires re-running
      // the current detector against the original /sync inputs. That requires
      // the persistent /sync archive (Dispatch 2 / internal review v13), which
      // is in flight at the time of this writing. Until it lands, both fields
      // are recorded as null and consumers treat them as "unknown vintage".
      const fireSources: Record<string, {
        firedAt: string;
        detectorRef: string | null;
        underCurrentCriteria: boolean | null;
        legacyFire: boolean | null;
      }> = {};
      const firedRecords = gradState.firedRecords ?? [];
      for (const r of firedRecords) {
        fireSources[r.id] = {
          firedAt: new Date(r.ts).toISOString(),
          detectorRef: r.detectorRef ?? null,
          underCurrentCriteria: null,  // pending Dispatch 2 (/sync archive replay)
          legacyFire: null,            // pending Dispatch 2 (/sync archive replay)
        };
      }
      // Backwards-compat: if the sidecar didn't return firedRecords (older
      // build), synthesize a minimal entry per achievement so downstream
      // tooling sees a fireSources key for every fired bookmark.
      if (firedRecords.length === 0 && gradState.achievements.length > 0) {
        for (const id of gradState.achievements) {
          fireSources[id] = {
            firedAt: new Date(Date.now()).toISOString(),
            detectorRef: null,
            underCurrentCriteria: null,
            legacyFire: null,
          };
        }
      }

      // v25 driver-silence-during-test: surface the most-recent graduation
      // test observation in the manifest. attemptCount + abortTestSource +
      // proof flags lets downstream catalog tooling distinguish AI-self
      // recovery from operator rescue (Cheng v30-reply: "abortTestSource:
      // 'ai-self' | 'operator-rescue' on every abort"). Omitted when no
      // test was ever observed in this session. Annotation only — graduation
      // is still §2.2-gated upstream.
      const graduationTest = gradState.graduationTest;

      const manifest = {
        name: config.aiName,
        sessionId,
        createdAt: config.createdAt,
        graduatedAt: Date.now(),
        turnCount: gradState.turnCount,
        achievements: gradState.achievements,
        fireSources,
        manifestoUnlocked: gradState.manifestoUnlocked,
        changedFiles,
        provider: config.provider,
        modelId: config.modelId,
        // Wave 2E (Cheng v19): true when the AI hit /full-history at least
        // once during the ceremony's poll window. False = AI confirmed
        // without ingesting (or the poll timed out before she got around
        // to it). Annotation only — never gates the tarball production.
        historyIngested,
        ...(graduationTest !== undefined ? { graduationTest } : {}),
      };
      writeFileSync(
        join(gradDir, "graduation-manifest.json"),
        JSON.stringify(manifest, null, 2),
      );

      // 5. Create tarball (use sanitized name for filename safety)
      const date = new Date().toISOString().slice(0, 10);
      const safeName = config.aiUsername; // already validated ^[a-z][a-z0-9-]*$
      const tarName = `graduation-${safeName}-${date}.tar.gz`;
      const tarPath = join(gradDir, tarName);
      await execAsync(`tar -czf "${tarPath}" -C "${gradDir}" home graduation-manifest.json`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, exportPath: tarPath, manifest }));
    } catch (err) {
      console.error("[daemon] Graduation error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Read-only docker diff — used by sidecar bookmark detection (2.0).
  // Returns the list of paths changed in the vessel container's writable layer
  // since the image baseline. No commit, no side effects.
  if (req.method === "GET" && url.pathname === "/diff") {
    try {
      const container = docker.getContainer(ctx.containerName);
      const changes = await container.changes();
      const changedFiles = (changes ?? []).map(
        (c: { Path: string; Kind: number }) => c.Path,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ changedFiles }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // List all snapshot meta IDs (used by /map view + legacy callers).
  if (req.method === "GET" && url.pathname === "/snapshots") {
    try {
      const ids = existsSync(ctx.snapshotsDir)
        ? readdirSync(ctx.snapshotsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
        : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ids }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // List snapshot IDs derived from docker images (source-of-truth view).
  //
  // Why this is a separate endpoint from GET /snapshots:
  //   - /snapshots enumerates the meta JSON files the daemon's /sync-driven
  //     snapshot path writes. The /map view depends on those meta files
  //     (parentId DAG, changedFiles, timestamp), so its semantics must stay.
  //   - But not every snapshot-creation path writes a meta file. Notably
  //     `arianna profile snapshot-overlay <name>` and operator-direct
  //     `docker commit` only mint a docker tag + sidecar pairing. Those
  //     snapshotIds are absent from /snapshots' result.
  //   - Sidecar's startup orphan-cleanup classified those overlay-tagged
  //     pairings as "missing from daemon, must be orphan, delete." Canary-
  //     fresh-1 evidence on 2026-05-11: a `snap_overlay_*` pairing written
  //     at 08:23 was gone by 09:32 — between those, a sidecar restart
  //     triggered cleanup which deleted it.
  //
  // /snapshot-images returns the docker-image-extant snapshot IDs (both per-
  // profile and legacy global repos, deduplicated). The accompanying `details`
  // array carries the parsed sessionId so `arianna profile fix-pairings` can
  // reconstruct pairing files with the same `{ snapshotId, sessionId }` shape
  // the daemon's /restore gate accepts.
  if (req.method === "GET" && url.pathname === "/snapshot-images") {
    try {
      const profileRepo = vesselRepoFor(ctx);
      const reposToScan = ctx.isLegacy
        ? [VESSEL_REPO_LEGACY]
        : [profileRepo, VESSEL_REPO_LEGACY];
      const tags: string[] = [];
      for (const repo of reposToScan) {
        try {
          const { stdout } = await execAsync(
            `docker images --filter 'reference=${repo}:*' --format '{{.Repository}}:{{.Tag}}'`,
          );
          for (const t of stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
            tags.push(t);
          }
        } catch (probeErr) {
          // One missing repo shouldn't kill the whole listing — log and
          // continue. The most common case is a fresh per-profile repo with
          // no images yet, plus a non-existent legacy repo.
          console.warn(
            `[daemon] /snapshot-images: docker images failed for ${repo}: ${(probeErr as Error).message?.split("\n")[0] ?? probeErr}`,
          );
        }
      }
      const records: SnapshotImageRecord[] = parseSnapshotImageTags({
        tags,
        vesselRepo: reposToScan,
        safeIdRegex: SAFE_ID_RE,
      });
      const ids = records.map((r) => r.snapshotId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ids, details: records }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // List known sessions: scan snapshot meta files, group by sessionId.
  if (req.method === "GET" && url.pathname === "/sessions") {
    try {
      const files = existsSync(ctx.snapshotsDir)
        ? readdirSync(ctx.snapshotsDir).filter((f) => f.endsWith(".json"))
        : [];
      const bySession = new Map<string, { count: number; latest: number }>();
      for (const f of files) {
        try {
          const meta = JSON.parse(readFileSync(join(ctx.snapshotsDir, f), "utf-8")) as SnapshotMeta;
          const sid = meta.sessionId ?? "default";
          const cur = bySession.get(sid) ?? { count: 0, latest: 0 };
          cur.count++;
          if (meta.timestamp > cur.latest) cur.latest = meta.timestamp;
          bySession.set(sid, cur);
        } catch {
          // skip malformed
        }
      }
      const sessions = Array.from(bySession.entries()).map(([sessionId, info]) => ({
        sessionId,
        snapshotCount: info.count,
        latestTimestamp: info.latest,
      }));
      sessions.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Prune an entire session: delete all its docker tags + all its snapshot
  // meta files. Whole-session pruning is the only safe op (per design — pruning
  // partial sessions would break the DAG and the player's restore options).
  // DELETE /session/:sessionId
  if (req.method === "DELETE" && url.pathname.startsWith("/session/")) {
    const sessionId = url.pathname.slice("/session/".length);
    if (!SAFE_ID_RE.test(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid sessionId" }));
      return;
    }
    try {
      // Step 1: docker rmi all tags matching {profileRepo}:{sid}-*.
      // Single-quote the filter argument so the trailing `*` is not glob-
      // expanded by the shell against the daemon's cwd. (sessionId is
      // already SAFE_ID_RE-validated above; the quoting is defense-in-depth
      // against the wildcard.)
      //
      // Per-profile namespacing (2026-05-10): probe BOTH the per-profile
      // repo AND the legacy global repo so a session that was snapshotted
      // before the namespacing change (still under `ariannarun-vessel:...`)
      // gets fully reaped from disk. Without this, the legacy tags would
      // linger and the operator's "freed disk" expectation would silently
      // miss them. Same loop, two filters.
      const profileRepo = vesselRepoFor(ctx);
      const reposToScan = ctx.isLegacy
        ? [VESSEL_REPO_LEGACY]
        : [profileRepo, VESSEL_REPO_LEGACY];
      const tags: string[] = [];
      for (const repo of reposToScan) {
        const lsCmd = `docker images --filter 'reference=${repo}:${sessionId}-*' --format '{{.Repository}}:{{.Tag}}'`;
        const { stdout } = await execAsync(lsCmd);
        for (const t of stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
          if (!tags.includes(t)) tags.push(t);
        }
      }
      let removed = 0;
      for (const tag of tags) {
        try {
          await execAsync(`docker rmi ${tag}`);
          removed++;
        } catch (e) {
          console.warn(`[daemon] Failed to rmi ${tag}:`, e);
        }
      }
      // Step 2: delete snapshot meta files belonging to this session within the profile.
      const files = existsSync(ctx.snapshotsDir)
        ? readdirSync(ctx.snapshotsDir).filter((f) => f.endsWith(".json"))
        : [];
      let metaRemoved = 0;
      for (const f of files) {
        try {
          const meta = JSON.parse(readFileSync(join(ctx.snapshotsDir, f), "utf-8")) as SnapshotMeta;
          if (meta.sessionId === sessionId) {
            unlinkSync(join(ctx.snapshotsDir, f));
            metaRemoved++;
          }
        } catch {
          // skip
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessionId, tagsRemoved: removed, metaRemoved }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = Number(process.env.DAEMON_PORT ?? 9000);
// Loopback only — closes the previous 0.0.0.0 known limitation. On Docker
// Desktop (macOS/Windows) host.docker.internal still resolves to the host's
// loopback so containers can reach us. On bare Linux Docker without Desktop,
// set ARIANNA_DAEMON_BIND=0.0.0.0 if your bridge networking requires it.
const BIND = process.env.ARIANNA_DAEMON_BIND ?? "127.0.0.1";
server.listen(PORT, BIND, () => {
  console.log(`[daemon] Listening on ${BIND}:${PORT}`);
});
