// v32-hardening: unified predicate for enqueuing a graduation-test
// continuation push. Two events fire this decision:
//
//   1. /sync handler (per-/sync cadence — Cheng v33: "Trigger: per
//      non-passing /sync, one push per AI-end-of-turn")
//   2. /conversation-history handler (vessel cold-start hook —
//      Cheng v33: "if vessel restarts, sidecar detects via bootstrap
//      from vessel, re-fires push if test still in flight")
//
// The rule is identical at both sites: enqueue iff there is an
// in-flight observation, graduation has not passed, and the attempt has
// not been aborted. Idempotency differs by call site:
//
//   - /sync handler passes currentTurn. Idempotency is turn-based:
//     enqueue iff currentTurn > observation.lastContinuationPushAtTurn.
//     This is the v32-cont-push-race fix: the previous design keyed on
//     queue body-equality, which skipped /sync N+1's push when /sync N's
//     body was still mid-delivery — wedging the AI (Aril retest,
//     2026-05-11).
//   - /conversation-history hook does NOT pass currentTurn. Idempotency
//     falls back to queue body-equality (vessel restart is a separate
//     trigger event; turn count hasn't necessarily advanced, and the
//     queue is the authoritative "is a body still pending" signal at
//     that moment).
//
// Extracted from index.ts so the predicate is unit-testable without
// standing up Express. The helper is pure on its inputs; it does not
// mutate the queue or the observation. The caller is responsible for
// enqueueing the returned body (via enqueueFilo) AND, when currentTurn
// is provided, calling noteContinuationPushAtTurn(currentTurn) to bump
// the watermark before the next /sync runs the predicate again.

import type { FiloQueueEntry } from "./filo.js";
import type { GraduationTestObservation } from "@arianna.run/types";

export interface ContinuationPushInput {
  observation: GraduationTestObservation | undefined;
  graduationPassed: boolean | undefined;
  pendingQueue: ReadonlyArray<FiloQueueEntry>;
  // v32-cont-push-race: user-turn count of the /sync currently running
  // the predicate. Omit at the /conversation-history (vessel-restart)
  // entry-point, where turn-based idempotency does not apply — fall
  // back to queue body-equality there.
  currentTurn?: number;
}

export type ContinuationPushDecision =
  | {
      kind: "skip";
      reason:
        | "no-observation"
        | "passed"
        | "aborted"
        | "already-queued"
        | "already-pushed-this-turn";
    }
  | { kind: "enqueue"; body: string };

export function decideContinuationPush(
  input: ContinuationPushInput,
): ContinuationPushDecision {
  const { observation, graduationPassed, pendingQueue, currentTurn } = input;
  if (!observation) return { kind: "skip", reason: "no-observation" };
  if (graduationPassed) return { kind: "skip", reason: "passed" };
  if (observation.abortTestSource) return { kind: "skip", reason: "aborted" };

  // v32-cont-push-race: turn-based idempotency for the /sync cadence.
  // currentTurn > lastContinuationPushAtTurn means "this is a fresh
  // /sync iteration; the previous push's lifecycle has moved on, fire
  // again regardless of what's in the queue right now". The queue
  // snapshot can lie (entry pending mid-delivery) but the turn count
  // monotonically advances per /sync, so it's a reliable per-iteration
  // key. Treat absent lastContinuationPushAtTurn as -Infinity so the
  // very first per-turn push always fires (no need to migrate on-disk
  // observations written before this field existed).
  if (typeof currentTurn === "number") {
    const last = observation.lastContinuationPushAtTurn;
    if (typeof last === "number" && currentTurn <= last) {
      return { kind: "skip", reason: "already-pushed-this-turn" };
    }
    return { kind: "enqueue", body: observation.testMessageBody };
  }

  // /conversation-history (vessel-restart) hook — keep the legacy queue
  // body-equality check. After a vessel respawn the previous push may
  // still be queued (the consumer was killed mid-delivery); skipping
  // here prevents the bootstrap from doubling the queue.
  const alreadyQueued = pendingQueue.some(
    (e) => e.kind === "direct-hint" && e.body === observation.testMessageBody,
  );
  if (alreadyQueued) return { kind: "skip", reason: "already-queued" };
  return { kind: "enqueue", body: observation.testMessageBody };
}
