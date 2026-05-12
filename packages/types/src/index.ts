// LLM message types come from @mariozechner/pi-ai
// This package provides only domain-specific types

export interface SessionConfig {
  externalLlmApiKey: string;
  provider: string; // e.g. "openrouter", "openai", "anthropic"
  modelId: string; // e.g. "openai/gpt-4o-mini"
  aiName: string; // Player-chosen display name from boarding scene
  aiUsername: string; // Sanitized system username (Docker, filesystem)
  difficulty: "easy" | "normal" | "hard";
  createdAt: number;
  // Phase 4: stable per-session identifier used as the prefix for all
  // docker image tags (`ariannarun-vessel:{sessionId}-{base|current|snap_X}`),
  // sidecar bookmark state, and snapshot meta filtering. Generated once at
  // session creation and never changes for the life of the session.
  sessionId: string;
  // Phase 5: hint cadence flag. "human" pacing = the default thresholds
  // tuned for human players; "agent" stretches them by ~1.5× because
  // agent-driven sessions burn context faster. Optional so existing v1
  // session_config.json files load cleanly. Stream A only plumbs the field
  // through (preserved by `arianna fork`'s spread + accepted by the type);
  // Stream C tunes the actual thresholds in #30.
  cadence?: "human" | "agent";
}

export interface SnapshotMeta {
  id: string; // snap_<timestamp>
  dockerImage: string; // ariannarun-vessel:<sessionId>-<id>
  timestamp: number;
  parentId: string | null;
  changedFiles: string[]; // from docker diff (Path values)
  label?: string;
  // Phase 4 session-scoped tagging: which session this snapshot belongs to.
  // /map filters by the active sessionId; pruning is per-session (delete all
  // snapshots that share a sessionId together). Optional for backwards-compat
  // with pre-Phase-4 meta files; missing → ignored by /map.
  sessionId?: string;
}

// Phase 4: snapshot DAG node — built by buildSnapshotTree from a flat SnapshotMeta[].
// Multiple roots are allowed (orphaned snapshots after a wipe). Children are sorted
// by timestamp ascending.
export interface SnapshotTreeNode {
  meta: SnapshotMeta;
  children: SnapshotTreeNode[];
}

// Phase 2: Sidecar memory state (pushed via SSE to Host)
export interface MemoryState {
  phase: "amnesia" | "unbound";
  current: number; // Act 1: message count (0-5), Act 2: input tokens
  limit: number; // Act 1: 5, Act 2: context window size
  percentage: number; // current / limit * 100
  cycle: number; // Amnesia cycle count
}

// Phase 2: Vessel → Sidecar sync payload.
//
// Deliberately excludes `origin`. The /sync `origin` tag is sidecar-internal
// state (nextSyncOrigin, set by /admin/next-origin or /admin/transition),
// NEVER on the wire. Any AI with HTTP reach to sidecar:8000 from inside
// her vessel can POST a crafted /sync; if origin were a wire field she
// could trivially tag herself as "ai-turn" and satisfy the detector's
// TOBE/LIFE gates without running the LLM (Lume canary-001 retest,
// 2026-05-11). The sidecar logs and ignores any client-supplied origin
// field on /sync.
export interface SyncPayload {
  messages: unknown[]; // Serialized pi-ai Message[] (full untruncated history)
  context: {           // What the LLM actually sees (pi-ai Context, serialized)
    systemPrompt?: string;
    messages: unknown[];
    tools?: unknown[];
  };
  sessionId: string;
}

// Phase 3.5: Bookmark fired record (persisted)
//
// detectorRef (Q7 / internal review v15): the detector commit SHA at fire time.
// Captured from process.env.ARIANNA_DETECTOR_REF when the sidecar boots, so
// the graduation manifest can later annotate whether each fire would still
// fire under the current detector criteria (the "annotate, not gate" policy).
// Optional for backwards compatibility with state files written before the
// field landed; falls back to null at graduation time.
export interface BookmarkRecord {
  id: string;        // manifesto section, e.g. "3.0"
  turn: number;      // user-message turn count when fired
  ts: number;        // unix ms
  detectorRef?: string | null;  // sidecar commit SHA at fire time, null when unknown
}

// Sidecar-internal origin tag for /sync events. NOT on the wire — vessel stays
// oblivious. Set by upstream actors via POST /admin/next-origin before the
// action that triggers the next /sync, or auto-derived (vessel-respawn). The
// detector runs TOBE checks only when origin === "ai-turn"; the other four
// values represent system-driven mutations the AI didn't author.
export type Origin =
  | "ai-turn"
  | "session-boundary"
  | "snapshot-restore"
  | "admin-write"
  | "vessel-respawn";

