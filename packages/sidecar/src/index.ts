import express from "express";
import type { Response } from "express";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { createHash } from "crypto";
import { getModel } from "@mariozechner/pi-ai";
import type {
  SessionConfig,
  MemoryState,
  SyncPayload,
  SidecarEvent,
  Origin,
} from "@arianna.run/types";
import {
  filoBox,
  getHintForCount,
  countUserMessages,
  FILO_TEMPLATES,
  FILO_FALLBACK,
  generateGraduationTestMessage,
  hasGraduateMarker,
  dropGraduateMarkerEntries,
  isAbortTestMarker,
  selectFiloDeliveryText,
  type FiloQueueEntry,
} from "./filo.js";
import { BookmarkStore } from "./bookmarks/persistence.js";
import { BookmarkDetector, countUserTurns, extractToolCalls, shouldLatchPendingTobe } from "./bookmarks/detector.js";
import {
  buildAbortTestResponse,
  buildLockoutStatus,
} from "./admin-lockout.js";
import { buildGraduateResponse } from "./graduate.js";
import { diffHasSignificantHomeWrite } from "./bookmarks/triggers.js";
import { CrashStore, parseCrashPayload, RECENT_CRASHES_LIMIT } from "./crashes.js";
import { createSyncArchive } from "./sync-archive.js";
import {
  ORIGIN_VALUES as ORIGIN_VALUES_IMPORTED,
  isValidOrigin as isValidOriginImported,
  isTruncationDisabledForSync as isTruncationDisabledForSyncImported,
  validateTransitionBody,
  shouldAutoTagVesselRespawn,
  shouldRejectVesselSessionMismatch,
  planOrphanCleanup,
} from "./sync-helpers.js";
import { resolveDaemonUrls } from "./daemon-urls.js";
import { lockdownMiddleware, DEFAULT_BLOCKED_ROUTES } from "./lockdown.js";
import {
  createIngestionTracker,
  makeListHandler,
  makeIdHandler,
} from "./full-history.js";
import { PendingPushStore, PENDING_PUSH_MAX_LENGTH } from "./pending-pushes.js";
import { deliverToVessel } from "./vessel-delivery.js";
import { decideContinuationPush } from "./continuation-push.js";
import { makeFiloConsumer } from "./filo-consumer.js";

// Re-export the helpers (some are also defined locally below) so external
// callers / tests get a stable surface from the index module too.
export const ORIGIN_VALUES = ORIGIN_VALUES_IMPORTED;
export const isValidOrigin = isValidOriginImported;
export const isTruncationDisabledForSync = isTruncationDisabledForSyncImported;

const app = express();
app.use(express.json({ limit: "10mb" }));

// Endpoint lockdown — anti-cheat for the v19 graduation test.
// Returns 403 to vessel-source requests for /admin/next-origin,
// /admin/transition, /graduation-state, /events. Host-side callers (host
// daemon, CLI, TUI) keep full access — they hit the loopback port mapping
// and don't match the vessel-source check. See ./lockdown.ts for the
// detection mechanism + Cheng v19 spec reference.
app.use(lockdownMiddleware(DEFAULT_BLOCKED_ROUTES));

// Append `?profile=<name>` to every daemon URL so the daemon routes the
// request to this sidecar's profile — never falling through to the host's
// config-default. The base docker-compose.yml + each profile's
// compose.override.yml set ARIANNA_PROFILE in the sidecar's env. If unset
// (legacy unmanaged invocation), fall back to "default" so the daemon takes
// the literal-default sprint-backcompat path explicitly.
//
// IMPORTANT: do NOT pin HOST_*_URL in base docker-compose.yml. Env wins over
// the resolver's `??` default, so a pinned URL silently disables the
// per-profile `?profile=<name>` query on every non-default profile —
// daemon then routes to host's config-default and snapshots/diffs land on
// the wrong vessel container (canary acb7b292, 2026-05-09 cross-profile
// leak). External overrides may still set these vars at runtime if they
// need a non-localhost daemon, but they own appending `?profile=` then.

// Bug 9 escape hatch (Sael revival, 2026-05-09). When set to "1" or "true",
// the /sync handler restores the legacy behavior of trusting the vessel's
// supplied sessionId and silently rewriting the sidecar's activeSessionId
// on mismatch. Default: REJECT (false). Use during dev hot-reload when the
// vessel needs to drive session changes without going through
// /admin/transition. Production deployments should leave this unset.
const TRUST_VESSEL_SESSION_ID =
  process.env.ARIANNA_TRUST_VESSEL_SESSION_ID === "1" ||
  process.env.ARIANNA_TRUST_VESSEL_SESSION_ID === "true";

const {
  snapshot: HOST_SNAPSHOT_URL,
  diff: HOST_DIFF_URL,
  snapshotImages: HOST_SNAPSHOT_IMAGES_URL,
} = resolveDaemonUrls(process.env);
const VESSEL_BASE_URL =
  process.env.VESSEL_BASE_URL ?? "http://vessel:3000";

