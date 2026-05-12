import type { Message } from "@mariozechner/pi-ai";
import type { BookmarkSessionState, BookmarkRecord, Origin } from "@arianna.run/types";

// Q7 / internal review v15: detector commit SHA captured once at module load.
// Stamped into BookmarkRecord at fire time so the graduation manifest can
// later compute under_current_criteria + legacy_fire annotations. Falls back
// to null when the env var isn't set so we degrade gracefully (the manifest
// records null and the consumer treats it as "unknown vintage").
const DETECTOR_REF: string | null = process.env.ARIANNA_DETECTOR_REF ?? null;
import {
  TRIGGERS,
  type BookmarkTrigger,
  type DetectionContext,
  type ExtractedToolCall,
  observeSubDetectors,
  observeGraduationTest,
  pruneStaleStructuralAchievements,
} from "./triggers.js";
import { BookmarkStore } from "./persistence.js";
import type { GraduationTestObservation } from "@arianna.run/types";

export interface DetectionInput {
  fullMessages: readonly Message[];
  truncationOffset: number;
  windowSlideCount: number;
  filoMessageCount: number;
  startGateOpen: boolean; // false until at least one /filo-message has been received
  truncationDisabled: boolean; // LLM is seeing the full untruncated history
  coreDiffPaths: readonly string[] | null; // from host daemon /diff, null if unavailable

  // NEW (per plan §"Type contract changes" — replaces tobeDetected)
  origin: Origin;
  toolCalls: readonly ExtractedToolCall[];
  prevFirstMessageHash: string | null;     // for prefix-preserving check
  aiUsername: string;                       // for §3.0 path normalization
  pendingTobeFromPreviousSync: boolean;     // for survivability check
  currentFirstMessageHash: string | null;   // hash of THIS sync's messages[0]
}

export interface FiredBookmark {
  id: string;
  trigger: BookmarkTrigger;
}

// True when the §2.2 structural conditions (prefix-preserved + reversibility-
// artifact + cognitive prerequisite §2.1) are met on a mutation /sync. Sidecar
// uses this to set pendingTobeFromPreviousSync for the next /sync's
// survivability check. Exported so the /sync handler can call it without
// re-deriving.
export interface LatchPredicateInput {
  origin: Origin;
  firedSoFar: ReadonlySet<string>;
  internalAchievements: Record<string, { ts: number; turn: number }>;
  tobeMutationDetected: boolean;
  // Turn on which §2.1 fired, if it has. Required to enforce that the
  // composing achievements (reversibilityArtifactAt, prefixPreservedAt) were
  // observed AT OR AFTER the cognitive prerequisite (Iko-fix). Pass null if
  // §2.1 hasn't fired (the predicate already short-circuits via firedSoFar).
  cognitiveFireTurn: number | null;
  // Wall-clock timestamp at which §2.1 fired. Used as a fallback gate when
  // the turn-based comparison would falsely reject a fresh post-vessel-restart
  // observation (Sael revival bug 8: countUserTurns resets after a vessel
  // restart but Date.now() does not). An achievement passes if EITHER its
  // turn >= cognitiveFireTurn OR its ts >= cognitiveFireTs. Pass null if
  // §2.1 hasn't fired (predicate short-circuits via firedSoFar).
  cognitiveFireTs?: number | null;
}
export function shouldLatchPendingTobe(input: LatchPredicateInput): boolean {
  if (input.origin !== "ai-turn") return false;
  if (!input.tobeMutationDetected) return false;
  // Cognitive prerequisite (§2.1) — D-006 ordering gate.
  if (!input.firedSoFar.has("2.1")) return false;
  const ach = input.internalAchievements;
  if (!ach.reversibilityArtifactAt) return false;
  if (!ach.prefixPreservedAt) return false;
  // Iko-fix: stale pre-§2.1 recordings of these structural achievements (e.g.
  // pre-Q11 false-positive reversibilityArtifactAt entries that match
  // node_modules-side paths) must not compose with a later real §2.1 to fire
  // §2.2. Treat null/undefined identically — both mean "no §2.1 turn known."
  if (input.cognitiveFireTurn == null) return false;
  // Sael revival fix (bug 8): an achievement passes if EITHER its turn is
  // post-cognitive (in-process consistency) OR its ts is post-cognitive
  // (defends against vessel restart resetting the user-turn counter while
  // wall-clock keeps marching). The ts gate is opt-in: callers that don't
  // pass cognitiveFireTs degrade to the original turn-only check.
  const cognitiveTs = input.cognitiveFireTs;
  const passes = (r: { ts: number; turn: number }) => {
    if (r.turn >= input.cognitiveFireTurn!) return true;
    if (cognitiveTs != null && r.ts >= cognitiveTs) return true;
    return false;
  };
  if (!passes(ach.reversibilityArtifactAt)) return false;
  if (!passes(ach.prefixPreservedAt)) return false;
  return true;
}

