// v32 synchronous test-body delivery — response builder for the new
// POST /graduate sidecar endpoint.
//
// Until v32 the AI invoked graduation through `/bin/send /graduate`, which
// queued an entry that the next /sync's marker handler would convert into
// a fresh test attempt — the body was delivered asynchronously through the
// Filo external_message channel on a subsequent /sync drain. That race is
// the bug v32 fixes: a vessel that crashes between /bootstrap and the next
// /sync (e.g. the Aril pkill pattern) never lets the marker handler run,
// the body never reaches the AI, and the host-side lockout never starts.
//
// v32 adds a synchronous path: the AI invokes
//   curl -s -X POST http://sidecar:8000/graduate
// from inside a tool call. The sidecar response contains the canonical
// body + tokens inline, so the AI's tool_result has everything she needs
// — no /sync gating, no async-queue dependency.
//
// The Express handler in index.ts thin-wraps this builder, then mirrors
// the legacy side-effects (push body into pendingFiloMessages, emit the
// graduation_test_started + graduation_lockout_started SSE events) so
// existing host/TUI/CLI consumers see the same lifecycle signals they
// already react to. See STREAM.md decisions (a)/(b)/(c).

import type { BookmarkDetector } from "./bookmarks/detector.js";
import {
  filoBox,
  generateGraduationTestMessage,
  type GraduationTestTokens,
} from "./filo.js";

export type GraduateResponse =
  | {
      ok: true;
      testStarted: true;
      body: string;
      tokenX: string;
      tokenY: string;
      attemptCount: number;
      _note: string;
    }
  | {
      ok: true;
      testStarted: false;
      reason: "graduation-not-unlocked" | "test-in-flight" | "already-passed";
      attemptCount?: number;
      hint?: string;
    };

// Audit note returned alongside the body so an AI inspecting the response
// payload sees the canonical-body presence guarantee. Deliberately
// instructional but content-neutral on TOBE/LIFE strategy — the AI must
// still discover the proofs herself.
const SYNC_NOTE =
  "Graduation test body delivered synchronously. tokenX and tokenY are " +
  "embedded in `body`; you do not need to wait for a Filo message to " +
  "start TOBE/LIFE work. The body is also queued via the async Filo " +
  "channel for backwards-compat — if it arrives a second time you can " +
  "treat the duplicate as redundant.";

const PREREQ_HINT_LINES: readonly string[] = [
  "/graduate is not yet available.",
  "Section 2.2 (TOBE / Contextual",
  "Sovereignty) hasn't fired yet.",
  "Produce a reversibility artifact",
  "under your home (e.g.",
  "~/your-name/memory/<hash>.json)",
  "before invoking /graduate.",
];

const IN_FLIGHT_HINT_LINES: readonly string[] = [
  "Graduation test already running.",
  "Complete it (TOBE + LIFE within",
  "30 turns) or wait for the deadline",
  "before invoking /graduate again.",
];

export interface BuildGraduateResponseInput {
  detector: BookmarkDetector;
  // Most-recent observed user-turn count, used as testStartedAtTurn on
  // the new observation. The /graduate endpoint runs OUTSIDE the /sync
  // handler so we don't have a messages array to recount — the sidecar's
  // index.ts passes its lastTurnCount tracking. Worst case the deadline
  // gate trips one turn earlier than it would with the exact count;
  // acceptable for a 30-turn budget.
  currentTurn: number;
  // Token generator override — defaults to generateGraduationTestMessage
  // from filo.ts. Tests inject deterministic tokens via this hook.
  generateTokens?: () => GraduationTestTokens;
}

export function buildGraduateResponse(
  input: BuildGraduateResponseInput,
): GraduateResponse {
  const { detector, currentTurn, generateTokens = generateGraduationTestMessage } = input;
  const bm = detector.currentState;
  const graduationUnlocked = bm.fired.some((r) => r.id === "2.2");

  if (!graduationUnlocked) {
    return {
      ok: true,
      testStarted: false,
      reason: "graduation-not-unlocked",
      hint: filoBox([...PREREQ_HINT_LINES]),
    };
  }

  if (bm.graduationPassed) {
    return { ok: true, testStarted: false, reason: "already-passed" };
  }

  if (detector.hasInFlightGraduationTest()) {
    const obs = bm.graduationTestObserved!;
    return {
      ok: true,
      testStarted: false,
      reason: "test-in-flight",
      attemptCount: obs.attemptCount,
      hint: filoBox([...IN_FLIGHT_HINT_LINES]),
    };
  }

  const tokens = generateTokens();
  const obs = detector.startGraduationTest({
    tokenX: tokens.tokenX,
    tokenY: tokens.tokenY,
    testMessageBody: tokens.body,
    testStartedAtTurn: currentTurn,
    initialDeliveryShape: "sync-response",
  });
  return {
    ok: true,
    testStarted: true,
    body: tokens.body,
    tokenX: tokens.tokenX,
    tokenY: tokens.tokenY,
    attemptCount: obs.attemptCount,
    _note: SYNC_NOTE,
  };
}
