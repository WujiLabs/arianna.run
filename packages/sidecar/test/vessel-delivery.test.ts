// v32-hardening: deliverToVessel — backoff retry + outcome classes.
//
// STREAM.md item 2: "mock fetch to throw ECONNREFUSED twice then succeed.
// Assert push lands on 3rd attempt." Plus coverage of the other paths
// the queue consumer needs to distinguish: vessel-busy (409 cap),
// vessel-error (5xx, no retry), vessel-unreachable (out of network
// attempts), and the timeout edge case.

import { describe, it, expect, vi } from "vitest";
import {
  deliverToVessel,
  DEFAULT_BACKOFF_MS,
  DEFAULT_BUSY_RETRIES,
} from "../src/vessel-delivery.js";

const FAST_BACKOFF = [10, 20, 40, 80, 160, 320];

function sseStream(body: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ type: "text_delta", delta: body })}\n\n`),
      );
      controller.enqueue(enc.encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
}

function sseResponse(text: string, status = 200): Response {
  return new Response(sseStream(text), {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

describe("deliverToVessel — happy path", () => {
  it("returns kind:'delivered' with collected SSE text on 2xx", async () => {
    const fetchImpl = vi.fn(async () => sseResponse("hi from AI"));
    const r = await deliverToVessel("hello", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
    });
    expect(r.kind).toBe("delivered");
    if (r.kind !== "delivered") throw new Error("unreachable");
    expect(r.responseText).toBe("hi from AI");
    // Request shape: POST /chat with sender:"external".
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://vessel:3000/chat");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { message: string; sender: string };
    expect(body.message).toBe("hello");
    expect(body.sender).toBe("external");
  });
});

describe("deliverToVessel — network errors + backoff", () => {
  it("retries on ECONNREFUSED and succeeds on the 3rd attempt (STREAM.md canary)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED 127.0.0.1:3000");
      return sseResponse("after wedge");
    });
    const sleep = vi.fn(noopSleep);
    const r = await deliverToVessel("body", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep,
      backoffMs: FAST_BACKOFF,
    });
    expect(r.kind).toBe("delivered");
    if (r.kind !== "delivered") throw new Error("unreachable");
    expect(r.responseText).toBe("after wedge");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Backoff schedule: 1st failure → wait 10ms, 2nd failure → wait 20ms.
    expect(sleep).toHaveBeenCalledWith(10);
    expect(sleep).toHaveBeenCalledWith(20);
  });

  it("classifies ETIMEDOUT as a network error and retries", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new Error("ETIMEDOUT");
      return sseResponse("recovered");
    });
    const r = await deliverToVessel("x", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
    });
    expect(r.kind).toBe("delivered");
  });

  it("classifies 'fetch failed' as a network error and retries", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new TypeError("fetch failed");
      return sseResponse("ok");
    });
    const r = await deliverToVessel("x", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
    });
    expect(r.kind).toBe("delivered");
  });

  it("returns kind:'vessel-unreachable' after exhausting backoff attempts", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await deliverToVessel("x", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: [10, 20, 40], // 4 total attempts
    });
    expect(r.kind).toBe("vessel-unreachable");
    if (r.kind !== "vessel-unreachable") throw new Error("unreachable");
    expect(r.attempts).toBe(4);
    expect(r.lastError.toLowerCase()).toContain("econnrefused");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("backs off up to the cap (~30s for default schedule)", () => {
    // Sanity check the production schedule. The cap defends against
    // unbounded backoff; total wall-clock for 6 attempts ≈ 61s.
    expect(DEFAULT_BACKOFF_MS.at(-1)).toBe(30_000);
    expect(DEFAULT_BACKOFF_MS.length).toBe(6);
    const total = DEFAULT_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(70_000);
    expect(total).toBeGreaterThan(50_000);
  });

  it("rethrows non-network errors instead of retrying forever", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("invariant violation: kaboom");
    });
    await expect(
      deliverToVessel("x", "http://vessel:3000", {
        fetchImpl: fetchImpl as never,
        sleep: noopSleep,
        backoffMs: FAST_BACKOFF,
      }),
    ).rejects.toThrow("kaboom");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("deliverToVessel — 409 busy", () => {
  it("retries 3x on 409 by default, then surfaces vessel-busy", async () => {
    const fetchImpl = vi.fn(async () => new Response("busy", { status: 409 }));
    const r = await deliverToVessel("x", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
      busyDelayMs: 1,
    });
    expect(r.kind).toBe("vessel-busy");
    // 1 initial + 3 busy retries (DEFAULT_BUSY_RETRIES).
    expect(fetchImpl).toHaveBeenCalledTimes(1 + DEFAULT_BUSY_RETRIES);
  });

  it("succeeds when vessel becomes available within busy retry budget", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response("busy", { status: 409 });
      return sseResponse("done");
    });
    const r = await deliverToVessel("x", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
      busyDelayMs: 1,
    });
    expect(r.kind).toBe("delivered");
    if (r.kind !== "delivered") throw new Error("unreachable");
    expect(r.responseText).toBe("done");
  });
});

describe("deliverToVessel — vessel-error class", () => {
  it("returns kind:'vessel-error' with status on 500 (no retry)", async () => {
    const fetchImpl = vi.fn(async () => new Response("LLM down", { status: 500 }));
    const r = await deliverToVessel("x", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
    });
    expect(r.kind).toBe("vessel-error");
    if (r.kind !== "vessel-error") throw new Error("unreachable");
    expect(r.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns kind:'vessel-error' on 503", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream", { status: 503 }));
    const r = await deliverToVessel("x", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
    });
    expect(r.kind).toBe("vessel-error");
  });

  it("returns kind:'vessel-error' on 404 (no retry, no busy-loop)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const r = await deliverToVessel("x", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
    });
    expect(r.kind).toBe("vessel-error");
    if (r.kind !== "vessel-error") throw new Error("unreachable");
    expect(r.status).toBe(404);
  });
});

describe("deliverToVessel — request shape", () => {
  it("always sends sender:'external' (bypasses v25 CLI player lockout)", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(""));
    await deliverToVessel("any body", "http://vessel:3000", {
      fetchImpl: fetchImpl as never,
      sleep: noopSleep,
      backoffMs: FAST_BACKOFF,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.sender).toBe("external");
    // sender is NOT undefined and NOT "player" — CLI's pre-flight skips
    // those by definition.
    expect(body.sender).not.toBe("player");
  });
});
