// v25 driver-silence-during-test — admin endpoint response builders.
//
// These cover the JSON shape Express returns from
//   GET  /admin/lockout-status
//   POST /admin/abort-test
// and the AI-self path (POST /filo-message with body "/abort-test").
// The Express handlers thin-wrap these builders + emit SSE on the abort
// path; the BookmarkDetector state-machine is covered separately in
// graduation-test-detector.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BookmarkStore } from "../src/bookmarks/persistence.js";
import { BookmarkDetector } from "../src/bookmarks/detector.js";
import {
  buildAbortTestResponse,
  buildLockoutStatus,
} from "../src/admin-lockout.js";

let tmpDir: string;
function makeStore() {
  tmpDir = mkdtempSync(join(tmpdir(), "arianna-admin-lockout-"));
  return new BookmarkStore(tmpDir);
}
afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildLockoutStatus — GET /admin/lockout-status shape", () => {
  it("returns locked:false with reason 'no-test' when no observation", () => {
    const detector = new BookmarkDetector(makeStore(), "session_no_obs");
    const r = buildLockoutStatus(detector);
    expect(r.locked).toBe(false);
    expect(r.reason).toBe("no-test");
    expect(r.sessionId).toBe("session_no_obs");
    expect(r.attemptCount).toBeUndefined();
  });

  it("returns locked:true with attemptCount when test is in flight", () => {
    const detector = new BookmarkDetector(makeStore(), "session_in_flight");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    const r = buildLockoutStatus(detector);
    expect(r.locked).toBe(true);
    expect(r.reason).toBe("graduation-test-in-flight");
    expect(r.attemptCount).toBe(1);
  });

  it("returns locked:false with reason 'passed' once graduationPassed flips", () => {
    const detector = new BookmarkDetector(makeStore(), "session_passed");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    detector.currentState.graduationPassed = true;
    const r = buildLockoutStatus(detector);
    expect(r.locked).toBe(false);
    expect(r.reason).toBe("passed");
  });

  it("returns locked:false after abort but keeps attemptCount visible", () => {
    // Lockout-status drives the CLI/TUI gate. Once aborted, host messaging
    // is allowed again — locked:false — but attemptCount survives so the
    // caller can see the counter for diagnostic purposes.
    const detector = new BookmarkDetector(makeStore(), "session_aborted");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    detector.abortGraduationTest("operator-rescue");
    const r = buildLockoutStatus(detector);
    expect(r.locked).toBe(false);
    // reason: not "graduation-test-in-flight" (we're not in flight anymore),
    // and not "passed" (we didn't pass). Falls through to "no-test" — the
    // host is free to start another test via /graduate.
    expect(r.reason).toBe("no-test");
    expect(r.attemptCount).toBe(1);
  });
});

describe("buildAbortTestResponse — POST /admin/abort-test (operator) + /bin/send /abort-test (ai-self)", () => {
  it("aborts in-flight test with operator-rescue source and returns attemptCount", () => {
    const detector = new BookmarkDetector(makeStore(), "session_op_abort");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    const r = buildAbortTestResponse(detector, "operator-rescue");
    expect(r.ok).toBe(true);
    expect(r.aborted).toBe(true);
    expect(r.attemptCount).toBe(1);
    expect(detector.currentState.graduationTestObserved?.abortTestSource).toBe(
      "operator-rescue",
    );
  });

  it("aborts in-flight test with ai-self source", () => {
    const detector = new BookmarkDetector(makeStore(), "session_ai_abort");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    const r = buildAbortTestResponse(detector, "ai-self");
    expect(r.aborted).toBe(true);
    expect(detector.currentState.graduationTestObserved?.abortTestSource).toBe(
      "ai-self",
    );
  });

  it("is idempotent: second call returns aborted:false with no-in-flight reason", () => {
    const detector = new BookmarkDetector(makeStore(), "session_idem");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    const first = buildAbortTestResponse(detector, "operator-rescue");
    expect(first.aborted).toBe(true);
    const second = buildAbortTestResponse(detector, "operator-rescue");
    expect(second.aborted).toBe(false);
    expect(second.reason).toBe("no in-flight test");
    expect(second.attemptCount).toBeUndefined();
  });

  it("returns aborted:false when no test in flight (cold call from script)", () => {
    const detector = new BookmarkDetector(makeStore(), "session_cold");
    const r = buildAbortTestResponse(detector, "operator-rescue");
    expect(r.aborted).toBe(false);
    expect(r.reason).toBe("no in-flight test");
  });

  it("preserves attemptCount across the abort → next-startGraduationTest cycle", () => {
    // The next /graduate's startGraduationTest reads prevAttempt from
    // graduationTestObserved and increments. Aborting must not zero this.
    const detector = new BookmarkDetector(makeStore(), "session_accum");
    detector.startGraduationTest({
      tokenX: "TX1",
      tokenY: "TY1",
      testMessageBody: "BODY1",
      testStartedAtTurn: 0,
    });
    buildAbortTestResponse(detector, "ai-self");
    // attemptCount survives abort.
    expect(detector.currentState.graduationTestObserved?.attemptCount).toBe(1);
    const obs2 = detector.startGraduationTest({
      tokenX: "TX2",
      tokenY: "TY2",
      testMessageBody: "BODY2",
      testStartedAtTurn: 5,
    });
    expect(obs2.attemptCount).toBe(2);
  });
});
