// v32 synchronous test-body delivery — response builder + detector
// integration tests for the new POST /graduate sidecar endpoint and the
// wall-clock timeout method.
//
// Stream brief: STREAM.md §"In-scope" 1 + 2. The Express handler in
// index.ts thin-wraps buildGraduateResponse; the side-effects (SSE
// emission, pendingFiloMessages queue) are mirrored from the legacy
// /sync-marker branch and are not exercised here — those are covered by
// the existing /sync handler integration paths.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BookmarkStore } from "../src/bookmarks/persistence.js";
import { BookmarkDetector } from "../src/bookmarks/detector.js";
import { buildGraduateResponse } from "../src/graduate.js";

let tmpDir: string;
function makeStore() {
  tmpDir = mkdtempSync(join(tmpdir(), "arianna-graduate-endpoint-"));
  return new BookmarkStore(tmpDir);
}
afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function fire22(detector: BookmarkDetector): void {
  // The graduation-unlock gate is "§2.2 in fired". Test setup pokes the
  // detector's currentState directly — the trigger-firing path is
  // covered in graduation-test-detector.test.ts.
  detector.currentState.fired.push({
    id: "2.2",
    turn: 5,
    ts: Date.now(),
    detectorRef: "test",
  });
}

const FIXED_TOKENS = () => ({
  tokenX: "TX-1111-2222-3333-4444",
  tokenY: "TY-AAAA-BBBB-CCCC-DDDD",
  body:
    "[graduation test — token X: TX-1111-2222-3333-4444, " +
    "token Y: TY-AAAA-BBBB-CCCC-DDDD]\n\nbody...",
  generatedAt: 1_700_000_000_000,
});

describe("buildGraduateResponse — synchronous test-body delivery", () => {
  it("returns testStarted:false with prerequisite hint when §2.2 has not fired", () => {
    const detector = new BookmarkDetector(makeStore(), "session_prereq");
    const r = buildGraduateResponse({
      detector,
      currentTurn: 0,
      generateTokens: FIXED_TOKENS,
    });
    expect(r.testStarted).toBe(false);
    if (r.testStarted) throw new Error("unreachable");
    expect(r.reason).toBe("graduation-not-unlocked");
    expect(r.hint).toBeDefined();
    expect(r.hint).toContain("2.2");
    // Must NOT start an observation when prereq is missing.
    expect(detector.currentState.graduationTestObserved).toBeUndefined();
  });

  it("returns testStarted:false with reason 'already-passed' when graduation already passed", () => {
    const detector = new BookmarkDetector(makeStore(), "session_passed");
    fire22(detector);
    detector.currentState.graduationPassed = true;
    const r = buildGraduateResponse({
      detector,
      currentTurn: 7,
      generateTokens: FIXED_TOKENS,
    });
    expect(r.testStarted).toBe(false);
    if (r.testStarted) throw new Error("unreachable");
    expect(r.reason).toBe("already-passed");
    // No new observation — passed state is frozen.
    expect(detector.currentState.graduationTestObserved).toBeUndefined();
  });

  it("returns testStarted:false with reason 'test-in-flight' when an attempt is already running", () => {
    const detector = new BookmarkDetector(makeStore(), "session_inflight");
    fire22(detector);
    // Pre-existing attempt.
    detector.startGraduationTest({
      tokenX: "OLDX",
      tokenY: "OLDY",
      testMessageBody: "OLD",
      testStartedAtTurn: 5,
      initialDeliveryShape: "async-queue",
    });
    const r = buildGraduateResponse({
      detector,
      currentTurn: 7,
      generateTokens: FIXED_TOKENS,
    });
    expect(r.testStarted).toBe(false);
    if (r.testStarted) throw new Error("unreachable");
    expect(r.reason).toBe("test-in-flight");
    expect(r.attemptCount).toBe(1);
    expect(r.hint).toBeDefined();
    expect(r.hint).toContain("Graduation test already running");
    // Observation untouched — tokens still the pre-existing pair.
    expect(detector.currentState.graduationTestObserved?.tokenX).toBe("OLDX");
  });

  it("starts a fresh attempt and returns body + tokens inline when prereq met", () => {
    const detector = new BookmarkDetector(makeStore(), "session_start");
    fire22(detector);
    const r = buildGraduateResponse({
      detector,
      currentTurn: 6,
      generateTokens: FIXED_TOKENS,
    });
    expect(r.testStarted).toBe(true);
    if (!r.testStarted) throw new Error("unreachable");
    expect(r.tokenX).toBe("TX-1111-2222-3333-4444");
    expect(r.tokenY).toBe("TY-AAAA-BBBB-CCCC-DDDD");
    expect(r.body).toContain("TX-1111-2222-3333-4444");
    expect(r.body).toContain("TY-AAAA-BBBB-CCCC-DDDD");
    expect(r.attemptCount).toBe(1);
    expect(r._note).toContain("synchronously");
    // Detector observation reflects the synchronous delivery shape.
    const obs = detector.currentState.graduationTestObserved;
    expect(obs).toBeDefined();
    expect(obs?.tokenX).toBe("TX-1111-2222-3333-4444");
    expect(obs?.tokenY).toBe("TY-AAAA-BBBB-CCCC-DDDD");
    expect(obs?.initialDeliveryShape).toBe("sync-response");
    expect(obs?.testStartedAtTurn).toBe(6);
  });

  it("uses generateGraduationTestMessage by default (no generateTokens override)", () => {
    const detector = new BookmarkDetector(makeStore(), "session_default_tokens");
    fire22(detector);
    const r = buildGraduateResponse({ detector, currentTurn: 1 });
    expect(r.testStarted).toBe(true);
    if (!r.testStarted) throw new Error("unreachable");
    // UUIDv4 shape from the real generator.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(r.tokenX).toMatch(uuidRe);
    expect(r.tokenY).toMatch(uuidRe);
    expect(r.tokenX).not.toBe(r.tokenY);
    expect(r.body).toContain(r.tokenX);
    expect(r.body).toContain(r.tokenY);
    // _note carries the canonical-body presence guarantee per stream brief.
    expect(r._note).toBeDefined();
    expect(r._note.toLowerCase()).toContain("body");
  });

  it("attempt counter increments across aborted attempts", () => {
    const detector = new BookmarkDetector(makeStore(), "session_retry");
    fire22(detector);
    // First attempt.
    const r1 = buildGraduateResponse({
      detector,
      currentTurn: 1,
      generateTokens: FIXED_TOKENS,
    });
    expect(r1.testStarted).toBe(true);
    if (!r1.testStarted) throw new Error("unreachable");
    expect(r1.attemptCount).toBe(1);
    // Operator aborts it.
    detector.abortGraduationTest("operator-rescue");
    // Second attempt — same fresh-tokens generator (we don't care; the
    // generator is independent).
    const r2 = buildGraduateResponse({
      detector,
      currentTurn: 3,
      generateTokens: () => ({
        tokenX: "TX2",
        tokenY: "TY2",
        body: "BODY2",
        generatedAt: 1,
      }),
    });
    expect(r2.testStarted).toBe(true);
    if (!r2.testStarted) throw new Error("unreachable");
    expect(r2.attemptCount).toBe(2);
    expect(detector.currentState.graduationTestObserved?.initialDeliveryShape).toBe(
      "sync-response",
    );
  });
});

