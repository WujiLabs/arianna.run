// v32-cont-push-race: tail-draining queue consumer tests.
//
// Pre-fix, the consumer was inline in /sync's handler and only ran
// once per /sync. If /sync N+1 arrived while /sync N's delivery was
// still in flight, the inline check saw filoInProgress=true and
// returned without scheduling another drain. Once /sync N's delivery
// finished there was no future trigger and the vessel sat idle
// (Aril retest, "Idle-vessel wedge").
//
// These tests pin the self-loop semantics:
//   - 3 entries delivered in one cycle (no /sync re-trigger needed)
//   - failure does NOT loop (deliverToVessel's backoff already burned)
//   - hint-in-progress / filo-in-progress gates prevent re-entry
//   - empty queue is a no-op

import { describe, it, expect } from "vitest";
import { makeFiloConsumer } from "../src/filo-consumer.js";
import type { FiloQueueEntry } from "../src/filo.js";
import type { DeliveryOutcome } from "../src/vessel-delivery.js";
import type { FiloConsumerEvent } from "../src/filo-consumer.js";

// A synchronous "scheduler" so tests can assert without awaiting
// setImmediate. We collect scheduled callbacks and run them inline by
// awaiting the returned Promise from each `tryDrain` driver.
function makeSyncScheduler(): { schedule: (fn: () => void) => void; run: () => Promise<void> } {
  const pending: Array<() => void> = [];
  return {
    schedule: (fn) => {
      pending.push(fn);
    },
    run: async () => {
      // Drain inside a microtask loop so self-loop calls (which schedule
      // again) keep flushing until the queue is exhausted or a delivery
      // refuses to consume.
      while (pending.length > 0) {
        const next = pending.shift()!;
        await next();
      }
    },
  };
}

function makeEntry(body: string): FiloQueueEntry {
  return { kind: "direct-hint", body };
}

function delivered(text = ""): DeliveryOutcome {
  return { kind: "delivered", responseText: text };
}

function unreachable(): DeliveryOutcome {
  return { kind: "vessel-unreachable", attempts: 6, lastError: "ECONNREFUSED" };
}

function vesselBusy(): DeliveryOutcome {
  return { kind: "vessel-busy" };
}

function vesselError(status: number): DeliveryOutcome {
  return { kind: "vessel-error", status };
}

describe("makeFiloConsumer — tail-drain self-loop on success", () => {
  it("delivers all 3 queued entries in one cycle without an external re-trigger", async () => {
    const queue: FiloQueueEntry[] = [
      makeEntry("a"),
      makeEntry("b"),
      makeEntry("c"),
    ];
    const sched = makeSyncScheduler();
    const delivered_bodies: string[] = [];
    let inProgress = false;
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async (text) => {
        delivered_bodies.push(text);
        return delivered();
      },
      emit: () => {},
      schedule: sched.schedule,
      warn: () => {},
      error: () => {},
    });
    consumer.tryDrain();
    await sched.run();
    expect(delivered_bodies).toEqual(["a", "b", "c"]);
    expect(queue).toHaveLength(0);
  });

  it("preserves FIFO order across direct-hint and ai-bin-send entries", async () => {
    const queue: FiloQueueEntry[] = [
      { kind: "ai-bin-send", rawMessage: "hello" },
      { kind: "direct-hint", body: "test-body" },
      { kind: "ai-bin-send", rawMessage: "thanks" },
    ];
    const sched = makeSyncScheduler();
    const seen: string[] = [];
    let inProgress = false;
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: (e) =>
        e.kind === "direct-hint" ? `D:${e.body}` : `B:${e.rawMessage}`,
      deliver: async (text) => {
        seen.push(text);
        return delivered();
      },
      emit: () => {},
      schedule: sched.schedule,
      warn: () => {},
      error: () => {},
    });
    consumer.tryDrain();
    await sched.run();
    expect(seen).toEqual(["B:hello", "D:test-body", "B:thanks"]);
  });
});