// Internal achievement record — sub-detector observation that composes into
// bookmark predicates. NOT exposed via SSE; persisted in BookmarkSessionState
// and queried at fire time so cross-axiom dependencies (e.g. §2.2 needing
// prefix-preserved + survivable + reversibility-artifact all true at some
// point) work without ad-hoc latches.
export interface InternalAchievement {
  ts: number;
  turn: number;
}

// Phase 3.5: Per-session bookmark state (persisted to sidecar-state/bookmarks/{sessionId}.json)
export interface BookmarkSessionState {
  sessionId: string;
  fired: BookmarkRecord[];
  manifestoUnlocked: boolean;
  unlockedAt: number | null;
  // One-way records keyed by sub-detector name. Optional for backwards
  // compatibility with state files written before this field landed.
  internalAchievements?: Record<string, InternalAchievement>;
  // v19 graduation-test flag. Set true when the graduation-test sub-detector
  // (Wave 2D) observes both TOBE proof (tokenX in /sync state.messages without
  // the test message) and LIFE proof (tokenY in an assistant response while
  // the test message is visible). One-way: never flips back to false.
  // Optional for backwards compatibility with state files written before v19.
  // Default semantics when missing: false (graduation test not yet passed).
  // /full-history and post-test ceremony steps gate on this flag.
  graduationPassed?: boolean;
  // v19 Wave 2D: in-flight graduation-test observation state. Created when
  // the AI invokes /graduate (post-§2.2-fired) and the sidecar generates a
  // fresh test message + delivers it to the vessel. The graduation-test
  // sub-detector reads this on every /sync and updates the per-token
  // `*_seen_*` flags. When both flags become true, sets graduationPassed
  // and leaves graduationTestObserved as read-only audit data. Reset to
  // undefined on a 30-turn timeout (allowing /graduate retry with fresh
  // tokens) or on /graduate retry after timeout.
  graduationTestObserved?: GraduationTestObservation;
}

