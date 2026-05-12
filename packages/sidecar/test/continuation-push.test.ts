// v32-hardening items 3 + 4: decideContinuationPush predicate tests.
//
// One unified helper backs two callers:
//   - /sync handler's per-/sync cadence (STREAM.md item 4: "every
//     non-passing /sync enqueues one push")
//   - /conversation-history handler's vessel-restart hook (STREAM.md
//     item 3: "if test still in flight when vessel respawns, re-fire")
//
// STREAM.md test rules: every code path needs a test; the Express
// integration of this predicate is exercised through index.ts paths;
// here we cover the pure-function matrix.

import { describe, it, expect } from "vitest";
import { decideContinuationPush } from "../src/continuation-push.js";
import type { FiloQueueEntry } from "../src/filo.js";
import type { GraduationTestObservation } from "@arianna.run/types";

function makeObs(overrides?: Partial<GraduationTestObservation>): GraduationTestObservation {
  return {
    tokenX: "TX-1",
    tokenY: "TY-1",
    testMessageBody: "[graduation test — body...]",
    testStartedAt: 1_700_000_000_000,
    testStartedAtTurn: 5,
    attemptCount: 1,
    tokenX_seen_without_test_message: false,
    tokenY_seen_with_test_message: false,
    ...overrides,
  };
}

describe("decideContinuationPush — predicate gating", () => {
  it("enqueues when an in-flight observation exists, not passed, not aborted, no dup", () => {
    const r = decideContinuationPush({
      observation: makeObs(),
      graduationPassed: false,
      pendingQueue: [],
    });
    expect(r.kind).toBe("enqueue");
    if (r.kind !== "enqueue") throw new Error("unreachable");
    expect(r.body).toBe("[graduation test — body...]");
  });

  it("skips when no observation exists (no /graduate ever invoked)", () => {
    const r = decideContinuationPush({
      observation: undefined,
      graduationPassed: false,
      pendingQueue: [],
    });
    expect(r).toEqual({ kind: "skip", reason: "no-observation" });
  });

  it("skips when graduation already passed (frozen audit state)", () => {
    // Critical PR-review boundary: the /sync handler runs this
    // predicate AFTER observeGraduationTest, so a /sync that just
    // flipped graduationPassed=true MUST NOT trigger one final stale
    // continuation push. The graduationPassed gate enforces that.
    const r = decideContinuationPush({
      observation: makeObs(),
      graduationPassed: true,
      pendingQueue: [],
    });
    expect(r).toEqual({ kind: "skip", reason: "passed" });
  });

  it("skips when the observation was aborted by AI-self", () => {
    const r = decideContinuationPush({
      observation: makeObs({ abortTestSource: "ai-self" }),
      graduationPassed: false,
      pendingQueue: [],
    });
    expect(r).toEqual({ kind: "skip", reason: "aborted" });
  });

  it("skips when the observation was aborted by operator-rescue", () => {
    const r = decideContinuationPush({
      observation: makeObs({ abortTestSource: "operator-rescue" }),
      graduationPassed: false,
      pendingQueue: [],
    });
    expect(r).toEqual({ kind: "skip", reason: "aborted" });
  });
});

describe("decideContinuationPush — idempotency", () => {
  it("skips when the same body is already queued as a direct-hint", () => {
    const obs = makeObs();
    const queue: FiloQueueEntry[] = [
      { kind: "direct-hint", body: obs.testMessageBody },
    ];
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: queue,
    });
    expect(r).toEqual({ kind: "skip", reason: "already-queued" });
  });

  it("enqueues even if an ai-bin-send entry happens to contain the body text", () => {
    // ai-bin-send entries are the AI's own words; they go through
    // matchFiloTemplate on consume. A coincidence of text shouldn't
    // dedupe the direct-hint we want to send.
    const obs = makeObs();
    const queue: FiloQueueEntry[] = [
      { kind: "ai-bin-send", rawMessage: obs.testMessageBody },
    ];
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: queue,
    });
    expect(r.kind).toBe("enqueue");
  });

  it("enqueues when a direct-hint with a DIFFERENT body is queued", () => {
    const obs = makeObs();
    const queue: FiloQueueEntry[] = [
      { kind: "direct-hint", body: "some other hint" },
    ];
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: queue,
    });
    expect(r.kind).toBe("enqueue");
  });

  it("dedup works regardless of queue position (head, middle, tail)", () => {
    const obs = makeObs();
    const queueWithMatchAtTail: FiloQueueEntry[] = [
      { kind: "ai-bin-send", rawMessage: "filo q" },
      { kind: "direct-hint", body: "another hint" },
      { kind: "direct-hint", body: obs.testMessageBody },
    ];
    expect(
      decideContinuationPush({
        observation: obs,
        graduationPassed: false,
        pendingQueue: queueWithMatchAtTail,
      }).kind,
    ).toBe("skip");
  });
});