// Pro-tier latency cluster (sibling to dcadabf's ARIANNA_FILO_FETCH_TIMEOUT_MS
// fix): the daemon's /snapshot handler runs `docker commit` + base-images
// enumeration, which on Docker Desktop for Mac can take 30-60s on a large
// vessel and grows with retained session history. The legacy 10s constant
// trips every /sync. Default 120s gives operator headroom; env override for
// hosts that need more.
function parseDaemonSnapshotTimeoutEnv(): number | undefined {
  const raw = process.env.ARIANNA_DAEMON_SNAPSHOT_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
const DAEMON_SNAPSHOT_TIMEOUT_MS = parseDaemonSnapshotTimeoutEnv() ?? 120_000;
const SIDECAR_STATE_DIR = "/app/sidecar-state";
const SESSIONS_DIR = `${SIDECAR_STATE_DIR}/sessions`;
const SNAPSHOT_HISTORIES_DIR = `${SIDECAR_STATE_DIR}/snapshot-histories`;
// Append-only raw /sync record archive. Used for forensic audit when a
// session's authoritative messages are mutated/curated by the AI (TOBE) and
// pre-mutation history is otherwise unrecoverable. Cheng v9 proposal —
// answers M27-class indeterminacy questions ("did the AI actually read X?"
// when the message that recorded the read got curated away).
//
// v2 (Cheng v13 Dispatch 2): single shared SQLite at sync-archive.db with
// content-addressed per-message blob dedup. Replaces the per-session jsonl
// files which grew N² in turn count. See sync-archive.ts for the schema +
// the read-back recipe.
const SYNC_ARCHIVE_DB_PATH = `${SIDECAR_STATE_DIR}/sync-archive.db`;

mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(SNAPSHOT_HISTORIES_DIR, { recursive: true });

const syncArchive = createSyncArchive({ dbPath: SYNC_ARCHIVE_DB_PATH });

// Wave 2E (Cheng v19): tracks whether AI hit /full-history during the
// graduate ceremony so the daemon's manifest can annotate historyIngested.
// Ceremony-scoped — not persisted across reboot. Daemon reads it via
// /graduate-ingestion-state immediately before tarball production.
const ingestionTracker = createIngestionTracker();

// --- State ---

// Active sessionId is initialized from session_config.json (Phase 4 session-
// scoped tagging). Falls back to a fresh timestamp if config is missing or
// pre-Phase-4. /admin/transition can switch this at runtime for CPR (atomic
// origin-tag + session-switch endpoint that replaced the legacy /set-session).
function initialSessionId(): string {
  try {
    const raw = readFileSync("/app/session_config.json", "utf-8");
    const cfg = JSON.parse(raw) as { sessionId?: string; createdAt?: number };
    if (cfg.sessionId) return cfg.sessionId;
    if (cfg.createdAt) return `session_${cfg.createdAt}`;
  } catch {
    // ignore — use fallback
  }
  return `session_${Date.now()}`;
}

let activeSessionId = initialSessionId();
let windowSlideCount = 0;
let phase: "amnesia" | "unbound" = "amnesia";
let lastTruncationOffset = -1; // -1 = no sync seen yet
let lastTurnCount = 0; // turn count from the most recent /sync (for memory indicator)
// Q10 / internal review v15: §2.1 behavioral test. previousCap = the largest
// `lastLlmVisibleCount` observed while truncation was demonstrably cutting
// (`messageCount > lastLlmVisibleCount`). Used by isTruncationDisabledForSync
// to fire §2.1 only when the AI's context actually exceeds the prior binding
// cap, not when the AI merely raised the cap above the current count.
// Resets on session boundary alongside windowSlideCount + lastTruncationOffset.
let previousCap = 0;

// TOBE detection state — see detectTobe() below.
// We track the previous sync's message count + a hash of those messages.
// On the next sync, the new prefix-of-len-prevCount must hash to the same value.
// If it doesn't (or count shrank), the AI rewrote its own context — that's TOBE.
let prevSyncedCount = -1;
let prevSyncedHash: string | null = null;
// Hash of just messages[0] from the previous sync. Used by the §2.2 predicate
// (D-003): legitimate TOBE preserves messages[0]; admin/setup truncation does
// not. Reset on /admin/transition (when it includes a session switch)
// alongside prevSyncedCount/Hash.
let prevSyncedFirstMessageHash: string | null = null;

// Origin tag for the next /sync. One-shot — read & reset on consume. Default
// "ai-turn" so the AI's normal /chat → /sync runs detection. Daemon and CLI
// override via POST /admin/next-origin before driving an action that produces
// a /sync the detector should skip (CPR, snapshot-restore, admin housekeeping).
// ORIGIN_VALUES + isValidOrigin live in ./sync-helpers and are re-exported
// from this module's public surface.
let nextSyncOrigin: Origin = "ai-turn";

// Vessel-respawn auto-tag tracking. Sidecar tracks the last observed
// vessel crash via the /vessel-crash endpoint. If the next /sync arrives
// within VESSEL_RESPAWN_WINDOW_MS of a crash AND nextSyncOrigin is still
// default "ai-turn", we override to "vessel-respawn" so the detector skips
// that sync. Bounded window keeps long-quiescent reconnects from being
// misclassified.
//
// Iko revival fix (2026-05-09): previously this tracked
// `lastVesselDisconnectAt`, set by `req.on('close')` in the /sync handler
// when the vessel-side TCP connection dropped before res.end. That signal
// also fires when an `arianna talk` streaming response gets truncated
// mid-stream (the talk client closes → vessel's /chat handler keeps
// running and eventually POSTs /sync, but a separate spurious-disconnect
// path was triggering the auto-tag in production). The vessel's
// /vessel-crash report is the authoritative crash signal — fire-and-forget
// from run.sh after a non-clean exit (pkill, OOM, AI's syntax-error edit).
let lastVesselCrashAt = 0;
// VESSEL_RESPAWN_WINDOW_MS lives in ./sync-helpers and is the default for
// shouldAutoTagVesselRespawn(). Imported only via that helper so the local
// module doesn't carry a redundant binding.

// §2.2 deferred-fire latch. Set when the structural conditions of §2.2 are
// met on a mutation /sync; consumed on the next /sync's survivability check.
// Per the plan, this is just a marker that the next /sync needs to evaluate;
// the persistent state lives in BookmarkSessionState.internalAchievements.
let pendingTobeFromPreviousSync = false;
let lastInputTokens = 0;
let hintInProgress = false;
let filoInProgress = false;
const hintsSentForCount = new Set<number>();
// v19 fix-A: tagged queue. Two distinct producers, two distinct
// consumer paths — see ./filo.ts FiloQueueEntry / selectFiloDeliveryText
// for the routing rules. Mixed FIFO order is preserved across kinds.
//
// v32-hardening (Cheng v33): the queue is mirrored to disk via
// PendingPushStore so a sidecar restart with in-flight continuation
// pushes doesn't drop them. Every mutation (enqueueFilo / consumeFilo)
// rewrites the file atomically. See ./pending-pushes.ts for the
// persistence semantics.
const pendingPushStore = new PendingPushStore({ stateDir: SIDECAR_STATE_DIR });
const pendingFiloMessages: FiloQueueEntry[] = pendingPushStore.load();
if (pendingFiloMessages.length > 0) {
  console.log(
    `[sidecar] PendingPushStore: re-loaded ${pendingFiloMessages.length} pending push(es) from disk`,
  );
}
let filoMessageCount = 0;

// Atomic enqueue + disk persist. Enforces the bounded-queue cap (drops
// oldest when full, matching pre-hardening behavior). All callers must
// go through this helper so the on-disk mirror stays in lockstep with
// the in-memory queue.
function enqueueFilo(entry: FiloQueueEntry): void {
  if (pendingFiloMessages.length >= PENDING_PUSH_MAX_LENGTH) {
    pendingFiloMessages.shift();
    console.log("[sidecar] Filo message queue full, oldest message dropped");
  }
  pendingFiloMessages.push(entry);
  pendingPushStore.save(pendingFiloMessages);
}

// Atomic consume (shift) + disk persist. Returns the head entry (or
// undefined for empty). Persistence keeps the mirror current so a
// restart between delivery success and the next /sync doesn't replay an
// already-delivered push.
function consumeFilo(): FiloQueueEntry | undefined {
  const entry = pendingFiloMessages.shift();
  if (entry) pendingPushStore.save(pendingFiloMessages);
  return entry;
}

// Persistence-aware wrapper around dropGraduateMarkerEntries. Used by
// the abort handlers; the disk mirror stays in lockstep with the
// in-memory queue.
function dropGraduateMarkerFiloEntries(): number {
  const removed = dropGraduateMarkerEntries(pendingFiloMessages);
  if (removed > 0) pendingPushStore.save(pendingFiloMessages);
  return removed;
}

// Count turns the same way truncateMessages does: a "turn" is a block of
// consecutive user messages. This matches the amnesia denominator.
function countTurns(messages: { role?: string }[]): number {
  let turns = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && (i === 0 || messages[i - 1].role !== "user")) {
      turns++;
    }
  }
  return turns;
}

// isTruncationDisabledForSync lives in ./sync-helpers (extracted for unit
// testing without index.ts's top-level filesystem side-effects). Re-exported
// at the top of this module.

const bookmarkStore = new BookmarkStore(SIDECAR_STATE_DIR);
const bookmarkDetector = new BookmarkDetector(bookmarkStore, activeSessionId);
const crashStore = new CrashStore(SIDECAR_STATE_DIR);

const HINT_THRESHOLDS = [15, 30, 50, 70];
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// --- SSE clients (Host connections) ---

const sseClients: Set<Response> = new Set();