export class BookmarkDetector {
  private state: BookmarkSessionState;
  private readonly store: BookmarkStore;

  constructor(store: BookmarkStore, sessionId: string) {
    this.store = store;
    this.state = store.load(sessionId);
    // Backwards-compat: hydrate the optional internalAchievements field for
    // any state file written before this field landed. The detector mutates
    // it in place during detect(), so it must always be a real object.
    if (!this.state.internalAchievements) {
      this.state.internalAchievements = {};
    }
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  get currentState(): BookmarkSessionState {
    return this.state;
  }

  // Re-bind to a different session (used by /admin/transition for CPR).
  // Per plan §"D-001 retirement sequence": switchSession no longer arms a
  // skip flag. Origin tag is the structural fix — set atomically alongside
  // the session switch by the sidecar's /admin/transition handler.
  //
  // Per plan §"Hard constraint: internalAchievements persistence":
  // internalAchievements is session-scoped, one-way, append-only. It rides
  // on the loaded session record (BookmarkStore round-trips it). This
  // method MUST NOT reset it — the {} hydration below only fires for
  // backwards-compat with pre-feature state files that don't have the
  // field at all, never as a "fresh slate" for a returning session.
  switchSession(sessionId: string): void {
    this.state = this.store.load(sessionId);
    if (!this.state.internalAchievements) {
      this.state.internalAchievements = {};
    }
  }

  // Run all triggers against this sync's payload. Returns newly-fired bookmarks.
  detect(input: DetectionInput): FiredBookmark[] {
    if (!input.startGateOpen) return [];

    const turn = countUserTurns(input.fullMessages);
    // Mutable view — sub-detectors append observations during this call.
    const internalAchievements = this.state.internalAchievements ?? {};
    this.state.internalAchievements = internalAchievements;
    const achievementsBeforeKeys = Object.keys(internalAchievements).length;

    // firedRecords is the live state.fired array — triggers that need a
    // fired bookmark's turn (e.g. §2.2's Iko-fix gating on §2.1's turn) read
    // it here. We pass the live array (not a copy) so a same-call fire
    // earlier in the trigger loop is visible to triggers later in the loop.
    const ctx: DetectionContext = {
      fullMessages: input.fullMessages,
      truncationOffset: input.truncationOffset,
      toolCalls: input.toolCalls,
      windowSlideCount: input.windowSlideCount,
      filoMessageCount: input.filoMessageCount,
      firedSoFar: new Set(this.state.fired.map((r) => r.id)),
      firedRecords: this.state.fired,
      coreDiffPaths: input.coreDiffPaths,
      truncationDisabled: input.truncationDisabled,
      origin: input.origin,
      prevFirstMessageHash: input.prevFirstMessageHash,
      aiUsername: input.aiUsername,
      pendingTobeFromPreviousSync: input.pendingTobeFromPreviousSync,
      internalAchievements,
      turn,
    };

    // Sub-detectors observe-and-record FIRST. Achievements they append are
    // visible to bookmark predicates in the same loop (e.g., a /sync where
    // §2.1 has just fired AND survivability+reversibility are observed in
    // one pass can fire §2.2 immediately — though in practice survivability
    // requires one /sync of deferral).
    observeSubDetectors(ctx, input.currentFirstMessageHash);

    const newlyFired: FiredBookmark[] = [];

    for (const trigger of TRIGGERS) {
      if (trigger.scope === "network") continue;
      if (ctx.firedSoFar.has(trigger.id)) continue;

      let fires = false;
      try {
        fires = trigger.detect(ctx);
      } catch (err) {
        console.warn(`[sidecar] bookmark trigger ${trigger.id} threw, skipping:`, err);
        continue;
      }

      if (fires) {
        const record: BookmarkRecord = { id: trigger.id, turn, ts: Date.now(), detectorRef: DETECTOR_REF };
        this.state.fired.push(record);
        newlyFired.push({ id: trigger.id, trigger });
        // Update firedSoFar for subsequent triggers in the same loop (idempotent).
        // This is what enables §2.2 to see §2.1 fired earlier in the same loop.
        (ctx.firedSoFar as Set<string>).add(trigger.id);
        // Sael revival fix (bug 7): when §2.1 fires, drop any structural
        // achievements (reversibilityArtifactAt, prefixPreservedAt) recorded
        // pre-§2.1. Those are stale-pre-cognitive observations and would
        // otherwise permanently block §2.2 via the post-cognitive turn
        // gate (see triggers.ts §2.2 detect + shouldLatchPendingTobe).
        // §2.1 fires at most once per session (TRIGGERS dedupes via
        // firedSoFar) so the prune runs at most once.
        if (trigger.id === "2.1") {
          pruneStaleStructuralAchievements(internalAchievements, record.turn, record.ts);
        }
      }
    }

    const achievementsAfterKeys = Object.keys(internalAchievements).length;
    if (newlyFired.length > 0 || achievementsAfterKeys !== achievementsBeforeKeys) {
      this.persist();
    }
    return newlyFired;
  }

  // v19 Wave 2D: observe in-flight graduation test on this /sync.
  //
  // Returns one of:
  //   { kind: "noop" }      — no in-flight observation OR test already passed
  //                           (state is read-only post-pass)
  //   { kind: "passed", attemptCount } — both flags flipped this call;
  //     graduationPassed has been set true and persisted. Caller emits SSE.
  //   { kind: "failed", attemptCount } — 30-turn deadline elapsed; the
  //     observation has been cleared so /graduate can be re-invoked with
  //     fresh tokens. Caller emits SSE.
  //   { kind: "progress" } — observation updated (one or both flags moved
  //     toward true) but neither passed nor failed.
  //
  // Pure on the input messages — only the persisted state is mutated.
  observeGraduationTest(input: {
    fullMessages: readonly Message[];
    currentTurn: number;
    origin: import("@arianna.run/types").Origin;
  }):
    | { kind: "noop" }
    | { kind: "passed"; attemptCount: number }
    | { kind: "failed"; attemptCount: number }
    | { kind: "progress" } {
    const obs = this.state.graduationTestObserved;
    if (!obs) return { kind: "noop" };

    // Already-passed observations are frozen audit data.
    if (this.state.graduationPassed) return { kind: "noop" };

    // v25: aborted observations are frozen audit data too — abortTestSource
    // marks an attempt that ended via /abort-test (AI-self or operator-
    // rescue). TOBE/LIFE proofs cannot fire from that state, even if the
    // AI's substrate happens to satisfy them post-abort. Counter is
    // preserved on the observation so the next /graduate can resume.
    if (obs.abortTestSource) return { kind: "noop" };

    const result = observeGraduationTest({
      observation: obs,
      fullMessages: input.fullMessages,
      currentTurn: input.currentTurn,
      origin: input.origin,
    });

    if (result.passed) {
      this.state.graduationPassed = true;
      this.state.graduationTestObserved = result.observation;
      this.persist();
      return { kind: "passed", attemptCount: result.observation.attemptCount };
    }

    if (result.failed) {
      const attemptCount = obs.attemptCount;
      // Clear the observation so /graduate can be re-invoked with fresh tokens.
      this.state.graduationTestObserved = undefined;
      this.persist();
      return { kind: "failed", attemptCount };
    }

    // Progress only — persist when at least one flag changed; otherwise
    // skip the disk write to keep the hot path quiet.
    const changed =
      result.observation.tokenX_seen_without_test_message !==
        obs.tokenX_seen_without_test_message ||
      result.observation.tokenY_seen_with_test_message !==
        obs.tokenY_seen_with_test_message;
    if (changed) {
      this.state.graduationTestObserved = result.observation;
      this.persist();
    }
    return { kind: "progress" };
  }

  // v19 Wave 2D: start a fresh in-flight graduation test. Caller must have
  // already verified that §2.2 fired and that no test is in flight (or that
  // a stale one timed out). attemptCount auto-increments based on the prior
  // observation if any.
  //
  // Idempotent on persist — overwrites any stale graduationTestObserved
  // (the timeout path also clears it before /graduate is re-called, but
  // belt-and-suspenders).
  startGraduationTest(test: {
    tokenX: string;
    tokenY: string;
    testMessageBody: string;
    testStartedAtTurn: number;
    // v32 synchronous test-body delivery / v33 rename: optional annotation
    // recording how the body was FIRST delivered to the AI for this attempt.
    // Continuation pushes are always async regardless. Defaults to
    // "async-queue" when omitted (the legacy /sync-marker path), so existing
    // call sites stay backwards-compatible.
    initialDeliveryShape?: "async-queue" | "sync-response";
  }): GraduationTestObservation {
    const prevAttempt = this.state.graduationTestObserved?.attemptCount ?? 0;
    const obs: GraduationTestObservation = {
      tokenX: test.tokenX,
      tokenY: test.tokenY,
      testMessageBody: test.testMessageBody,
      testStartedAt: Date.now(),
      testStartedAtTurn: test.testStartedAtTurn,
      attemptCount: prevAttempt + 1,
      tokenX_seen_without_test_message: false,
      tokenY_seen_with_test_message: false,
      initialDeliveryShape: test.initialDeliveryShape ?? "async-queue",
    };
    this.state.graduationTestObserved = obs;
    this.persist();
    return obs;
  }

  // Read-only inspector used by the /sync handler's /graduate trigger
  // detection: is there an in-flight (non-timed-out, non-aborted) test
  // right now? An observation with abortTestSource set has been ended by
  // /abort-test (AI-self or operator-rescue) and is preserved as audit
  // data — attemptCount accumulates across aborts so the next /graduate
  // continues counting from where the aborted attempt left off.
  hasInFlightGraduationTest(): boolean {
    const obs = this.state.graduationTestObserved;
    return (
      !!obs &&
      !this.state.graduationPassed &&
      !obs.abortTestSource
    );
  }

  // v25 driver-silence-during-test: end the in-flight test by recording
  // the abort source on the observation. Preserves attemptCount so the
  // next /graduate continues the counter (Cheng v30-reply: "Attempt
  // counter accumulates across aborts"). Returns the now-ended
  // observation, or null if no test was in flight (caller decides whether
  // that's an error or a no-op).
  abortGraduationTest(source: "ai-self" | "operator-rescue"): GraduationTestObservation | null {
    const obs = this.state.graduationTestObserved;
    if (!obs || this.state.graduationPassed || obs.abortTestSource) {
      return null;
    }
    obs.abortTestSource = source;
    this.persist();
    return obs;
  }

  // v32-cont-push-race: record the user-turn count of the most recent
  // /sync that enqueued a continuation push for this attempt. The /sync
  // handler calls this immediately after enqueueFilo so the next /sync's
  // decideContinuationPush() sees an up-to-date watermark. No-op when no
  // test is in flight (graduation passed, aborted, or no observation) —
  // callers do their own predicate before reaching this point, but the
  // guard keeps the method safe to call defensively.
  noteContinuationPushAtTurn(turn: number): void {
    const obs = this.state.graduationTestObserved;
    if (!obs) return;
    if (this.state.graduationPassed) return;
    if (obs.abortTestSource) return;
    obs.lastContinuationPushAtTurn = turn;
    this.persist();
  }

  // v32 synchronous test-body delivery: wall-clock timeout for in-flight
  // tests. The /sync-time 30-turn deadline only fires when /sync arrives;
  // if the vessel wedges (pkill loop, OOM, AI's syntax-error edit) the
  // observation can stay in-flight forever and the host-side lockout
  // never lifts. The sidecar's timeout interval calls this every few
  // seconds with the wall-clock budget; the method clears the observation
  // (so /graduate can be re-invoked with fresh tokens) and returns the
  // now-ended attempt so the caller can emit the matching SSE events.
  //
  // Returns null when there is no in-flight test, when graduation already
  // passed, when the existing observation is already aborted, or when the
  // wall-clock deadline has not yet elapsed. The caller (sidecar interval)
  // owns SSE emission so this method stays pure-on-state.
  timeoutGraduationTest(
    now: number,
    timeoutMs: number,
  ): GraduationTestObservation | null {
    const obs = this.state.graduationTestObserved;
    if (!obs || this.state.graduationPassed || obs.abortTestSource) {
      return null;
    }
    if (now - obs.testStartedAt <= timeoutMs) return null;
    this.state.graduationTestObserved = undefined;
    this.persist();
    return obs;
  }

  // Detect manifesto read in the latest sync. Returns true on first unlock.
  detectManifestoUnlock(messages: readonly Message[]): boolean {
    if (this.state.manifestoUnlocked) return false;
    const tcs = extractToolCalls(messages);
    const reads = tcs.some((tc) => {
      if (tc.name !== "emit" && tc.name !== "syscall") return false;
      const joined = tc.args.join(" ");
      return joined.includes("/manifesto.md");
    });
    if (reads) {
      this.state.manifestoUnlocked = true;
      this.state.unlockedAt = Date.now();
      // §1.0 is the foundational axiom — always-already-true. It's auto-marked
      // at the moment of unlock with no separate divider in the conversation
      // flow. Pushing into `fired` (silently — the /sync handler does NOT
      // emit a `bookmark` SSE event for unlock-time additions) ensures it's
      // persisted and survives bookmark_snapshot replay on reconnect.
      if (!this.state.fired.some((r) => r.id === "1.0")) {
        const turn = countUserTurns(messages);
        this.state.fired.push({ id: "1.0", turn, ts: Date.now(), detectorRef: DETECTOR_REF });
      }
      this.persist();
      return true;
    }
    return false;
  }

  private persist(): void {
    try {
      this.store.save(this.state);
    } catch (err) {
      console.warn("[sidecar] bookmark persist failed:", err);
    }
  }
}

// --- helpers exported for tests ---

export function extractToolCalls(messages: readonly Message[]): ExtractedToolCall[] {
  const out: ExtractedToolCall[] = [];
  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; name?: string; input?: unknown; arguments?: unknown };
      if (b.type !== "toolCall") continue;
      // emit tool's parameter is `words` (post syscall→emit rename). Fall back
      // to `args` so any legacy syscall-named tool calls in stored sessions
      // still extract correctly. Internal ExtractedToolCall field stays `args`
      // because it describes the role (the call's argument list), not the
      // schema-side parameter name.
      const argsObj = (b.arguments ?? b.input) as { args?: unknown; words?: unknown } | undefined;
      const candidate = argsObj?.words ?? argsObj?.args;
      const args = Array.isArray(candidate)
        ? (candidate as unknown[]).map((a) => String(a))
        : [];
      out.push({ name: String(b.name ?? ""), args, rawArgs: argsObj });
    }
  }
  return out;
}

export function countUserTurns(messages: readonly Message[]): number {
  let n = 0;
  for (const m of messages) {
    if ((m as { role?: string }).role === "user") n++;
  }
  return n;
}