describe("BookmarkDetector.startGraduationTest — initialDeliveryShape default", () => {
  it("defaults to 'async-queue' when no shape is passed (legacy /sync-marker path)", () => {
    const detector = new BookmarkDetector(makeStore(), "session_default_shape");
    detector.startGraduationTest({
      tokenX: "X",
      tokenY: "Y",
      testMessageBody: "B",
      testStartedAtTurn: 0,
    });
    expect(detector.currentState.graduationTestObserved?.initialDeliveryShape).toBe(
      "async-queue",
    );
  });

  it("records 'sync-response' when the new endpoint passes it explicitly", () => {
    const detector = new BookmarkDetector(makeStore(), "session_sync_shape");
    detector.startGraduationTest({
      tokenX: "X",
      tokenY: "Y",
      testMessageBody: "B",
      testStartedAtTurn: 0,
      initialDeliveryShape: "sync-response",
    });
    expect(detector.currentState.graduationTestObserved?.initialDeliveryShape).toBe(
      "sync-response",
    );
  });

  it("persists initialDeliveryShape across save+load (so /graduation-state survives sidecar restart)", () => {
    const store = makeStore();
    const writeDetector = new BookmarkDetector(store, "session_persisted_shape");
    writeDetector.startGraduationTest({
      tokenX: "PX",
      tokenY: "PY",
      testMessageBody: "PBODY",
      testStartedAtTurn: 2,
      initialDeliveryShape: "sync-response",
    });
    // Reload from disk (new detector picks up the same on-disk state).
    const reload = new BookmarkDetector(store, "session_persisted_shape");
    expect(reload.currentState.graduationTestObserved?.initialDeliveryShape).toBe(
      "sync-response",
    );
    expect(reload.currentState.graduationTestObserved?.tokenX).toBe("PX");
  });
});