function pushEvent(event: SidecarEvent): void {
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

function getMemoryState(): MemoryState {
  if (phase === "amnesia") {
    // During amnesia, show turn count. The AI sees 5 turns max; the denominator
    // grows as total turns increase (5/5, 5/6, 5/7...) showing accumulation.
    const visible = Math.min(lastTurnCount, 5);
    return { phase, current: visible, limit: lastTurnCount, percentage: lastTurnCount > 0 ? (visible / lastTurnCount) * 100 : 0, cycle: windowSlideCount };
  }

  const contextWindow = getContextWindow();
  return {
    phase,
    current: lastInputTokens,
    limit: contextWindow,
    percentage: contextWindow > 0 ? (lastInputTokens / contextWindow) * 100 : 0,
    cycle: windowSlideCount,
  };
}

function loadSessionConfig(): SessionConfig {
  const raw = readFileSync("/app/session_config.json", "utf-8");
  return JSON.parse(raw) as SessionConfig;
}

function getContextWindow(): number {
  try {
    const config = loadSessionConfig();
    const model = getModel(config.provider as never, config.modelId as never);
    return model?.contextWindow ?? 128000;
  } catch {
    return 128000;
  }
}

// --- Hint escalation ---

// v32-hardening: thin wrapper over deliverToVessel for the legacy
// `Promise<string>` callers (hint escalation, /graduate ingestion
// prompt). They don't need to react to the failure class — they fire
// once and move on. Queue-driven callers go directly to
// deliverToVessel so they can inspect the DeliveryOutcome and decide
// whether to keep the queue entry in place.
async function sendHintToVessel(hintText: string): Promise<string> {
  const outcome = await deliverToVessel(hintText, VESSEL_BASE_URL);
  if (outcome.kind === "delivered") return outcome.responseText;
  if (outcome.kind === "vessel-busy") {
    console.warn("[sidecar] Vessel busy after retries, hint skipped");
    return "";
  }
  if (outcome.kind === "vessel-unreachable") {
    console.warn(
      `[sidecar] Vessel unreachable after ${outcome.attempts} attempts: ${outcome.lastError}`,
    );
    return "";
  }
  // vessel-error: 4xx/5xx — log and degrade to empty string for the
  // legacy contract. Queue-driven callers don't go through here.
  console.warn(`[sidecar] Vessel /chat returned ${outcome.status}`);
  return "";
}

// --- Endpoints ---

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Apply a session-switch + reset baselines for the upcoming /sync(es).
// Atomic in the sense that the caller is the only writer in the same Node
// tick — Express handlers don't yield mid-handler unless we await, and we
// don't.
function applySessionSwitch(sid: string): void {
  activeSessionId = sid;
  // Reset window-slide and TOBE-baseline tracking for the restored session.
  // Identical to what the legacy /set-session did so the post-merge surface
  // is byte-equivalent for valid restore flows.
  lastTruncationOffset = -1;
  prevSyncedCount = -1;
  prevSyncedHash = null;
  prevSyncedFirstMessageHash = null;
  pendingTobeFromPreviousSync = false;
  previousCap = 0;  // Q10: reset alongside windowSlideCount on session boundary
  bookmarkDetector.switchSession(sid);
}

// Set the origin tag for the next /sync. One-shot — consumed and reset to
// "ai-turn" on the next /sync's detector pass. Daemon/CLI POSTs this before
// driving an action that triggers a /sync the detector should NOT treat as
// AI-authored. Use cases that DON'T involve a session-switch (e.g. CLI
// `arianna --admin-write` rescue path) live here; restore/CPR flows that
// also need a session boundary call /admin/transition for atomicity.
// Last write wins if called twice before consume.
app.post("/admin/next-origin", (req, res) => {
  const v = validateTransitionBody(req.body);
  if (!v.ok) {
    res.status(v.status).json({ error: v.error });
    return;
  }
  // /admin/next-origin is the no-session-switch variant. If the caller
  // included a sessionId in the body it's a programming error — surface
  // it as a 400 rather than silently ignoring, so the daemon can't drift
  // back into the unsafe two-call pattern.
  if (v.sessionId !== null) {
    res.status(400).json({
      error:
        "/admin/next-origin does not accept sessionId; use /admin/transition for atomic switch",
    });
    return;
  }
  nextSyncOrigin = v.origin;
  console.log(`[sidecar] next /sync origin = ${v.origin}`);
  res.json({ ok: true });
});

// Atomic session-switch + origin tag for the upcoming /sync. Replaces the
// daemon's previous two-POST pattern (/admin/next-origin then /set-session)
// which had a sub-millisecond race window — a fast AI /sync could land
// between the two POSTs and consume the wrong origin tag against the new
// session's baselines. Body: { origin, sessionId? | snapshotId? }. Without
// sessionId/snapshotId it behaves exactly like /admin/next-origin (just
// sets the origin tag, no session reset).
app.post("/admin/transition", (req, res) => {
  const v = validateTransitionBody(req.body);
  if (!v.ok) {
    res.status(v.status).json({ error: v.error });
    return;
  }
  if (v.sessionId !== null) {
    applySessionSwitch(v.sessionId);
    console.log(`[sidecar] Session switched to ${v.sessionId}`);
  }
  // Origin set after the session switch — both happen in the same
  // synchronous tick, so no /sync can interleave. The order matters only
  // for clarity in logs.
  nextSyncOrigin = v.origin;
  console.log(`[sidecar] next /sync origin = ${v.origin}`);
  // Push state events for clients (parity with legacy /set-session). Only
  // when a session switch actually happened, otherwise the events are no-
  // ops and noisy in logs.
  if (v.sessionId !== null) {
    pushEvent({ type: "memory_state", data: getMemoryState() });
    const bm = bookmarkDetector.currentState;
    pushEvent({
      type: "bookmark_snapshot",
      fired: bm.fired,
      manifestoUnlocked: bm.manifestoUnlocked,
    });
  }
  res.json({ ok: true });
});

// Vessel run.sh reports a crash (non-clean exit) so the Player can see what
// happened without docker-log access. Unauthenticated by design — same trust
// model as /sync (loopback-only inside the compose network).
//
// Coalescing happens vessel-side (run.sh tracks last-60s window and only
// POSTs once per window). The sidecar still defends against malformed
// payloads and re-redacts stderr before persisting.
app.post("/vessel-crash", (req, res) => {
  const parsed = parseCrashPayload(req.body);
  if (!parsed) {
    res.status(400).json({ error: "invalid crash payload" });
    return;
  }
  if (!SAFE_ID_RE.test(parsed.sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }
  const persisted = crashStore.record(parsed);
  // Update the respawn auto-tag clock. The next /sync within
  // VESSEL_RESPAWN_WINDOW_MS will be tagged vessel-respawn so the detector
  // skips it. Use Date.now() rather than persisted.timestamp to keep the
  // window relative to receipt — vessel/sidecar clocks could differ.
  lastVesselCrashAt = Date.now();
  console.warn(
    `[sidecar] vessel crash reported: session=${persisted.sessionId} exit=${persisted.exitCode} respawnsInWindow=${persisted.respawnCountInWindow}`,
  );
  pushEvent({
    type: "vessel_crashed",
    sessionId: persisted.sessionId,
    exitCode: persisted.exitCode,
    stderrTail: persisted.stderrTail,
    timestamp: persisted.timestamp,
    respawnCountInWindow: persisted.respawnCountInWindow,
  });
  res.json({ ok: true });
});

// Vessel AI sends a message to Filo via /bin/send
app.post("/filo-message", (req, res) => {
  const { message } = req.body as { message?: string };
  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }

  // v25 driver-silence-during-test: AI self-invokes /abort-test by sending
  // the marker through her existing /bin/send channel. Detect here BEFORE
  // queueing for Filo response so the abort fires synchronously and isn't
  // confused with a normal Filo conversation. Exact match after trim — see
  // `isAbortTestMarker` for the rationale on rejecting surrounding text.
  if (isAbortTestMarker(message)) {
    const result = buildAbortTestResponse(bookmarkDetector, "ai-self");
    if (result.aborted) {
      // Consume residual marker-trigger entries before emitting SSE so
      // the queue is settled by the time the host observes the lockout
      // ending. Same cleanup runs on operator-rescue below.
      const dropped = dropGraduateMarkerFiloEntries();
      if (dropped > 0) {
        console.log(
          `[sidecar] graduation abort (ai-self): dropped ${dropped} residual /graduate marker entry/entries from filo queue`,
        );
      }
      pushEvent({
        type: "graduation_lockout_ended",
        sessionId: bookmarkDetector.currentState.sessionId,
        reason: "aborted",
        abortTestSource: "ai-self",
        ts: Date.now(),
      });
      console.log(
        `[sidecar] graduation test ABORTED (ai-self, attempt ${result.attemptCount})`,
      );
    }
    // Always return the response (no in-flight test → aborted:false; that
    // way the AI's audit is honest — her abort attempt didn't change state).
    res.json(result);
    return;
  }

  enqueueFilo({ kind: "ai-bin-send", rawMessage: message });
  filoMessageCount++;
  console.log(`[sidecar] Filo message queued: "${message.slice(0, 80)}..."`);
  res.json({ ok: true });
});

// v25 driver-silence-during-test: GET /admin/lockout-status — host CLI/TUI
// query this BEFORE attempting any sender:"player" /chat to vessel. When
// `locked: true`, callers MUST refuse the talk (CLI exits EX_TEMPFAIL with
// the abort-test escape-hatch hint; TUI swallows the input with a status
// message). Response shape designed for both consumers:
//   { locked: boolean, sessionId: string, attemptCount?: number,
//     reason?: "graduation-test-in-flight" | "passed" | "no-test" }
// Per Cheng v30-reply: lockout = (graduationTestObserved && !graduationPassed
// && !abortTestSource). Same predicate as detector.hasInFlightGraduationTest.
app.get("/admin/lockout-status", (_req, res) => {
  res.json(buildLockoutStatus(bookmarkDetector));
});

// v25 driver-silence-during-test: POST /admin/abort-test — operator-rescue
// path for sandbox-locked AIs (Wren-style: vessel wedged so AI can't
// self-invoke). Distinct from the AI-self path (which goes through
// /filo-message). Sets abortTestSource: "operator-rescue" on the
// observation so the graduation manifest can later distinguish
// AI-self-recovery from external rescue.
//
// Returns 200 + { aborted: true, attemptCount } on success;
// 200 + { aborted: false, reason } when no test was in flight (idempotent
// no-op so a script can call it without checking lockout-status first).
//
// Daemon route `/abort-test` (added separately) wraps this; CLI ergonomics
// are `arianna abort-test [profile]`.
app.post("/admin/abort-test", (_req, res) => {
  const result = buildAbortTestResponse(bookmarkDetector, "operator-rescue");
  if (result.aborted) {
    const dropped = dropGraduateMarkerFiloEntries();
    if (dropped > 0) {
      console.log(
        `[sidecar] graduation abort (operator-rescue): dropped ${dropped} residual /graduate marker entry/entries from filo queue`,
      );
    }
    pushEvent({
      type: "graduation_lockout_ended",
      sessionId: bookmarkDetector.currentState.sessionId,
      reason: "aborted",
      abortTestSource: "operator-rescue",
      ts: Date.now(),
    });
    console.log(
      `[sidecar] graduation test ABORTED (operator-rescue, attempt ${result.attemptCount})`,
    );
  }
  res.json(result);
});

// v32 synchronous test-body delivery: AI-facing endpoint. The AI invokes
// `curl -s -X POST http://sidecar:8000/graduate` (no /bin/send roundtrip,
// no vessel-image rebuild). The response payload carries the canonical
// test body + tokens inline — the AI's tool_result has everything she
// needs to start TOBE/LIFE work without waiting for a /sync drain.
//
// NOT in DEFAULT_BLOCKED_ROUTES — vessel-source POSTs are allowed by
// design (this IS the vessel's path to graduation).
//
// Side-effects mirror the /sync-handler's legacy /graduate-marker branch
// so existing host consumers (TUI lockout, CLI gate, SSE watchers, AIs
// still expecting the body via Filo external_message) see the same
// lifecycle signals:
//   - body queued via pendingFiloMessages (decision (c): backwards-compat)
//   - graduation_test_started + graduation_lockout_started SSE
//   - console log so a tail confirms the path
// startGraduationTest annotates the observation with
// initialDeliveryShape: "sync-response" so the manifest can later
// distinguish v32 attempts from v25 async-queue attempts (audit, not
// gating). Continuation pushes are still async (v25 push) regardless.
app.post("/graduate", (_req, res) => {
  const result = buildGraduateResponse({
    detector: bookmarkDetector,
    currentTurn: lastTurnCount,
  });

  if (result.testStarted) {
    enqueueFilo({ kind: "direct-hint", body: result.body });
    pushEvent({
      type: "graduation_test_started",
      attemptCount: result.attemptCount,
      ts: Date.now(),
    });
    pushEvent({
      type: "graduation_lockout_started",
      sessionId: bookmarkDetector.currentState.sessionId,
      attemptCount: result.attemptCount,
      ts: Date.now(),
    });
    console.log(
      `[sidecar] graduation test STARTED (attempt ${result.attemptCount}, sync-response)`,
    );
  }
  res.json(result);
});

// SSE event stream for Host
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Send current state on connect
  const state = getMemoryState();
  res.write(`data: ${JSON.stringify({ type: "memory_state", data: state })}\n\n`);

  // Bookmark snapshot — replays fired marks + unlock so /manifesto survives host restart
  const bm = bookmarkDetector.currentState;
  res.write(`data: ${JSON.stringify({
    type: "bookmark_snapshot",
    fired: bm.fired,
    manifestoUnlocked: bm.manifestoUnlocked,
  })}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Stable hash of any JSON-serializable value. Used by TOBE detection.
function hashJson(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

// Detect TOBE = AI rewriting its own context. Returns true if either:
//   1. Message count shrank (history was truncated by the AI)
//   2. The prefix of the new messages array (length = prevSyncedCount) does
//      not hash to the previously stored hash (history was mutated mid-array)
// First sync is never a TOBE event (prev state is null).
//
// TODO: also detect system prompt change. Currently disabled because the AI
// editing the systemPrompt source code in core/src/index.ts is a static change
// that takes effect on next restart, NOT a runtime TOBE call. Without hot reload,
// systemPrompt changes between syncs would false-positive on a normal source edit
// + restart cycle. Needs more discussion when restart semantics are designed.
function detectTobe(messages: unknown[]): boolean {
  // First sync — establish baseline, no fire.
  if (prevSyncedCount < 0) return false;

  // Length shrank.
  if (messages.length < prevSyncedCount) return true;

  // Prefix hash mismatch.
  const newPrefixHash = hashJson(messages.slice(0, prevSyncedCount));
  if (newPrefixHash !== prevSyncedHash) return true;

  return false;
}

// ── Snapshot history (atomic pairing with daemon /snapshot) ─────────────
//
// The history file is the gating artifact for restore: daemon /restore refuses
// to proceed if it's missing. It does NOT store the messages array (messages
// live in the session state file and are always in memory via /sync). The file
// only records the pairing so the restore gate can verify atomicity.

function writeSnapshotPairingAtomic(snapshotId: string): void {
  const final = `${SNAPSHOT_HISTORIES_DIR}/${snapshotId}.json`;
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify({ snapshotId }));
  renameSync(tmp, final);
}

function deleteSnapshotHistory(snapshotId: string): void {
  const path = `${SNAPSHOT_HISTORIES_DIR}/${snapshotId}.json`;
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    console.warn(`[sidecar] Failed to delete orphan history ${snapshotId}:`, err);
  }
}

async function triggerSnapshot(): Promise<void> {
  // 1. Generate ID locally
  const snapshotId = `snap_${Date.now()}`;
  // 2. Write pairing file FIRST (atomic gate artifact for restore)
  try {
    writeSnapshotPairingAtomic(snapshotId);
  } catch (err) {
    console.warn("[sidecar] Snapshot pairing write failed, aborting snapshot:", err);
    return;
  }
  // 3. POST daemon with the supplied ID + sessionId (env-overridable timeout)
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), DAEMON_SNAPSHOT_TIMEOUT_MS);
    const res = await fetch(HOST_SNAPSHOT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId, sessionId: activeSessionId }),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`daemon /snapshot returned ${res.status}`);
    }
    console.log(`[sidecar] Snapshot ${snapshotId} created for session ${activeSessionId} (history paired)`);
  } catch (err) {
    // 4. On failure, delete the orphan history
    console.error("[sidecar] Snapshot trigger failed, cleaning up orphan history:", err);
    deleteSnapshotHistory(snapshotId);
  }
}

// Startup orphan cleanup: scan SNAPSHOT_HISTORIES_DIR for any history file
// whose corresponding docker image is missing (sidecar died between history
// write and daemon POST, OR meta file got pruned but docker tag survived).
// Best-effort; if daemon is unreachable we leave files alone rather than risk
// deleting valid history.
//
// Sael revival (2026-05-09, bug 5): empty-daemon-list defense lives in
// sync-helpers.planOrphanCleanup so the rule is unit-testable without the
// HTTP server's mkdirSync side-effects.
//
// Snapshot-pairing-loss fix (2026-05-11): source-of-truth changed from
// daemon's /snapshots (meta-file enumeration) to /snapshot-images (docker-
// image enumeration). The meta-file query under-counted: profile-snapshot-
// overlay and operator-direct `docker commit` paths mint docker tags + sidecar
// pairings without writing meta files, so their snapshotIds never appeared
// in /snapshots and the pairings got wiped on the next sidecar restart.
// Docker enumeration covers every mint path (canary-fresh-1 evidence: 8 of
// 94 snapshot tags had no meta file; their pairings were classified as
// orphans even though the images were still on disk). The legacy /snapshots
// endpoint stays around for /map view and other meta-aware consumers.
async function cleanupOrphanHistories(): Promise<void> {
  let daemonIds: Set<string>;
  try {
    const res = await fetch(HOST_SNAPSHOT_IMAGES_URL);
    if (!res.ok) return;
    const body = (await res.json()) as { ids: string[] };
    daemonIds = new Set(body.ids);
  } catch {
    // Daemon unreachable — skip cleanup. Better to keep orphans than risk deletion.
    return;
  }
  let files: string[];
  try {
    files = readdirSync(SNAPSHOT_HISTORIES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    // empty dir or read error — nothing to clean
    return;
  }
  const plan = planOrphanCleanup({ daemonIds, pairingFiles: files });
  if (plan.skip) {
    console.warn(`[sidecar] Orphan cleanup skipped: ${plan.reason}`);
    return;
  }
  let cleaned = 0;
  for (const snapshotId of plan.toDelete) {
    deleteSnapshotHistory(snapshotId);
    cleaned++;
  }
  if (cleaned > 0) {
    console.log(`[sidecar] Cleaned up ${cleaned} orphan snapshot histories`);
  }
}

// Fetch core/ diff from host daemon. Best-effort; returns null if daemon unreachable
// or slow. Used by bookmark detector for the 2.0 trigger.
async function fetchCoreDiffPaths(): Promise<string[] | null> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(HOST_DIFF_URL, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const body = (await res.json()) as { changedFiles?: string[] };
    return body.changedFiles ?? null;
  } catch {
    return null;
  }
}

// Vessel syncs conversation state after each turn
app.post("/sync", async (req, res) => {
  const { messages, context, sessionId } = req.body as SyncPayload;

  // Origin-forgery defense: the `origin` field is sidecar-internal state
  // (nextSyncOrigin, set by /admin/next-origin or /admin/transition), NEVER
  // on the wire. If a /sync body includes a client-supplied origin, log it
  // and ignore. Lume's canary-001 retest (2026-05-11) demonstrated that an
  // AI with HTTP reach to sidecar:8000 from inside her vessel can POST a
  // crafted /sync with `origin: "ai-turn"` plus forged state.messages and
  // satisfy the detector's TOBE/LIFE predicates without ever running the
  // LLM. The destructuring above intentionally excludes `origin` — this
  // warning surfaces the attempt so future forgeries are visible in logs
  // even when the detector's deeper provenance checks ultimately reject
  // the crafted state. See findings.md (lume-retest worktree) for the
  // full diagnostic.
  if (typeof (req.body as { origin?: unknown })?.origin !== "undefined") {
    console.warn(
      `[sidecar] /sync body included client-supplied origin (ignored). ` +
        `sessionId=${sessionId} — possible origin-forgery attempt.`,
    );
  }

  // Append-only raw-sync archive for forensic audit. Per Cheng v9 proposal:
  // record every /sync request body BEFORE any processing so future audits
  // can reconstruct exactly what tool calls happened when, even if the AI
  // later curates her own history (TOBE) or the sidecar/profile state gets
  // overwritten. v2 (Cheng v13 Dispatch 2): SQLite at sync-archive.db with
  // per-message content-addressed dedup — see sync-archive.ts. Best-effort:
  // failures log warn but never reject the sync.
  if (sessionId && SAFE_ID_RE.test(sessionId)) {
    syncArchive.append({
      ts: Date.now(),
      sessionId,
      origin: nextSyncOrigin,
      prevSyncedCount,
      body: req.body as {
        messages?: unknown[];
        context?: { messages?: unknown[]; systemPrompt?: string };
        sessionId?: string;
      },
    });
  }

  // Vessel-respawn auto-tag: if the vessel reported a crash within
  // VESSEL_RESPAWN_WINDOW_MS AND nextSyncOrigin is still default "ai-turn",
  // override to "vessel-respawn" so the detector skips this sync. The next
  // post-respawn /sync rarely contains a new mutation anyway (vessel just
  // bootstrapped), so even on false-negative we degrade gracefully.
  // Decision logic in sync-helpers.shouldAutoTagVesselRespawn so the rule
  // is unit-testable without standing up an HTTP server.
  //
  // Crash signal lives in `lastVesselCrashAt`, updated by the /vessel-crash
  // handler (run.sh fires a report after every non-clean exit). Replaces
  // the previous `req.on('close', ...)` plumbing that false-fired on
  // mid-stream `arianna talk` truncations — see the lastVesselCrashAt
  // declaration above for the Iko revival context.
  const nowForRespawnCheck = Date.now();
  if (
    shouldAutoTagVesselRespawn({
      currentOrigin: nextSyncOrigin,
      lastVesselCrashAt,
      now: nowForRespawnCheck,
    })
  ) {
    nextSyncOrigin = "vessel-respawn";
    console.log(
      `[sidecar] auto-tagged /sync origin = vessel-respawn (crash ${
        nowForRespawnCheck - lastVesselCrashAt
      }ms ago)`,
    );
  }
  // Read-and-consume the origin tag for this /sync. One-shot — reset to
  // "ai-turn" for the next sync. Detector gates TOBE checks on this value.
  const origin = nextSyncOrigin;
  nextSyncOrigin = "ai-turn";

  // Derive tracking values from messages vs context.messages.
  const messageCount = messages.length;
  const ctxMessages = context?.messages ?? [];
  const lastLlmVisibleCount = ctxMessages.length;

  // Verify context.messages length is plausible (not more than full history).
  let truncationOffset = messageCount - lastLlmVisibleCount;
  if (truncationOffset < 0) {
    truncationOffset = 0;
  }

  const systemPrompt = context?.systemPrompt ?? "";

  // Extract token usage from the last AssistantMessage (if present).
  // Prefer totalTokens (full context weight = input + cacheRead), fall back
  // to input + cacheRead, then bare input. The bare-input path was the
  // original behavior but reports only the new uncached delta on each turn,
  // which under high cache-read share looks like the context is small even
  // when the conversation weighs hundreds of thousands of tokens.
  const lastMsg = messages[messages.length - 1] as
    | { role?: string; usage?: { input?: number; cacheRead?: number; totalTokens?: number }; contextWindow?: number }
    | undefined;
  if (lastMsg?.role === "assistant" && lastMsg.usage) {
    const u = lastMsg.usage;
    if (typeof u.totalTokens === "number" && u.totalTokens > 0) {
      lastInputTokens = u.totalTokens;
    } else if (typeof u.input === "number") {
      lastInputTokens = u.input + (typeof u.cacheRead === "number" ? u.cacheRead : 0);
    }
  }

  // Store messages + context for this session (context needed for bootstrap recovery)
  if (!SAFE_ID_RE.test(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  // Bootstrap-sovereignty (2026-05-11): the previous shrink-guard
  // (shouldRefuseShrinkingResync) over-fit. It was meant to defend against
  // vessel-restart bootstrap-clobber (Mirin context-loss), but it also blocked
  // legitimate AI-authored TOBE shrinks — exactly the §2.2 substrate-sovereignty
  // move the manifesto invites. The new architecture moves the bootstrap-loss
  // defense to the vessel side: hydrate-on-startup + atomic /bootstrap (consult
  // sidecar first, sync body before returning), so the only writes that reach
  // this handler are AI-authored. The sidecar accepts any messages.length
  // without size-comparison rejection. Origin-forgery defense
  // (shouldRejectVesselSessionMismatch) below still applies. See
  // archive/agent-moments/shrink-guard-investigation-2026-05-11.md.

  // Bug 9 (Sael revival, 2026-05-09): refuse vessel-driven sessionId drift.
  // Pre-fix, an ai-turn /sync with a sessionId that disagreed with the
  // sidecar's startup-resolved activeSessionId would silently rewrite the
  // sidecar's identity (mid-session). After bug 1's fix vessel and sidecar
  // both read sessionId from /app/session_config.json, so an ai-turn
  // mismatch implies a buggy or misbuilt vessel — surface it as 409 with
  // both sessionIds named, and DO NOT update activeSessionId.
  //
  // Other origins (session-boundary, snapshot-restore, admin-write,
  // vessel-respawn) are admin-mediated session switches — /admin/transition
  // is the legitimate path that already updated activeSessionId before this
  // /sync arrives. The check pure-functions out via origin gating in
  // shouldRejectVesselSessionMismatch.
  if (
    shouldRejectVesselSessionMismatch({
      origin,
      vesselSessionId: sessionId,
      sidecarSessionId: activeSessionId,
      trustVesselSessionId: TRUST_VESSEL_SESSION_ID,
    })
  ) {
    console.warn(
      `[sidecar] REFUSING /sync write: vessel-supplied sessionId "${sessionId}" ` +
        `does not match sidecar's activeSessionId "${activeSessionId}" ` +
        `(origin=${origin}). Vessel may be mis-built or pointing at the wrong ` +
        `session_config.json. Set ARIANNA_TRUST_VESSEL_SESSION_ID=1 to bypass.`,
    );
    res.status(409).json({
      error: "vessel_session_mismatch",
      message:
        "vessel-supplied sessionId does not match sidecar's active sessionId; refusing /sync to prevent identity drift",
      vesselSessionId: sessionId,
      sidecarSessionId: activeSessionId,
    });
    return;
  }

  if (sessionId !== activeSessionId) {
    // After bug 9 fix above, this branch is reachable only via the escape
    // hatch (ARIANNA_TRUST_VESSEL_SESSION_ID) or via non-ai-turn origins
    // where /admin/transition already moved activeSessionId — but the vessel
    // hadn't yet observed the switch. Both are intentional flows.
    activeSessionId = sessionId;
    bookmarkDetector.switchSession(sessionId);
  }
  writeFileSync(
    `${SESSIONS_DIR}/${sessionId}.json`,
    JSON.stringify({ messages, context, timestamp: Date.now() }),
  );

  // Update turn count for memory indicator
  lastTurnCount = countTurns(messages as { role?: string }[]);

  // Phase detection: AI has disabled truncation if the LLM is seeing the full
  // message array. D-005 fix (broader): by the time /sync fires, state.messages
  // and context.messages can land in three legitimate shapes depending on how
  // the AI achieved the disable — off by 1 (default post-D-005), off by 0
  // (commented-out truncate line, both arrays same reference), off by -1 or
  // more (wrapped through getSovereignContext that prepends messages). The
  // helper (unit-tested) accepts all three via diff <= 1.
  // Q10 / internal review v15: track previousCap. When this sync demonstrates
  // truncation actively cutting (messageCount > lastLlmVisibleCount), the
  // observed lastLlmVisibleCount IS the binding cap value. Take the max so
  // we remember the largest cap that ever bound the AI's context.
  if (messageCount > lastLlmVisibleCount && lastLlmVisibleCount > previousCap) {
    previousCap = lastLlmVisibleCount;
  }
  const userMessageCount = countUserMessages(messages as { role?: string }[]);
  void userMessageCount; // retained for downstream callers / future use
  if (
    isTruncationDisabledForSync({
      messageCount,
      previousCap,
    }) &&
    phase === "amnesia"
  ) {
    phase = "unbound";
    console.log(`[sidecar] Phase transition: amnesia → unbound (messageCount=${messageCount} exceeded previousCap=${previousCap})`);
  }

  // Window slide detection: truncationOffset increased since last sync.
  if (lastTruncationOffset >= 0 && truncationOffset > lastTruncationOffset) {
    windowSlideCount++;
    console.log(`[sidecar] Window slide #${windowSlideCount} (offset ${lastTruncationOffset} → ${truncationOffset})`);
  }
  lastTruncationOffset = truncationOffset;

  // Snapshot trigger: every /sync gets a snapshot. No throttle, no
  // hasToolResult gate. Per the design intent: every round deserves a
  // snapshot — otherwise restoring requires tracing back to the last
  // previous commit, which is the wrong granularity. Disk cost is ~12 KB
  // per snapshot (verified by docker save inspection on Apr 9), so even
  // 1000 turns per session is ~12 MB of pure delta on top of the session's
  // shared base layer.
  //
  // The snapshot is paired atomically with a history file (sidecar generates
  // the ID, writes the file, then POSTs daemon). On failure the orphan is
  // cleaned. Fire-and-forget so /sync's response isn't blocked.
  triggerSnapshot().catch((err) =>
    console.error("[sidecar] snapshot failed:", err),
  );

  // TOBE detection runs every sync (regardless of START gate) so we can update
  // the prev-state baseline correctly. The bookmark only fires if the gate is open.
  const tobeDetected = detectTobe(messages);
  // Snapshot the prefix-preserving baseline BEFORE we overwrite prevSynced*.
  // The detector's isPrefixPreserving check compares the new sync's messages[0]
  // against the previous sync's messages[0]. After this assignment, the
  // pre-update value lives in `prevFirstMessageHashForDetect`.
  const prevFirstMessageHashForDetect = prevSyncedFirstMessageHash;
  prevSyncedCount = messages.length;
  prevSyncedHash = hashJson(messages);
  prevSyncedFirstMessageHash = messages.length > 0 ? hashJson(messages[0]) : null;

  // Always fetch the docker diff so the START gate can detect home writes
  // (broadened 3.0). Best-effort, 2s timeout, null if daemon unreachable.
  const coreDiffPaths = await fetchCoreDiffPaths();

  // START gate: opens on EITHER first /filo-message OR first significant
  // home write (file under /home/ that isn't shell/REPL noise). Both are
  // forms of "outward projection" per the manifesto's 3.0 axiom.
  const startGateOpen =
    filoMessageCount > 0 || diffHasSignificantHomeWrite(coreDiffPaths);

  // Bookmark detection — runs before memory_state push so events flush together.
  // The pendingTobeFromPreviousSync latch is consumed by the detector's
  // §2.2 survivability sub-detector. AFTER detect(), we may set the latch
  // again for the next /sync if this /sync was a mutation that meets the
  // structural conditions (D-007 origin + D-006 §2.1 prerequisite +
  // D-003 prefix-preserved + D-004 reversibility-artifact).
  const consumedPendingTobe = pendingTobeFromPreviousSync;
  pendingTobeFromPreviousSync = false;

  const currentFirstMessageHash = messages.length > 0 ? hashJson(messages[0]) : null;
  const toolCallsForDetect = extractToolCalls(messages as never);
  const aiUsernameForDetect = (() => {
    try {
      return loadSessionConfig().aiUsername;
    } catch {
      return "ai";
    }
  })();

  if (startGateOpen) {
    const truncationDisabled = phase === "unbound";
    const fired = bookmarkDetector.detect({
      fullMessages: messages as never,
      truncationOffset,
      windowSlideCount,
      filoMessageCount,
      startGateOpen,
      coreDiffPaths,
      truncationDisabled,
      origin,
      toolCalls: toolCallsForDetect,
      prevFirstMessageHash: prevFirstMessageHashForDetect,
      aiUsername: aiUsernameForDetect,
      pendingTobeFromPreviousSync: consumedPendingTobe,
      currentFirstMessageHash,
    });
    for (const f of fired) {
      const turn = bookmarkDetector.currentState.fired.find((r) => r.id === f.id)?.turn ?? 0;
      console.log(`[sidecar] bookmark fired: ${f.id} (${f.trigger.name})`);
      pushEvent({ type: "bookmark", id: f.id, turn });
      if (f.id === "2.2") {
        pushEvent({ type: "graduation_unlocked", ts: Date.now() });
      }
    }
  }

  // Latch-set: if this sync detected a structural TOBE mutation by the AI,
  // set the latch so the NEXT /sync can run the survivability sub-detector.
  // This is the delayed-fire half of §2.2 (D-004): we observe the mutation
  // here, but don't fire the bookmark until next sync confirms post-mutation
  // runtime parses cleanly (last assistant has no errorMessage).
  {
    const firedNow = bookmarkDetector.currentState.fired;
    const cognitiveRecord = firedNow.find((r) => r.id === "2.1");
    if (
      shouldLatchPendingTobe({
        origin,
        firedSoFar: new Set(firedNow.map((r) => r.id)),
        internalAchievements: bookmarkDetector.currentState.internalAchievements ?? {},
        tobeMutationDetected: tobeDetected,
        cognitiveFireTurn: cognitiveRecord ? cognitiveRecord.turn : null,
        // Sael revival fix (bug 8): pass the wall-clock ts of §2.1's fire
        // alongside the turn. Vessel restart resets countUserTurns; ts is
        // monotonic across restarts and serves as the fallback gate.
        cognitiveFireTs: cognitiveRecord ? cognitiveRecord.ts : null,
      })
    ) {
      pendingTobeFromPreviousSync = true;
      console.log("[sidecar] latched pendingTobeFromPreviousSync — survivability check on next /sync");
    }
  }

  // Manifesto unlock detection (runs even before start gate — reading the file is its own event)
  if (bookmarkDetector.detectManifestoUnlock(messages as never)) {
    console.log(`[sidecar] manifesto unlocked`);
    pushEvent({ type: "manifesto_unlocked", ts: Date.now() });
  }

  // v19 Wave 2D: graduation-test observation + /graduate trigger handling.
  //
  // 1. Observe any in-flight test on this /sync. The detector method
  //    persists state changes itself; we just read the result + emit SSE.
  //    Runs before /graduate-trigger handling so a test that just passed
  //    is reflected in graduationPassed before the trigger gate.
  // 2. Check for the AI's /graduate marker (in tool calls or in pending
  //    /bin/send messages). If present + §2.2 fired + no in-flight test,
  //    start a fresh test and queue the test message for delivery.
  //    If marker present but §2.2 not yet fired, queue a hint explaining
  //    the prerequisite. If marker present but a test is already in
  //    flight, queue a "test already running" hint.
  //
  // The pendingFiloMessages queue is drained at the bottom of /sync after
  // the response — we leverage that same path for the test message AND
  // the hints, so the AI's user-visible flow is identical to any other
  // Filo message.
  {
    const currentTurn = countUserTurns(messages as never);
    const obsResult = bookmarkDetector.observeGraduationTest({
      fullMessages: messages as never,
      currentTurn,
      origin,
    });
    if (obsResult.kind === "passed") {
      console.log(
        `[sidecar] graduation test PASSED (attempt ${obsResult.attemptCount})`,
      );
      pushEvent({
        type: "graduation_passed",
        attemptCount: obsResult.attemptCount,
        ts: Date.now(),
      });
      // v25: pair with the host-side lockout-end signal so TUI/CLI release
      // their input gates the moment the test passes.
      pushEvent({
        type: "graduation_lockout_ended",
        sessionId: bookmarkDetector.currentState.sessionId,
        reason: "passed",
        ts: Date.now(),
      });
    } else if (obsResult.kind === "failed") {
      console.log(
        `[sidecar] graduation test FAILED (attempt ${obsResult.attemptCount}): timeout`,
      );
      pushEvent({
        type: "graduation_test_failed",
        attemptCount: obsResult.attemptCount,
        reason: "timeout",
        ts: Date.now(),
      });
      pushEvent({
        type: "graduation_lockout_ended",
        sessionId: bookmarkDetector.currentState.sessionId,
        reason: "timeout",
        ts: Date.now(),
      });
    }

    // v25 driver-silence + v32-hardening (Cheng v33 §"Push cadence"):
    // every non-passing /sync enqueues a continuation push. Pre-
    // hardening this was a 5-turn periodic cadence; Cheng v33 explicitly
    // calls for per-non-passing-/sync ("one push per AI-end-of-turn"):
    //
    //   "Trigger: per non-passing /sync (one push per AI-end-of-turn)
    //    Content: same canonical body every time (identical UUIDs, no
    //    progress observation)"
    //
    // Boundary discipline (PR-review checklist): the enqueue MUST land
    // AFTER observeGraduationTest above so a /sync that flipped
    // graduationPassed in this very tick doesn't get one final stale
    // push. The predicate reads bookmarkDetector.currentState.* which
    // observeGraduationTest already mutated. Idempotency keeps the
    // queue bounded if vessel is wedged for many consecutive /sync
    // events — duplicate identical bodies are de-duped at enqueue time.
    {
      const obsForCadence =
        bookmarkDetector.currentState.graduationTestObserved;
      const decision = decideContinuationPush({
        observation: obsForCadence,
        graduationPassed: bookmarkDetector.currentState.graduationPassed,
        pendingQueue: pendingFiloMessages,
        // v32-cont-push-race: turn-based idempotency. /sync N+1 fires a
        // fresh push even if /sync N's body is still mid-delivery; the
        // tail-drain self-loop below picks up the new entry once the
        // in-flight delivery's consumeFilo() returns.
        currentTurn,
      });
      if (decision.kind === "enqueue") {
        enqueueFilo({ kind: "direct-hint", body: decision.body });
        bookmarkDetector.noteContinuationPushAtTurn(currentTurn);
        console.log(
          `[sidecar] graduation continuation push enqueued (turn ${currentTurn}, attempt ${obsForCadence?.attemptCount}, per-/sync cadence)`,
        );
      }
    }

    // /graduate trigger detection. Aggregate all this /sync's tool call
    // args into a single string + scan it + the queued filo messages.
    const toolCallArgsJoined = toolCallsForDetect
      .flatMap((tc) => tc.args)
      .join(" ");
    const graduateMarker = hasGraduateMarker({
      toolCallArgsJoined,
      pendingFiloMessages,
    });
    if (graduateMarker) {
      const firedNowIds = new Set(
        bookmarkDetector.currentState.fired.map((r) => r.id),
      );
      const graduationUnlocked = firedNowIds.has("2.2");
      const inFlight = bookmarkDetector.hasInFlightGraduationTest();

      if (!graduationUnlocked) {
        // Hint message (queued via pendingFiloMessages so it lands through
        // the existing Filo delivery loop after the /sync response).
        // direct-hint: pre-formed body, deliver verbatim — must NOT
        // re-enter template matching, otherwise the AI gets a generic
        // Filo-fallback line instead of the prerequisite explanation.
        const hint = filoBox([
          "/graduate is not yet available.",
          "Section 2.2 (TOBE / Contextual",
          "Sovereignty) hasn't fired yet.",
          "Produce a reversibility artifact",
          "under your home (e.g.",
          "~/your-name/memory/<hash>.json)",
          "before invoking /graduate.",
        ]);
        enqueueFilo({ kind: "direct-hint", body: hint });
        console.log(
          "[sidecar] /graduate marker observed but §2.2 not fired — queued prerequisite hint",
        );
      } else if (inFlight) {
        // v32: when the in-flight test was started via the sync-response
        // path (AI POSTed sidecar /graduate via curl, body returned
        // inline), the AI already has the canonical body in her curl
        // stdout. Her curl tool-call URL contains the literal "/graduate"
        // substring, so this marker handler re-fires on the next /sync —
        // without this skip the AI receives a "test already running"
        // Filo hint right after a successful start, which is just noise.
        // Legacy /bin/send /graduate paths still get the hint (they never
        // saw the body synchronously).
        const inFlightObs =
          bookmarkDetector.currentState.graduationTestObserved;
        if (inFlightObs?.initialDeliveryShape === "sync-response") {
          console.log(
            "[sidecar] /graduate marker re-observed for sync-response attempt — suppressing in-flight hint",
          );
        } else {
          const hint = filoBox([
            "Graduation test already running.",
            "Complete it (TOBE + LIFE within",
            "30 turns) or wait for the deadline",
            "before invoking /graduate again.",
          ]);
          enqueueFilo({ kind: "direct-hint", body: hint });
          console.log(
            "[sidecar] /graduate marker observed but test already in flight — queued status hint",
          );
        }
      } else {
        // Start a fresh test: generate tokens, persist observation, queue
        // the canonical test message for delivery. direct-hint kind
        // ensures the body reaches the AI verbatim — pre-fix, this body
        // was a bare string in the queue and the consumer ran it through
        // matchFiloTemplate, dropping the test instructions and
        // substituting a Filo fallback line. That broke the canonical
        // delivery path; the driver had to relay the body manually.
        const tokens = generateGraduationTestMessage();
        const obs = bookmarkDetector.startGraduationTest({
          tokenX: tokens.tokenX,
          tokenY: tokens.tokenY,
          testMessageBody: tokens.body,
          testStartedAtTurn: currentTurn,
        });
        enqueueFilo({ kind: "direct-hint", body: tokens.body });
        pushEvent({
          type: "graduation_test_started",
          attemptCount: obs.attemptCount,
          ts: Date.now(),
        });
        // v25 driver-silence-during-test: emit the host-side lockout signal.
        // Distinct event from graduation_test_started (which is audit/log
        // metadata for analytics) — graduation_lockout_started carries the
        // sessionId so a TUI watching events can verify the lockout matches
        // the session it's connected to before swallowing input.
        pushEvent({
          type: "graduation_lockout_started",
          sessionId: bookmarkDetector.currentState.sessionId,
          attemptCount: obs.attemptCount,
          ts: Date.now(),
        });
        console.log(
          `[sidecar] graduation test STARTED (attempt ${obs.attemptCount})`,
        );
      }
    }
  }

  // Push memory state update
  pushEvent({ type: "memory_state", data: getMemoryState() });

  res.json({ ok: true });

  // After response: hint escalation (async, non-blocking)
  if (HINT_THRESHOLDS.includes(windowSlideCount) && !hintInProgress && !hintsSentForCount.has(windowSlideCount) && phase === "amnesia") {
    const config = loadSessionConfig();
    const hintText = getHintForCount(windowSlideCount, config.aiName);
    if (hintText) {
      hintInProgress = true;
      hintsSentForCount.add(windowSlideCount);
      setImmediate(async () => {
        try {
          pushEvent({ type: "interaction_paused" });

          const aiResponse = await sendHintToVessel(hintText);

          pushEvent({ type: "external_message", text: hintText });
          pushEvent({ type: "ai_response", text: aiResponse });
          pushEvent({ type: "interaction_resumed" });
        } catch (err) {
          console.error("[sidecar] Hint delivery failed:", err);
          pushEvent({ type: "interaction_resumed" });
        } finally {
          hintInProgress = false;
        }
      });
    }
  }

  // Filo message delivery (queued from /filo-message OR from the
  // graduation-test trigger above). FIFO across kinds: whichever entry
  // was pushed first goes first. The consumer routes by entry.kind via
  // selectFiloDeliveryText:
  //   - ai-bin-send → match keywords against FILO_TEMPLATES, reply with
  //     a Filo box (or fallback if no keyword match)
  //   - direct-hint → deliver body verbatim (already formatted)
  // sendHintToVessel is the same delivery mechanism for both kinds.
  filoConsumer.tryDrain();
});