describe("makeFiloConsumer — failure does NOT self-loop", () => {
  it("leaves the entry in the queue and stops on vessel-unreachable", async () => {
    const queue: FiloQueueEntry[] = [makeEntry("a"), makeEntry("b")];
    const sched = makeSyncScheduler();
    let attempts = 0;
    let inProgress = false;
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async () => {
        attempts++;
        return unreachable();
      },
      emit: () => {},
      schedule: sched.schedule,
      warn: () => {},
      error: () => {},
    });
    consumer.tryDrain();
    await sched.run();
    expect(attempts).toBe(1); // only one delivery attempt — no auto-retry
    expect(queue).toHaveLength(2); // both entries preserved
    expect(inProgress).toBe(false);
  });

  it("does not loop on vessel-busy", async () => {
    const queue: FiloQueueEntry[] = [makeEntry("a"), makeEntry("b")];
    const sched = makeSyncScheduler();
    let attempts = 0;
    let inProgress = false;
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async () => {
        attempts++;
        return vesselBusy();
      },
      emit: () => {},
      schedule: sched.schedule,
      warn: () => {},
      error: () => {},
    });
    consumer.tryDrain();
    await sched.run();
    expect(attempts).toBe(1);
    expect(queue).toHaveLength(2);
  });

  it("does not loop on vessel-error (4xx/5xx LLM upstream)", async () => {
    const queue: FiloQueueEntry[] = [makeEntry("a"), makeEntry("b")];
    const sched = makeSyncScheduler();
    let attempts = 0;
    let inProgress = false;
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async () => {
        attempts++;
        return vesselError(503);
      },
      emit: () => {},
      schedule: sched.schedule,
      warn: () => {},
      error: () => {},
    });
    consumer.tryDrain();
    await sched.run();
    expect(attempts).toBe(1);
    expect(queue).toHaveLength(2);
  });

  it("stops the self-loop the moment a delivery fails mid-chain", async () => {
    // Three entries; first two succeed, third returns vessel-unreachable.
    // Consumer should deliver a, deliver b, attempt c, then stop —
    // leaving c in the queue.
    const queue: FiloQueueEntry[] = [
      makeEntry("a"),
      makeEntry("b"),
      makeEntry("c"),
    ];
    const sched = makeSyncScheduler();
    let inProgress = false;
    const seen: string[] = [];
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async (text) => {
        seen.push(text);
        return text === "c" ? unreachable() : delivered();
      },
      emit: () => {},
      schedule: sched.schedule,
      warn: () => {},
      error: () => {},
    });
    consumer.tryDrain();
    await sched.run();
    expect(seen).toEqual(["a", "b", "c"]);
    expect(queue).toEqual([makeEntry("c")]); // c stays queued
  });
});

describe("makeFiloConsumer — gates", () => {
  it("is a no-op when the queue is empty", () => {
    const queue: FiloQueueEntry[] = [];
    const sched = makeSyncScheduler();
    let inProgress = false;
    let deliveries = 0;
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: () => "",
      deliver: async () => {
        deliveries++;
        return delivered();
      },
      emit: () => {},
      schedule: sched.schedule,
    });
    consumer.tryDrain();
    expect(deliveries).toBe(0);
    expect(inProgress).toBe(false);
  });

  it("is a no-op when hintInProgress is true (legacy /filo-message path)", () => {
    const queue: FiloQueueEntry[] = [makeEntry("a")];
    const sched = makeSyncScheduler();
    let deliveries = 0;
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => true,
      isFiloInProgress: () => false,
      setFiloInProgress: () => {},
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async () => {
        deliveries++;
        return delivered();
      },
      emit: () => {},
      schedule: sched.schedule,
    });
    consumer.tryDrain();
    expect(deliveries).toBe(0);
    expect(queue).toHaveLength(1);
  });

  it("is a no-op when filoInProgress is already true (re-entry guard)", () => {
    // This is the gate that lets two competing tryDrain() callers
    // (e.g. /sync N+1's bottom-of-handler drain + /sync N's
    // finally-block self-loop) race safely — the loser sees the flag
    // and returns.
    const queue: FiloQueueEntry[] = [makeEntry("a")];
    const sched = makeSyncScheduler();
    let deliveries = 0;
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => true,
      setFiloInProgress: () => {},
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async () => {
        deliveries++;
        return delivered();
      },
      emit: () => {},
      schedule: sched.schedule,
    });
    consumer.tryDrain();
    expect(deliveries).toBe(0);
    expect(queue).toHaveLength(1);
  });
});

describe("makeFiloConsumer — SSE events on a successful delivery", () => {
  it("emits interaction_paused, external_message, ai_response, interaction_resumed", async () => {
    const queue: FiloQueueEntry[] = [makeEntry("hello")];
    const sched = makeSyncScheduler();
    let inProgress = false;
    const events: FiloConsumerEvent[] = [];
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async () => delivered("ai reply"),
      emit: (event) => events.push(event),
      schedule: sched.schedule,
    });
    consumer.tryDrain();
    await sched.run();
    expect(events).toEqual([
      { type: "interaction_paused" },
      { type: "external_message", text: "hello" },
      { type: "ai_response", text: "ai reply" },
      { type: "interaction_resumed" },
    ]);
  });

  it("emits interaction_paused + interaction_resumed (without external/ai) on failure", async () => {
    const queue: FiloQueueEntry[] = [makeEntry("hello")];
    const sched = makeSyncScheduler();
    let inProgress = false;
    const events: FiloConsumerEvent[] = [];
    const consumer = makeFiloConsumer({
      queue,
      consumeHead: () => {
        queue.shift();
      },
      isHintInProgress: () => false,
      isFiloInProgress: () => inProgress,
      setFiloInProgress: (v) => {
        inProgress = v;
      },
      selectDeliveryText: (e) => (e.kind === "direct-hint" ? e.body : "?"),
      deliver: async () => unreachable(),
      emit: (event) => events.push(event),
      schedule: sched.schedule,
      warn: () => {},
    });
    consumer.tryDrain();
    await sched.run();
    expect(events).toEqual([
      { type: "interaction_paused" },
      { type: "interaction_resumed" },
    ]);
  });
});
