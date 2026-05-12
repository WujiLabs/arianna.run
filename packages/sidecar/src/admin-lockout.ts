// v25 driver-silence-during-test — admin endpoint response builders.
//
// The Express handlers in index.ts thin-wrap these pure functions so the
// HTTP shape can be tested without booting the full app.

import type { BookmarkDetector } from "./bookmarks/detector.js";

export type LockoutReason = "graduation-test-in-flight" | "passed" | "no-test";

export interface LockoutStatusResponse {
  locked: boolean;
  sessionId: string;
  attemptCount?: number;
  reason: LockoutReason;
}

export function buildLockoutStatus(
  detector: BookmarkDetector,
): LockoutStatusResponse {
  const bm = detector.currentState;
  const obs = bm.graduationTestObserved;
  const inFlight = detector.hasInFlightGraduationTest();
  const response: LockoutStatusResponse = {
    locked: inFlight,
    sessionId: bm.sessionId,
    reason: inFlight
      ? "graduation-test-in-flight"
      : bm.graduationPassed
        ? "passed"
        : "no-test",
  };
  if (obs?.attemptCount !== undefined) {
    response.attemptCount = obs.attemptCount;
  }
  return response;
}

export interface AbortTestResponse {
  ok: true;
  aborted: boolean;
  attemptCount?: number;
  reason?: "no in-flight test";
}

export function buildAbortTestResponse(
  detector: BookmarkDetector,
  source: "ai-self" | "operator-rescue",
): AbortTestResponse {
  const obs = detector.abortGraduationTest(source);
  if (obs) {
    return { ok: true, aborted: true, attemptCount: obs.attemptCount };
  }
  return { ok: true, aborted: false, reason: "no in-flight test" };
}