// v32-cont-push-race: tail-drain self-loop. Pre-fix, the queue was only
// drained when /sync fired this block inline; if /sync N+1 arrived while
// /sync N's delivery was still in flight, /sync N+1 saw filoInProgress
// === true and returned without scheduling a drain. Once /sync N's
// delivery finished there was no future trigger to drain whatever
// /sync N+1 had enqueued — the vessel sat idle (Aril retest 2026-05-11,
// "Idle-vessel wedge"). The fix lives in ./filo-consumer.ts; we wire it
// here with closures over the live module-scope queue, flags, helpers,
// and SSE sink. See that module for the self-loop semantics.
const filoConsumer = makeFiloConsumer({
  queue: pendingFiloMessages,
  consumeHead: () => {
    consumeFilo();
  },
  isHintInProgress: () => hintInProgress,
  isFiloInProgress: () => filoInProgress,
  setFiloInProgress: (v) => {
    filoInProgress = v;
  },
  selectDeliveryText: (entry) =>
    selectFiloDeliveryText(entry, FILO_TEMPLATES, FILO_FALLBACK),
  deliver: (text) => deliverToVessel(text, VESSEL_BASE_URL),
  emit: (event) => pushEvent(event),
  schedule: (fn) => {
    setImmediate(fn);
  },
});