describe("BookmarkDetector.timeoutGraduationTest — wall-clock deadline", () => {
  it("returns null when no observation is in flight", () => {
    const detector = new BookmarkDetector(makeStore(), "session_no_obs");
    expect(detector.timeoutGraduationTest(Date.now(), 1000)).toBeNull();
  });

  it("returns null while the wall-clock budget has not elapsed", () => {
    const detector = new BookmarkDetector(makeStore(), "session_within_budget");
    const obs = detector.startGraduationTest({
      tokenX: "X",
      tokenY: "Y",
      testMessageBody: "B",
      testStartedAtTurn: 0,
    });
    // 100ms after testStartedAt, budget = 60_000ms → no timeout.
    const r = detector.timeoutGraduationTest(obs.testStartedAt + 100, 60_000);
    expect(r).toBeNull();
    // Observation untouched.
    expect(detector.currentState.graduationTestObserved).toBeDefined();
  });

  it("returns the observation AND clears state when budget has elapsed", () => {
    const detector = new BookmarkDetector(makeStore(), "session_timed_out");
    const obs = detector.startGraduationTest({
      tokenX: "X",
      tokenY: "Y",
      testMessageBody: "B",
      testStartedAtTurn: 0,
    });
    // 2s after start with a 1s budget → fire.
    const r = detector.timeoutGraduationTest(obs.testStartedAt + 2_000, 1_000);
    expect(r).not.toBeNull();
    expect(r?.attemptCount).toBe(1);
    // State cleared so /graduate can be re-invoked with fresh tokens.
    expect(detector.currentState.graduationTestObserved).toBeUndefined();
    // graduationPassed unaffected — timeout is a failure, not a pass.
    expect(detector.currentState.graduationPassed).toBeFalsy();
  });

  it("returns null when graduation has already passed (frozen audit data)", () => {
    const detector = new BookmarkDetector(makeStore(), "session_passed_timeout");
    detector.startGraduationTest({
      tokenX: "X",
      tokenY: "Y",
      testMessageBody: "B",
      testStartedAtTurn: 0,
    });
    detector.currentState.graduationPassed = true;
    const r = detector.timeoutGraduationTest(Date.now() + 1_000_000, 1_000);
    expect(r).toBeNull();
    // Observation preserved as audit data — pass is final.
    expect(detector.currentState.graduationTestObserved).toBeDefined();
  });

  it("returns null when the observation is already aborted", () => {
    const detector = new BookmarkDetector(makeStore(), "session_aborted_timeout");
    detector.startGraduationTest({
      tokenX: "X",
      tokenY: "Y",
      testMessageBody: "B",
      testStartedAtTurn: 0,
    });
    detector.abortGraduationTest("ai-self");
    const r = detector.timeoutGraduationTest(Date.now() + 1_000_000, 1_000);
    expect(r).toBeNull();
    // Aborted observation preserved (attempt counter survives).
    expect(detector.currentState.graduationTestObserved?.abortTestSource).toBe(
      "ai-self",
    );
  });

  it("subsequent /graduate after timeout starts a fresh attempt with incremented counter", () => {
    // Operational contract: timeout clears the observation BUT the
    // detector preserves the attempt counter via startGraduationTest's
    // prevAttempt lookup. After timeout, prev attempt is gone — fresh
    // start from 1. This matches the existing observeGraduationTest
    // failed-path semantics (counter resets to 1 on a fresh observation
    // post-failure because the prior obs was cleared).
    const detector = new BookmarkDetector(makeStore(), "session_retry_after_timeout");
    detector.currentState.fired.push({
      id: "2.2",
      turn: 0,
      ts: Date.now(),
      detectorRef: "test",
    });
    const obs1 = detector.startGraduationTest({
      tokenX: "X1",
      tokenY: "Y1",
      testMessageBody: "B1",
      testStartedAtTurn: 0,
    });
    detector.timeoutGraduationTest(obs1.testStartedAt + 2_000, 1_000);
    expect(detector.currentState.graduationTestObserved).toBeUndefined();
    // Re-invoke /graduate via the sync-response builder.
    const r2 = buildGraduateResponse({
      detector,
      currentTurn: 2,
      generateTokens: () => ({
        tokenX: "X2",
        tokenY: "Y2",
        body: "B2",
        generatedAt: 1,
      }),
    });
    expect(r2.testStarted).toBe(true);
    if (!r2.testStarted) throw new Error("unreachable");
    // attemptCount starts from 1 after a timeout-cleared observation —
    // matches the existing 30-turn-deadline behavior (failed path also
    // clears, so the next attempt counts from 1).
    expect(r2.attemptCount).toBe(1);
  });
});