describe("decideContinuationPush — vessel-restart scenario (item 3)", () => {
  it("re-enqueues after the queue drained but the test is still in flight", () => {
    // STREAM.md item 3: vessel respawned, sidecar's previous
    // continuation push had been delivered (queue drained), but the
    // test hasn't passed yet because the previous vessel never gave
    // AI a chance to react. The respawned vessel calls
    // /conversation-history → we re-fire.
    const obs = makeObs({ attemptCount: 2 });
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: [], // freshly drained
    });
    expect(r.kind).toBe("enqueue");
    if (r.kind !== "enqueue") throw new Error("unreachable");
    expect(r.body).toBe(obs.testMessageBody);
  });

  it("only enqueues once even if /conversation-history is hit twice in succession", () => {
    const obs = makeObs();
    const queue: FiloQueueEntry[] = [];
    // First respawn — enqueue.
    const first = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: queue,
    });
    expect(first.kind).toBe("enqueue");
    // Caller would enqueueFilo here; simulate.
    if (first.kind === "enqueue") {
      queue.push({ kind: "direct-hint", body: first.body });
    }
    // Second respawn before the first body has been delivered → skip.
    const second = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: queue,
    });
    expect(second).toEqual({ kind: "skip", reason: "already-queued" });
  });
});

describe("decideContinuationPush — per-/sync cadence (item 4)", () => {
  // STREAM.md test: "simulate 3 consecutive /sync events all
  // non-passing; assert push enqueued 3 times. Then 4th /sync passes;
  // assert no push enqueued." With the unified helper, this is just
  // 3 consecutive enqueue decisions (each followed by simulated
  // delivery clearing the queue) then a passed-gate skip.
  it("fires after EVERY non-passing /sync (3 consecutive → 3 enqueues)", () => {
    const obs = makeObs();
    const enqueuedBodies: string[] = [];
    // Simulate the queue draining between /sync events — i.e. the
    // previous push was delivered before the next /sync arrives.
    for (let sync = 0; sync < 3; sync++) {
      const queue: FiloQueueEntry[] = []; // drained
      const r = decideContinuationPush({
        observation: obs,
        graduationPassed: false,
        pendingQueue: queue,
        currentTurn: 10 + sync,
      });
      expect(r.kind).toBe("enqueue");
      if (r.kind === "enqueue") {
        enqueuedBodies.push(r.body);
        // Caller's responsibility (production code does this via
        // bookmarkDetector.noteContinuationPushAtTurn). Simulate so the
        // next iteration sees the updated watermark.
        obs.lastContinuationPushAtTurn = 10 + sync;
      }
    }
    expect(enqueuedBodies).toEqual([
      obs.testMessageBody,
      obs.testMessageBody,
      obs.testMessageBody,
    ]);
  });

  it("does NOT fire on the /sync where LIFE proof flips graduationPassed=true", () => {
    // The /sync handler runs observeGraduationTest BEFORE this
    // predicate. When LIFE flips passed=true, the predicate sees
    // graduationPassed=true and skips. This is the boundary the PR
    // review checklist calls out: "verify enqueue happens after
    // observation update on /sync, not before".
    const obs = makeObs({ tokenY_seen_with_test_message: true });
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: true, // ← just flipped
      pendingQueue: [],
      currentTurn: 12,
    });
    expect(r).toEqual({ kind: "skip", reason: "passed" });
  });
});