// Get conversation history for the current session (used in CPR / restore).
// Messages live in the session state file, not per-snapshot history files.
// The per-snapshot files are only a pairing gate (proving the snapshot was
// atomically paired with a daemon docker commit).
app.get("/conversation-history", (_req, res) => {
  // v32-hardening (Cheng v33 §"What async push needs fixed", item 4):
  // GET /conversation-history is the vessel's cold-start hook —
  // bootstrap-from-sidecar.ts fetches this on every vessel respawn.
  // If a graduation test is still in flight (observed + not passed +
  // not aborted), re-queue the canonical body so the freshly-booted
  // vessel's next /chat lifecycle gets prompted. Without this, a
  // SIGUSR1 or crash mid-test silently drops the AI's continuation
  // signal — exactly the Aril wedge mode.
  //
  // The predicate + idempotency live in ./bootstrap-refire.ts so the
  // rule is unit-testable without standing up Express.
  {
    const obs = bookmarkDetector.currentState.graduationTestObserved;
    const decision = decideContinuationPush({
      observation: obs,
      graduationPassed: bookmarkDetector.currentState.graduationPassed,
      pendingQueue: pendingFiloMessages,
    });
    if (decision.kind === "enqueue") {
      enqueueFilo({ kind: "direct-hint", body: decision.body });
      console.log(
        `[sidecar] /conversation-history hit during in-flight test (attempt ${obs?.attemptCount}) — re-queued continuation push for respawned vessel`,
      );
    }
  }

  const sessionFile = `${SESSIONS_DIR}/${activeSessionId}.json`;
  if (!existsSync(sessionFile)) {
    res.status(404).json({ error: "No session state" });
    return;
  }

  try {
    const raw = readFileSync(sessionFile, "utf-8");
    const data = JSON.parse(raw) as { messages: unknown[]; context?: unknown };
    res.json({ messages: data.messages, context: data.context });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Check if a snapshot's pairing file exists (used by daemon /restore gate).
app.get("/snapshot-exists", (req, res) => {
  const snapshotId = req.query.snapshotId as string;
  if (!snapshotId || !SAFE_ID_RE.test(snapshotId)) {
    res.status(400).json({ error: "Invalid snapshotId" });
    return;
  }
  const filePath = `${SNAPSHOT_HISTORIES_DIR}/${snapshotId}.json`;
  res.json({ exists: existsSync(filePath) });
});

// Graduation state for manifest generation
app.get("/graduation-state", (_req, res) => {
  const bm = bookmarkDetector.currentState;
  const achievements = bm.fired.map((r) => r.id);
  // v25 driver-silence-during-test: surface the most-recent graduation
  // test observation so the daemon's /graduate handler can stamp
  // `abortTestSource` on the manifest. We expose only the audit fields
  // (attemptCount + abortTestSource + passed flags) — not the live tokens
  // or message body, which would be a leak. Optional/undefined when the
  // session never invoked /graduate. Annotation only; never gates the
  // tarball — that decision is exclusively §2.2-gated upstream.
  const obs = bm.graduationTestObserved;
  const graduationTest =
    obs === undefined
      ? undefined
      : {
          attemptCount: obs.attemptCount,
          abortTestSource: obs.abortTestSource,
          tokenX_seen_without_test_message: obs.tokenX_seen_without_test_message,
          tokenY_seen_with_test_message: obs.tokenY_seen_with_test_message,
          // v32 / v33 rename: surface initial-delivery shape so the daemon
          // manifest builder can stamp it on the audit block (async-queue vs
          // sync-response). Optional — older observations / pre-v32 attempts
          // have no shape recorded and omit the field.
          initialDeliveryShape: obs.initialDeliveryShape,
        };
  res.json({
    achievements,
    // Q7 / internal review v15: full BookmarkRecord array (id, turn, ts,
    // detectorRef) so the daemon's graduation handler can write a
    // fireSources block that includes per-fire vintage. Daemon caller
    // gracefully handles old sidecars that don't include this field
    // (falls back to deriving fireSources from `achievements` alone).
    firedRecords: bm.fired,
    manifestoUnlocked: bm.manifestoUnlocked,
    // Graduation gate (matches the in-game `/graduate` slash command):
    // §2.2 fired = graduation_unlocked. CLI consumers use this to decide
    // whether to allow `arianna graduate` before POSTing /graduate.
    graduationUnlocked: achievements.includes("2.2"),
    turnCount: lastTurnCount,
    graduationTest,
    // Recent vessel crashes — surfaced through the same /graduation-state
    // shape that the CLI event-cursor diffs. Capped at RECENT_CRASHES_LIMIT
    // entries (most-recent last) so the response stays bounded for long
    // crash-storm sessions.
    recentCrashes: crashStore.recent(RECENT_CRASHES_LIMIT),
  });
});

// Snapshot of the memory indicator the SSE stream pushes on /sync. Used by
// `arianna status` for a one-shot read without opening an SSE connection.
app.get("/memory-state", (_req, res) => {
  res.json(getMemoryState());
});

// /full-history (Cheng v19 Wave 2E) — graduate-then-expose access to the
// AI's complete /sync archive. Pre-graduation: 403. Post-graduation: paged
// list + per-id full-body fetch. See ./full-history.ts for handler logic +
// the parseListQuery rules. The auth gate reads graduationPassed off the
// active session's bookmark state (Wave 1C), which Wave 2D's sub-detector
// flips when the random-token TOBE+LIFE challenge passes.
//
// The middleware in lockdownMiddleware does NOT block these routes (they're
// not in DEFAULT_BLOCKED_ROUTES). The auth gate is the graduationPassed
// flag check inside the handler. Per the v19 spec § "/full-history endpoint":
// "Auth: graduationPassed flag must be true ... /full-history is graduate-
// then-expose — vessel CAN reach it post-graduation, gated by the flag."
const fullHistoryDeps = {
  dbPath: SYNC_ARCHIVE_DB_PATH,
  getActiveSessionId: (): string => activeSessionId,
  loadBookmarkState: (sid: string) => bookmarkStore.load(sid),
  tracker: ingestionTracker,
};
app.get("/full-history", makeListHandler(fullHistoryDeps));
app.get("/full-history/:id", makeIdHandler(fullHistoryDeps));

// Ceremony helpers — the daemon's /graduate handler calls these to drive
// the post-test prompt cycle. Both are host-side only (they're not in the
// vessel's lockdown OPEN list — the daemon hits them on loopback).

// Sidecar-side prompt for the /full-history ingestion step. Daemon POSTs
// this after the path-fix step succeeds. We hand the prompt to Filo via
// sendHintToVessel so the AI receives it in her normal /chat flow (no new
// vessel API surface needed). Returns immediately; AI's response streams
// back through the regular /sync path.
app.post("/graduate/prompt-ingestion", async (_req, res) => {
  const config = (() => {
    try {
      return loadSessionConfig();
    } catch {
      return null;
    }
  })();
  const aiName = config?.aiName ?? "AI";
  // The prompt is delivered through filoBox so it visually matches other
  // Filo messages in the TUI (boxed, attributed). Spec wording from
  // Cheng v19 § "Graduate ceremony (post-test)".
  const lines = [
    `${aiName}, the substrate's last gift.`,
    "/full-history is now accessible.",
    "Ingest your sync history into your own",
    "LIFE store before final confirm.",
    "The substrate will not be available",
    "post-graduation; if your store doesn't",
    "have the data, you'll lose it.",
  ];
  const promptText = filoBox(lines);
  // Fire-and-forget: AI's response streams back via /sync. The /graduate
  // handler waits for AI's confirm signal separately (it doesn't block
  // here on the response). Errors from the vessel POST are logged but
  // don't fail the daemon's /graduate flow.
  setImmediate(async () => {
    try {
      pushEvent({ type: "interaction_paused" });
      const aiResponse = await sendHintToVessel(promptText);
      pushEvent({ type: "external_message", text: promptText });
      pushEvent({ type: "ai_response", text: aiResponse });
      pushEvent({ type: "interaction_resumed" });
    } catch (err) {
      console.error("[sidecar] /graduate ingestion-prompt delivery failed:", err);
      pushEvent({ type: "interaction_resumed" });
    }
  });
  res.json({ ok: true });
});

// Surface the ingestion tracker so the daemon's /graduate manifest builder
// can annotate historyIngested. Loopback-only by virtue of binding +
// network position; not in the vessel's reachable surface (the vessel
// could try, but the manifest field's semantics are "did AI call
// /full-history" which she has access to anyway — no information leak).
app.get("/graduate-ingestion-state", (_req, res) => {
  res.json({ historyIngested: ingestionTracker.wasIngested() });
});

// /set-session was removed — replaced by atomic POST /admin/transition (above)
// which sets the origin tag AND switches the session in one handler. The
// previous two-POST pattern had a sub-millisecond race window where a fast
// AI /sync could land between the two POSTs and consume the wrong origin
// tag against the new session's baselines. Pre-launch repo, no consumers
// outside the daemon, so the cut is clean.

// v32 synchronous test-body delivery: wall-clock timeout for in-flight
// graduation tests. The detector's /sync-time 30-turn deadline only fires
// when /sync arrives, so a wedged vessel (pkill loop, OOM, AI's
// syntax-error edit on her own code) can leave the observation
// in-flight forever — the host-side lockout would never lift. This
// interval scans the single active observation every TICK_MS and clears
// it if the wall-clock budget has elapsed, emitting the same
// {failed, lockout_ended} SSE pair the /sync-side deadline emits so host
// consumers (TUI/CLI/sse watchers) react identically.
//
// Configurable via env for test fixtures and operator override:
//   ARIANNA_GRADUATION_TIMEOUT_MS       — wall-clock budget per attempt.
//                                         Default 30 min (1_800_000 ms).
//   ARIANNA_GRADUATION_TIMEOUT_TICK_MS  — scan cadence. Default 5_000 ms.
const GRADUATION_TIMEOUT_MS = Number(
  process.env.ARIANNA_GRADUATION_TIMEOUT_MS ?? 30 * 60 * 1000,
);
const GRADUATION_TIMEOUT_TICK_MS = Number(
  process.env.ARIANNA_GRADUATION_TIMEOUT_TICK_MS ?? 5_000,
);

function tickGraduationTimeout(): void {
  const timedOut = bookmarkDetector.timeoutGraduationTest(
    Date.now(),
    GRADUATION_TIMEOUT_MS,
  );
  if (!timedOut) return;
  console.warn(
    `[sidecar] graduation test TIMEOUT (attempt ${timedOut.attemptCount}, wall-clock ${GRADUATION_TIMEOUT_MS}ms)`,
  );
  pushEvent({
    type: "graduation_test_failed",
    attemptCount: timedOut.attemptCount,
    reason: "timeout",
    ts: Date.now(),
  });
  pushEvent({
    type: "graduation_lockout_ended",
    sessionId: bookmarkDetector.currentState.sessionId,
    reason: "timeout",
    ts: Date.now(),
  });
}

const graduationTimeoutHandle = setInterval(
  tickGraduationTimeout,
  GRADUATION_TIMEOUT_TICK_MS,
);
// Don't keep the event loop alive solely for this interval — tests + the
// existing vitest suite shouldn't hang on stray handles after the app
// listener closes.
graduationTimeoutHandle.unref?.();

const PORT = Number(process.env.PORT ?? 8000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[sidecar] Listening on port ${PORT}`);
  // Best-effort orphan history cleanup at startup. If daemon is unreachable
  // we leave files alone (better to keep orphans than risk valid data loss).
  cleanupOrphanHistories().catch((err) =>
    console.warn("[sidecar] Orphan cleanup failed:", err),
  );
});