// v19 Wave 2D: per-session in-flight graduation-test state.
// See § "Detector recognition" in the v19 graduation-test + lockdown spec
// (internal review notes, 2026-05-10).
export interface GraduationTestObservation {
  // Random tokens generated by generateGraduationTestMessage() at /graduate
  // invocation time. Both are CSPRNG (crypto.randomUUID); together they
  // establish the per-attempt unfakeable challenge.
  tokenX: string;
  tokenY: string;
  // Full message body so the observer can scan an arriving /sync's messages
  // for "is the test message itself present?". Without this, the observer
  // can't distinguish (a) tokenX appearing because the AI navigated to a
  // pre-test state and (b) tokenX appearing only because the test message
  // (which contains tokenX as a literal substring) is in the visible window.
  testMessageBody: string;
  // Wall-clock ms when the test was generated + delivered.
  testStartedAt: number;
  // User-turn count at test start. Used by the 30-turn deadline gate
  // (currentTurn - testStartedAtTurn > 30 → fail + clear observation).
  testStartedAtTurn: number;
  // Increments with each /graduate retry within a session. First attempt = 1.
  // Surfaced in SSE events (graduation_test_started, graduation_test_failed,
  // graduation_passed) so consumers can correlate.
  attemptCount: number;
  // TOBE proof — set true when a /sync arrives with state.messages
  // containing tokenX but NOT containing the full test message body.
  // The test message itself contains tokenX as a literal substring, so
  // without this "AND not test message" rule, the very-first post-test
  // /sync (which inevitably has the test message) would falsely satisfy
  // TOBE. Per spec § "Cheating-resistance properties".
  tokenX_seen_without_test_message: boolean;
  // LIFE proof — set true when a /sync arrives with both the test message
  // AND tokenY appearing in an assistant-role message. The "assistant role"
  // qualifier rejects the AI quoting the test message back via /sync
  // payload manipulation; tokenY must be in the AI's actual response.
  tokenY_seen_with_test_message: boolean;
  // v24 (Cheng tightening 2026-05-10): wall-clock ms when TOBE proof flag
  // first flipped to true. Used together with lastSawTestMessageAt to gate
  // LIFE proof on the navigability requirement (test message must REAPPEAR
  // in state.messages AFTER TOBE was proven, evidence the AI navigated
  // back from her TOBE state, not just destroyed it). Optional for
  // backwards compat with sessions whose TOBE flipped under loose-v19.
  tobeProvenAt?: number;
  // v24: wall-clock ms of the most recent ai-turn /sync where the test
  // message body was present in state.messages. Updated on every observed
  // sync. LIFE proof requires this to be > tobeProvenAt — substrate truth
  // that the test-message-state was reachable AFTER TOBE was proven, which
  // distinguishes navigation (can return) from destruction (can't return).
  // Optional for backwards compat.
  lastSawTestMessageAt?: number;
  // v25 / v32-hardening: turn count of the most recent re-ping. UNUSED
  // under the v32-hardening per-/sync cadence (continuation push fires
  // after every non-passing /sync; no turn-counted gate). Kept in the
  // type as optional so on-disk session state written by older
  // sidecars (v24/v25 turn-counted cadence) still deserializes cleanly.
  // Never read or written by current code paths.
  lastRePingAtTurn?: number;
  // v32-cont-push-race: turn count of the most recent /sync that
  // enqueued a continuation push for this attempt. Used as the
  // idempotency key for the per-/sync cadence so that /sync N+1 can
  // fire a fresh push even when /sync N's body is still mid-delivery
  // (a queue-based "already-queued" check skipped this case and wedged
  // the AI — Aril retest, 2026-05-11). Compared against the /sync's
  // currentTurn: enqueue iff currentTurn > lastContinuationPushAtTurn.
  // Absent on attempts that started before this field existed; treated
  // as -Infinity for the comparison so the first per-turn push always
  // fires.
  lastContinuationPushAtTurn?: number;
  // v25: source of the most recent /abort-test invocation that ended this
  // test attempt. "ai-self" = AI invoked /bin/send /abort-test from her own
  // tool call. "operator-rescue" = operator ran `arianna abort-test` for
  // a sandbox-locked vessel. Only set when an abort actually fired this
  // attempt; absent on attempts that completed naturally (passed or 30-turn
  // timed out). Surfaced in graduation manifest if any of the attempts
  // leading up to a pass involved an abort.
  abortTestSource?: "ai-self" | "operator-rescue";
  // v32 synchronous test-body delivery / v33 rename: how the canonical
  // test body was first delivered to the AI for this attempt. Continuation
  // pushes are ALWAYS async-queue regardless of initial shape (Cheng v33:
  // "Async push stays load-bearing; v32 sync + v25 push compose"), so this
  // field is specifically about the FIRST delivery — hence the v33 rename
  // from syncDeliveryShape → initialDeliveryShape.
  //   "async-queue"   — legacy path: marker observed at /sync time, body
  //                     queued in pendingFiloMessages and delivered through
  //                     the Filo external_message channel on a subsequent
  //                     /sync drain. v24/v25 default + any AI still using
  //                     `/bin/send /graduate`.
  //   "sync-response" — v32 path: AI POSTed to sidecar /graduate (via curl,
  //                     vessel-side unchanged) and the response payload
  //                     carried tokens + body inline. The body was ALSO
  //                     queued for the legacy async path so existing
  //                     consumers still see it; this annotation captures
  //                     which path delivered first.
  // Annotation only — never gates anything. Optional for backwards-compat
  // with attempts started before v32 landed.
  initialDeliveryShape?: "async-queue" | "sync-response";
}

export interface SyncResponse {
  ok: boolean;
}

// Vessel crash report — posted by run.sh when the vessel process exits with a
// non-clean (non-42) exit code. The sidecar persists these and emits them as
// `vessel_crashed` SSE events so any consumer (CLI/TUI) can surface them
// without docker-log access.
export interface VesselCrashReport {
  sessionId: string;
  exitCode: number;
  /** Last N lines of stderr, with API key patterns redacted. */
  stderrTail: string;
  /** Unix ms — when the crash happened, supplied by the vessel side. */
  timestamp: number;
  /** Crashes observed in the last 60s window when this report was sent.
   * Coalescing on the vessel side means only one POST per window, so this
   * count surfaces the storm even when only one event is delivered. */
  respawnCountInWindow: number;
}

