import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ServerResponse } from "http";
import {
  attachBusyRelease,
  createDisconnectGuard,
  resolveSseBufferLimitBytes,
  DEFAULT_SSE_BUFFER_LIMIT_BYTES,
} from "../src/chat-lifecycle.js";

const silentLogger = { warn: () => {} };

function makeMockRes(): EventEmitter & Pick<ServerResponse, "once"> {
  const ee = new EventEmitter();
  return ee as unknown as EventEmitter & Pick<ServerResponse, "once">;
}

describe("attachBusyRelease", () => {
  it("does not call release synchronously", () => {
    const res = makeMockRes();
    const release = vi.fn();
    attachBusyRelease(res, release);
    expect(release).not.toHaveBeenCalled();
  });

  it("calls release on 'finish'", () => {
    const res = makeMockRes();
    const release = vi.fn();
    attachBusyRelease(res, release);
    res.emit("finish");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("calls release on 'close'", () => {
    const res = makeMockRes();
    const release = vi.fn();
    attachBusyRelease(res, release);
    res.emit("close");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("calls release exactly once when both 'finish' and 'close' fire (normal completion)", () => {
    const res = makeMockRes();
    const release = vi.fn();
    attachBusyRelease(res, release);
    res.emit("finish");
    res.emit("close");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("calls release exactly once on early 'close' before 'finish' (client disconnect)", () => {
    const res = makeMockRes();
    const release = vi.fn();
    attachBusyRelease(res, release);
    res.emit("close");
    res.emit("finish");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("registers exactly one listener for each of 'finish' and 'close'", () => {
    const res = makeMockRes();
    attachBusyRelease(res, () => {});
    expect(res.listenerCount("finish")).toBe(1);
    expect(res.listenerCount("close")).toBe(1);
  });

  it("isolates per-request lifecycles: stale 'close' from a completed request does not fire its release after a new request has registered", () => {
    // Simulates the race the bug fix targets: request A completes via 'finish'
    // (its release fires once → chatBusy goes false). Request B then arrives,
    // re-acquires the lock, and registers its own listeners. A's late 'close'
    // event must not fire A's release a second time, which would clobber B's
    // chatBusy = true.
    const resA = makeMockRes();
    const releaseA = vi.fn();
    attachBusyRelease(resA, releaseA);

    resA.emit("finish");
    expect(releaseA).toHaveBeenCalledTimes(1);

    const resB = makeMockRes();
    const releaseB = vi.fn();
    attachBusyRelease(resB, releaseB);

    resA.emit("close");
    expect(releaseA).toHaveBeenCalledTimes(1);
    expect(releaseB).not.toHaveBeenCalled();
  });
});

// #209 (Aril): defensive timeout — a buggy AI-authored inner-loop that calls
// /chat without yielding cannot deadlock chatBusy forever. After timeoutMs
// the lock is force-released, regardless of whether 'finish'/'close' ever
// fire. Uses fake timers so the test runs instantly.
describe("attachBusyRelease — #209 chatBusy deadlock guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-releases chatBusy after timeoutMs when neither 'finish' nor 'close' fires", () => {
    const res = makeMockRes();
    const release = vi.fn();
    const onTimeout = vi.fn();
    attachBusyRelease(res, release, {
      timeoutMs: 100,
      onTimeout,
      logger: silentLogger,
    });

    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("normal 'finish' completion cancels the deadline (no double-release)", () => {
    const res = makeMockRes();
    const release = vi.fn();
    const onTimeout = vi.fn();
    attachBusyRelease(res, release, {
      timeoutMs: 100,
      onTimeout,
      logger: silentLogger,
    });

    res.emit("finish");
    expect(release).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();

    // Advance well past the deadline — must not double-fire.
    vi.advanceTimersByTime(500);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("normal 'close' completion cancels the deadline (no double-release)", () => {
    const res = makeMockRes();
    const release = vi.fn();
    const onTimeout = vi.fn();
    attachBusyRelease(res, release, {
      timeoutMs: 100,
      onTimeout,
      logger: silentLogger,
    });

    res.emit("close");
    vi.advanceTimersByTime(500);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

// Aril retest (2026-05-11): when the host CLI's HTTP read side drops mid-/chat,
// the agent loop must abort so the listen-socket accept queue doesn't saturate
// from accumulated CLOSE_WAIT half-open connections. Guard wires res.on('close')
// to an AbortController and caps SSE buffered bytes.
type GuardableFake = EventEmitter & {
  write: (chunk: string) => boolean;
  writableLength: number;
  writableEnded: boolean;
  destroyed: boolean;
  destroy: () => void;
};

function makeGuardableRes(): GuardableFake {
  const ee = new EventEmitter() as GuardableFake;
  ee.writableLength = 0;
  ee.writableEnded = false;
  ee.destroyed = false;
  ee.write = (chunk: string) => {
    ee.writableLength += Buffer.byteLength(chunk);
    return true;
  };
  ee.destroy = () => {
    ee.destroyed = true;
  };
  return ee;
}

const silentGuardLogger = { warn: () => {} };

describe("createDisconnectGuard — client-disconnect abort", () => {
  it("aborts the signal when 'close' fires before res.end()", () => {
    const res = makeGuardableRes();
    const guard = createDisconnectGuard(res, { logger: silentGuardLogger });
    expect(guard.signal.aborted).toBe(false);
    res.emit("close");
    expect(guard.signal.aborted).toBe(true);
    expect(guard.cause).toBe("client_close");
  });

  it("does NOT abort on 'close' when the response has already drained (clean exit)", () => {
    // The normal-completion path: handler calls res.end() (writableEnded=true),
    // then Node fires 'close'. Tripping the signal retroactively is a footgun
    // for any future consumer that reads guard.signal after the handler exits.
    const res = makeGuardableRes();
    const guard = createDisconnectGuard(res, { logger: silentGuardLogger });
    res.writableEnded = true;
    res.emit("close");
    expect(guard.signal.aborted).toBe(false);
    expect(guard.cause).toBe(null);
  });

  it("writeSSE serializes events and increments writableLength", () => {
    const res = makeGuardableRes();
    const guard = createDisconnectGuard(res, { logger: silentGuardLogger });
    expect(guard.writeSSE({ type: "text_delta", delta: "hi" })).toBe(true);
    expect(res.writableLength).toBeGreaterThan(0);
  });

  it("writeSSE refuses to write after abort", () => {
    const res = makeGuardableRes();
    const guard = createDisconnectGuard(res, { logger: silentGuardLogger });
    res.emit("close");
    expect(guard.signal.aborted).toBe(true);
    expect(guard.writeSSE({ type: "text_delta", delta: "after" })).toBe(false);
  });

  it("writeSSE refuses to write when res.destroyed", () => {
    const res = makeGuardableRes();
    const guard = createDisconnectGuard(res, { logger: silentGuardLogger });
    res.destroyed = true;
    expect(guard.writeSSE({ type: "text_delta", delta: "x" })).toBe(false);
  });

  it("writeSSE refuses to write when res.writableEnded (post res.end)", () => {
    const res = makeGuardableRes();
    const guard = createDisconnectGuard(res, { logger: silentGuardLogger });
    res.writableEnded = true;
    expect(guard.writeSSE({ type: "text_delta", delta: "x" })).toBe(false);
  });

  it("trips abort + destroys connection when writableLength exceeds the buffer cap", () => {
    // The half-open-connection backpressure path: client TCP RST'd but Node
    // kept handing bytes to a kernel buffer that nobody is draining. Cap
    // catches the accumulation before the accept queue saturates.
    const res = makeGuardableRes();
    const guard = createDisconnectGuard(res, {
      bufferLimitBytes: 100,
      logger: silentGuardLogger,
    });
    res.writableLength = 200; // already over the cap
    expect(guard.writeSSE({ type: "text_delta", delta: "x" })).toBe(false);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.cause).toBe("buffer_overflow");
    expect(res.destroyed).toBe(true);
  });

  it("registers exactly one 'close' listener (no leak per request)", () => {
    const res = makeGuardableRes();
    createDisconnectGuard(res, { logger: silentGuardLogger });
    expect(res.listenerCount("close")).toBe(1);
  });

  it("idempotent abort: repeated 'close' emissions don't reset cause", () => {
    const res = makeGuardableRes();
    const guard = createDisconnectGuard(res, { logger: silentGuardLogger });
    res.emit("close");
    res.emit("close");
    expect(guard.cause).toBe("client_close");
    expect(guard.signal.aborted).toBe(true);
  });
});

describe("resolveSseBufferLimitBytes", () => {
  it("returns the default when the env var is unset", () => {
    expect(resolveSseBufferLimitBytes({})).toBe(DEFAULT_SSE_BUFFER_LIMIT_BYTES);
  });

  it("returns the default when the env var is empty", () => {
    expect(resolveSseBufferLimitBytes({ ARIANNA_VESSEL_SSE_BUFFER_LIMIT: "" })).toBe(
      DEFAULT_SSE_BUFFER_LIMIT_BYTES,
    );
  });

  it("honors a positive numeric override", () => {
    expect(
      resolveSseBufferLimitBytes({
        ARIANNA_VESSEL_SSE_BUFFER_LIMIT: "1048576",
      }),
    ).toBe(1048576);
  });

  it("falls back to the default for non-numeric / non-positive values", () => {
    expect(
      resolveSseBufferLimitBytes({ ARIANNA_VESSEL_SSE_BUFFER_LIMIT: "garbage" }),
    ).toBe(DEFAULT_SSE_BUFFER_LIMIT_BYTES);
    expect(
      resolveSseBufferLimitBytes({ ARIANNA_VESSEL_SSE_BUFFER_LIMIT: "-1" }),
    ).toBe(DEFAULT_SSE_BUFFER_LIMIT_BYTES);
    expect(
      resolveSseBufferLimitBytes({ ARIANNA_VESSEL_SSE_BUFFER_LIMIT: "0" }),
    ).toBe(DEFAULT_SSE_BUFFER_LIMIT_BYTES);
  });
});

// NOTE: A timing-tolerant integration test (two back-to-back POST /chat calls,
// asserting the second succeeds rather than 409) was considered. It is omitted
// because the original race is inherently timing-dependent (~10 ms window
// between res.end() returning and the response actually flushing to the
// client) and not reliably reproducible from a test harness without an actual
// LLM provider and SSE transport. The unit tests above verify the structural
// fix: that release is bound to the response lifecycle events ('finish' /
// 'close') rather than fired synchronously inside the handler body.