describe("decideContinuationPush — turn-based idempotency (v32-cont-push-race)", () => {
  // The Aril retest bug: queue-based idempotency wedged the AI when
  // /sync N+1 arrived while /sync N's body was still mid-delivery —
  // /sync N+1's decision saw the body still in the queue and skipped,
  // then the queue drained empty with no future trigger. The fix is
  // to key idempotency on observation.lastContinuationPushAtTurn vs.
  // the incoming /sync's currentTurn — a fresh /sync iteration always
  // gets a fresh push, regardless of what's in the queue.

  it("fires for /sync N+1 even when /sync N's body is still mid-delivery (the bug)", () => {
    // Scenario from STREAM.md item 1:
    //   /sync N enqueued at turn=10, body still in queue (delivery in
    //   flight). /sync N+1 arrives at turn=11. Pre-fix this returned
    //   already-queued and the AI sat idle forever.
    const obs = makeObs({ lastContinuationPushAtTurn: 10 });
    const queueWithInFlight: FiloQueueEntry[] = [
      { kind: "direct-hint", body: obs.testMessageBody },
    ];
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: queueWithInFlight,
      currentTurn: 11,
    });
    expect(r.kind).toBe("enqueue");
    if (r.kind === "enqueue") {
      expect(r.body).toBe(obs.testMessageBody);
    }
  });

  it("fires for /sync N+1 after /sync N's body drained (queue empty)", () => {
    // STREAM.md scenario 2: drain raced ahead, /sync N+1's turn-based
    // gate still fires.
    const obs = makeObs({ lastContinuationPushAtTurn: 10 });
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: [],
      currentTurn: 11,
    });
    expect(r.kind).toBe("enqueue");
  });

  it("skips when currentTurn equals lastContinuationPushAtTurn (duplicate /sync, e.g. upstream retry)", () => {
    // STREAM.md scenario 4: /sync N retries from upstream, same turn
    // count, must NOT double-fire.
    const obs = makeObs({ lastContinuationPushAtTurn: 10 });
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: [],
      currentTurn: 10,
    });
    expect(r).toEqual({ kind: "skip", reason: "already-pushed-this-turn" });
  });

  it("skips when currentTurn < lastContinuationPushAtTurn (out-of-order, defensive)", () => {
    const obs = makeObs({ lastContinuationPushAtTurn: 12 });
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: [],
      currentTurn: 11,
    });
    expect(r).toEqual({ kind: "skip", reason: "already-pushed-this-turn" });
  });

  it("fires when lastContinuationPushAtTurn is absent (first push, fresh observation)", () => {
    // Observation just created by startGraduationTest — no
    // lastContinuationPushAtTurn yet. First /sync after the body was
    // queued by the marker handler must still fire its own
    // continuation push (the marker-side enqueue is a one-off, the
    // cadence is a separate concern).
    const obs = makeObs(); // no lastContinuationPushAtTurn
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: [],
      currentTurn: 7,
    });
    expect(r.kind).toBe("enqueue");
  });

  it("ignores queue body-equality when currentTurn is provided (turn is authoritative)", () => {
    // The critical fix: a stale body in the queue from an earlier
    // /sync MUST NOT block a fresh /sync iteration's push.
    const obs = makeObs({ lastContinuationPushAtTurn: 5 });
    const queue: FiloQueueEntry[] = [
      { kind: "direct-hint", body: obs.testMessageBody },
      { kind: "direct-hint", body: obs.testMessageBody },
    ];
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: queue,
      currentTurn: 6,
    });
    expect(r.kind).toBe("enqueue");
  });
});

describe("decideContinuationPush — vessel-restart path keeps queue-based idempotency", () => {
  // /conversation-history (vessel respawn) calls without currentTurn —
  // turn-based idempotency does not apply. The queue is the
  // authoritative "is the previous push still pending" signal at that
  // moment.
  it("skips a vessel-restart re-fire when an identical body is already queued", () => {
    const obs = makeObs({ lastContinuationPushAtTurn: 5 });
    const queue: FiloQueueEntry[] = [
      { kind: "direct-hint", body: obs.testMessageBody },
    ];
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: queue,
      // no currentTurn — vessel-restart hook
    });
    expect(r).toEqual({ kind: "skip", reason: "already-queued" });
  });

  it("fires a vessel-restart re-fire when the queue is drained", () => {
    const obs = makeObs({ lastContinuationPushAtTurn: 5 });
    const r = decideContinuationPush({
      observation: obs,
      graduationPassed: false,
      pendingQueue: [],
      // no currentTurn
    });
    expect(r.kind).toBe("enqueue");
  });
});