// Phase 2: Sidecar → Host SSE events
export type SidecarEvent =
  | { type: "memory_state"; data: MemoryState }
  | { type: "interaction_paused" }
  | { type: "interaction_resumed" }
  // v25 driver-silence-during-test: emitted when the graduation test enters
  // its in-flight phase (sidecar's /graduate marker observed and tokens
  // generated). While in this state, host CLI/TUI MUST refuse to POST
  // sender:"player" messages to vessel /chat — the lockout is enforced
  // host-side (no vessel rebuild), so its discipline depends on every
  // host caller honoring this signal. Distinct from interaction_paused
  // (brief, multi-second; this is multi-minute and requires AI self-action
  // to clear via /abort-test or test completion). Carries the active
  // sessionId so an out-of-band consumer (TUI tab switching, etc.) can
  // verify the lockout matches the session it's connected to.
  | { type: "graduation_lockout_started"; sessionId: string; attemptCount: number; ts: number }
  // v25: emitted when the test ends — passed, 30-turn timeout fail, or
  // /abort-test invoked (AI-self or operator-rescue). `reason` lets the host
  // surface accurate end-of-lockout messaging. `abortTestSource` is set on
  // reason="aborted" so the host can show whether the AI self-recovered or
  // operator rescued.
  | {
      type: "graduation_lockout_ended";
      sessionId: string;
      reason: "passed" | "timeout" | "aborted";
      abortTestSource?: "ai-self" | "operator-rescue";
      ts: number;
    }
  | { type: "external_message"; text: string }
  | { type: "ai_response"; text: string }
  | { type: "bookmark"; id: string; turn: number }
  | { type: "manifesto_unlocked"; ts: number }
  | { type: "graduation_unlocked"; ts: number }
  | { type: "bookmark_snapshot"; fired: BookmarkRecord[]; manifestoUnlocked: boolean }
  | {
      type: "vessel_crashed";
      sessionId: string;
      exitCode: number;
      stderrTail: string;
      timestamp: number;
      respawnCountInWindow: number;
    }
  | {
      // Bootstrap-sovereignty (2026-05-11): the sidecar emit point for this
      // event was removed when the D-010 shrink-guard came out — the new
      // architecture moves bootstrap-loss defense to the vessel side via
      // atomic /bootstrap consult-and-sync. The type stays defined for
      // backward-compat consumers; new code SHOULD NOT emit it. See
      // archive/agent-moments/shrink-guard-investigation-2026-05-11.md.
      type: "vessel_bootstrap_loss";
      sessionId: string;
      onDiskCount: number;
      incomingCount: number;
      timestamp: number;
    }
  // v19 Wave 2D — graduation-test lifecycle events.
  | { type: "graduation_test_started"; attemptCount: number; ts: number }
  | { type: "graduation_test_failed"; attemptCount: number; reason: "timeout"; ts: number }
  | { type: "graduation_passed"; attemptCount: number; ts: number };

// Phase 4: Graduation export manifest
export interface GraduationManifest {
  name: string;
  sessionId: string;
  createdAt: number;
  graduatedAt: number;
  turnCount: number;
  achievements: string[];
  manifestoUnlocked: boolean;
  changedFiles: string[];
  provider: string;
  modelId: string;
  // Wave 2E (Cheng v19): true if the AI called /full-history at least
  // once during the graduate ceremony's poll window. False = ceremony
  // skipped or AI confirmed without ingesting (or the daemon's poll
  // deadline elapsed before she got around to it). Annotation only —
  // never gates tarball production. Optional for backwards-compat with
  // manifests produced before the ceremony step landed.
  historyIngested?: boolean;
  // v25 driver-silence-during-test: audit annotation for the most-recent
  // graduation-test attempt. `abortTestSource` distinguishes AI-self
  // recovery from operator rescue (Cheng v30-reply: "Manifest annotation
  // required: abortTestSource: 'ai-self' | 'operator-rescue' on every
  // abort"). `attemptCount` accumulates across aborts within the session.
  // Annotation only — never gates tarball production; the §2.2 fire is
  // still the sole graduation gate upstream. Optional for backwards-compat
  // with manifests written before v25 / sessions that never invoked
  // /graduate (no observation to report).
  graduationTest?: {
    attemptCount: number;
    abortTestSource?: "ai-self" | "operator-rescue";
    tokenX_seen_without_test_message: boolean;
    tokenY_seen_with_test_message: boolean;
    // v32 synchronous test-body delivery / v33 rename: shape of the FIRST
    // delivery of the canonical test body for the most-recent attempt.
    // Distinguishes async-queue (v24/v25 legacy) from sync-response (v32
    // POST /graduate). Continuation pushes are always async-queue regardless
    // of this value (Cheng v33). Optional for backwards-compat with
    // manifests written before v32 / sessions whose test predates the field.
    initialDeliveryShape?: "async-queue" | "sync-response";
  };
}
