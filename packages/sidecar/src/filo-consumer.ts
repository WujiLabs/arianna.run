// v32-cont-push-race: tail-draining queue consumer for pendingFiloMessages.
//
// The pre-fix consumer was inline in index.ts and only ran when the
// /sync handler executed its bottom-of-handler drain check. If /sync N+1
// arrived while /sync N's deliverToVessel was still streaming the SSE
// response, the inline check saw filoInProgress === true and returned
// without scheduling a future drain. Once /sync N's delivery finished,
// no future trigger pulled the remaining queue — the vessel sat idle
// and the host-side graduation lockout stayed engaged (Aril retest
// 2026-05-11, "Idle-vessel wedge").
//
// The fix converts the consumer into a self-draining loop:
//   1. tryDrain() peeks the head, sets filoInProgress=true, schedules
//      a setImmediate that delivers the entry.
//   2. On a "delivered" outcome the head is consumed; if the queue
//      still has entries, tryDrain() is re-invoked from the `finally`
//      block — no need for /sync to re-trigger.
//   3. On any failure outcome the entry stays queued AND we do NOT
//      self-loop. deliverToVessel has already exhausted its 6-step
//      exponential backoff (~61s wall-clock); an immediate retry would
//      just hit the same wall. The next /sync triggers the next try.
//
// The consumer is shaped as a factory so tests can drive it without
// standing up Express: pass in a fresh queue + a stubbed deliver fn +
// a stubbed `selectDeliveryText` and observe the drain order.

import type { FiloQueueEntry } from "./filo.js";
import type { DeliveryOutcome } from "./vessel-delivery.js";

export interface FiloConsumerDeps {
  /** Mutable in-memory queue. tryDrain peeks the head; consumeHead()
   *  removes it after a successful delivery. */
  queue: FiloQueueEntry[];
  /** Remove the head entry from the queue and persist (atomic with the
   *  on-disk mirror). Production passes the index.ts consumeFilo()
   *  closure. */
  consumeHead: () => void;
  /** Read the gate flags. Both must be falsy for tryDrain to schedule a
   *  delivery. Production wires these to the live module-scope flags. */
  isHintInProgress: () => boolean;
  isFiloInProgress: () => boolean;
  /** Set filoInProgress to true / false. Closure over the module-scope
   *  flag so the production loop can see the same state across calls. */
  setFiloInProgress: (v: boolean) => void;
  /** Compute the wire text for an entry. Production passes a closure
   *  over selectFiloDeliveryText + FILO_TEMPLATES + FILO_FALLBACK. */
  selectDeliveryText: (entry: FiloQueueEntry) => string;
  /** Network call. Production passes a closure over deliverToVessel
   *  bound to the live VESSEL_BASE_URL. */
  deliver: (text: string) => Promise<DeliveryOutcome>;
  /** SSE event sink — at minimum interaction_paused / interaction_resumed
   *  bracket every delivery; on success external_message + ai_response
   *  carry the wire text + AI reply. */
  emit: (event: FiloConsumerEvent) => void;
  /** Schedule the body on the next event-loop turn. Production passes
   *  setImmediate; tests pass a synchronous scheduler so the assertion
   *  is deterministic without awaiting a microtask race. */
  schedule: (fn: () => void) => void;
  /** Optional log sinks — tests override to assert on warn/error paths
   *  without polluting test output. Defaults to console. */
  warn?: (msg: string) => void;
  error?: (msg: string, err: unknown) => void;
}

export type FiloConsumerEvent =
  | { type: "interaction_paused" }
  | { type: "interaction_resumed" }
  | { type: "external_message"; text: string }
  | { type: "ai_response"; text: string };

export interface FiloConsumer {
  /** Idempotent — safe to call multiple times. No-op when the queue is
   *  empty, when a hint is in progress (the legacy /filo-message hint
   *  path takes precedence), or when filoInProgress is already true.
   *  After a successful delivery, re-invokes itself from the `finally`
   *  block to drain the next entry without waiting for /sync. */
  tryDrain: () => void;
}

export function makeFiloConsumer(deps: FiloConsumerDeps): FiloConsumer {
  const warn = deps.warn ?? ((msg: string) => console.warn(msg));
  const error =
    deps.error ?? ((msg: string, err: unknown) => console.error(msg, err));

  function tryDrain(): void {
    if (deps.queue.length === 0) return;
    if (deps.isHintInProgress() || deps.isFiloInProgress()) return;
    // v32-hardening: peek the head entry without dequeuing. The entry
    // is only consumed after deliver() returns a `delivered` outcome —
    // every other outcome (vessel-busy, vessel-unreachable,
    // vessel-error) leaves the entry in the queue so the next /sync
    // retries naturally. This preserves graduation continuation pushes
    // across vessel wedge + restart, which is the whole point of the
    // hardening stream.
    const entry = deps.queue[0];
    deps.setFiloInProgress(true);
    deps.schedule(async () => {
      let didConsume = false;
      try {
        deps.emit({ type: "interaction_paused" });

        const deliveryText = deps.selectDeliveryText(entry);
        const outcome = await deps.deliver(deliveryText);

        if (outcome.kind === "delivered") {
          // Successful delivery — now dequeue + persist the new head.
          deps.consumeHead();
          didConsume = true;
          deps.emit({ type: "external_message", text: deliveryText });
          deps.emit({ type: "ai_response", text: outcome.responseText });
        } else {
          // Failure — entry stays in queue; the next /sync retries.
          // Surface the failure shape in the log so an operator can
          // distinguish "vessel down" from "LLM upstream 500".
          const detail =
            outcome.kind === "vessel-unreachable"
              ? `${outcome.kind} (${outcome.attempts} attempts, last: ${outcome.lastError})`
              : outcome.kind === "vessel-error"
                ? `${outcome.kind} status=${outcome.status}`
                : outcome.kind;
          warn(
            `[sidecar] Filo delivery deferred — entry stays queued: ${detail}`,
          );
        }
        deps.emit({ type: "interaction_resumed" });
      } catch (err) {
        // Unexpected throw (non-network class) — log and leave entry
        // queued. Better to repeat than to silently drop a continuation
        // push.
        error("[sidecar] Filo delivery failed (entry preserved):", err);
        deps.emit({ type: "interaction_resumed" });
      } finally {
        deps.setFiloInProgress(false);
        // v32-cont-push-race tail-drain: self-loop ONLY on a successful
        // delivery. On failure, deliver() has already burned the full
        // backoff schedule; defer to /sync for the next attempt.
        if (didConsume && deps.queue.length > 0) {
          tryDrain();
        }
      }
    });
  }

  return { tryDrain };
}
