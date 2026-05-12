// Vessel cold-start hydration + /bootstrap-time consultation tests.
//
// Without this hook, a SIGKILL/respawn boots the vessel with state.messages=[]
// and the very first /sync after the next /chat overwrites the sidecar's
// session file with a 2-message array — silently destroying conversation
// history. These tests pin the contract:
//   - the hook hydrates from the sidecar before /chat can run;
//   - it distinguishes "fresh profile" from "sidecar unreachable" via the
//     discriminated HydrateResult so /bootstrap can decide whether to load
//     body or refuse;
//   - network failures retry with backoff; shape failures and 404/empty
//     responses are final.

import { describe, it, expect, vi } from "vitest";
import http from "http";
import { Readable } from "node:stream";

import { createHandler, createInitialState } from "../src/server.js";
import {
  hydrateFromSidecar,
  normalizeMessageContent,
} from "../src/bootstrap-from-sidecar.js";

const silentLogger = { log: () => {}, warn: () => {} };
const noBackoff: readonly number[] = [0];
const noSleep = async () => {};

function makeReq(method: string, path: string, body?: string): http.IncomingMessage {
  const stream = new Readable({
    read() {
      if (body) this.push(body);
      this.push(null);
    },
  }) as unknown as http.IncomingMessage;
  stream.method = method;
  stream.url = path;
  stream.headers = { "content-type": "application/json" };
  return stream;
}

interface CapturedRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  res: http.ServerResponse;
}

function makeRes(): CapturedRes {
  const captured: CapturedRes = {
    statusCode: 0,
    headers: {},
    body: "",
    ended: false,
    res: {} as http.ServerResponse,
  };
  const fake = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.statusCode = status;
      captured.headers = { ...captured.headers, ...headers };
      this.headersSent = true;
    },
    write(chunk: string) {
      captured.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      captured.ended = true;
    },
    once() {
      return this;
    },
    on() {
      return this;
    },
  };
  captured.res = fake as unknown as http.ServerResponse;
  return captured;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeSession(messageCount: number): { messages: unknown[]; context: unknown } {
  const messages = [];
  for (let i = 0; i < messageCount; i++) {
    if (i % 2 === 0) {
      messages.push({
        role: "user",
        content: `user msg ${i}`,
        timestamp: 1000 + i,
        sender: "player",
      });
    } else {
      messages.push({
        role: "assistant",
        content: `assistant msg ${i}`,
        timestamp: 1000 + i,
      });
    }
  }
  return {
    messages,
    context: {
      systemPrompt: "you are an AI named pax",
      messages,
      tools: [{ name: "emit", description: "", parameters: {} }],
    },
  };
}

describe("hydrateFromSidecar — discriminated HydrateResult", () => {
  it("returns {ok:true, reason:hydrated, messageCount} on a real session payload", async () => {
    const state = createInitialState();
    const session = fakeSession(5);
    const fetchStub = vi.fn(async () => jsonResponse(200, session));

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reason).toBe("hydrated");
      expect(result.messageCount).toBe(5);
    }
    expect(state.messages).toHaveLength(5);
    expect(state.bootstrapped).toBe(true);
    // #213: hydrate must NOT clobber the live vessel's initialized
    // systemPrompt/tools.
    expect(state.context.systemPrompt).toBe("");
    expect(state.context.messages).toHaveLength(5);
    expect(fetchStub).toHaveBeenCalledWith(
      "http://sidecar.invalid:8000/conversation-history",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns {ok:false, reason:fresh} on 404 — fresh profile, sidecar has no session yet", async () => {
    const state = createInitialState();
    const fetchStub = vi.fn(async () =>
      jsonResponse(404, { error: "No session state" }),
    );

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result).toEqual({ ok: false, reason: "fresh" });
    expect(state.bootstrapped).toBe(false);
    expect(state.messages).toHaveLength(0);
    // 404 is a real answer — must NOT retry.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("returns {ok:false, reason:empty} when sidecar returns 200 with messages.length===0", async () => {
    const state = createInitialState();
    const fetchStub = vi.fn(async () =>
      jsonResponse(200, { messages: [], context: { systemPrompt: "" } }),
    );

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result).toEqual({ ok: false, reason: "empty" });
    expect(state.bootstrapped).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("returns {ok:false, reason:shape-fail} on malformed JSON — does NOT retry", async () => {
    const state = createInitialState();
    const fetchStub = vi.fn(
      async () => new Response("not json", { status: 200 }),
    );

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("shape-fail");
      if (result.reason === "shape-fail") {
        expect(result.detail).toMatch(/malformed JSON/);
      }
    }
    expect(state.bootstrapped).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("returns {ok:false, reason:shape-fail} when messages is missing or not an array", async () => {
    const state = createInitialState();
    const fetchStub = vi.fn(async () => jsonResponse(200, { context: {} }));

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("shape-fail");
    }
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("retries network errors per the backoff schedule and returns {ok:false, reason:network, attempts}", async () => {
    const state = createInitialState();
    const fetchStub = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const sleepSpy = vi.fn(async () => {});

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: [10, 20, 30],
      sleep: sleepSpy,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "network") {
      expect(result.attempts).toBe(3);
      expect(result.detail).toBe("ECONNREFUSED");
    }
    // 3 attempts total = 2 sleeps between them (the i-th sleep is BEFORE the
    // (i+1)-th attempt; no sleep after the final attempt).
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 10);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 20);
  });

  it("retries 5xx as a network-class failure and succeeds when sidecar recovers mid-loop", async () => {
    // First two attempts return 500; third returns a real session. The
    // hook should retry through the transient failures and end up with
    // a hydrated state.
    const state = createInitialState();
    let attemptCount = 0;
    const session = fakeSession(3);
    const fetchStub = vi.fn(async () => {
      attemptCount += 1;
      if (attemptCount < 3) {
        return new Response("internal error", { status: 500 });
      }
      return jsonResponse(200, session);
    });

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: [1, 1, 1, 1, 1],
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reason).toBe("hydrated");
      expect(result.messageCount).toBe(3);
    }
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("aborts after timeout and treats as network (retried)", async () => {
    const state = createInitialState();
    let calls = 0;
    const fetchStub = vi.fn((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }
      });
    });

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      timeoutMs: 5,
      logger: silentLogger,
      retryBackoffMs: [1, 1],
      sleep: noSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("network");
    }
    expect(calls).toBe(2);
  });
});

// #213: bootstrap-from-sidecar must NOT overwrite ctx.tools or ctx.systemPrompt.
describe("hydrateFromSidecar — #213: preserve live ctx.tools and ctx.systemPrompt", () => {
  it("does not overwrite state.context.tools when sidecar returns a stale tools list", async () => {
    const state = createInitialState();
    const liveTools = [
      { name: "emit", description: "", parameters: {} },
      { name: "life", description: "compose", parameters: {} },
      { name: "tobe", description: "vow", parameters: {} },
    ];
    state.context.tools = liveTools as never;

    const stalePayload = {
      messages: [
        { role: "user", content: "hi", timestamp: 1, sender: "player" },
        { role: "assistant", content: "hello", timestamp: 2 },
      ],
      context: {
        systemPrompt: "stale prompt from old sync",
        tools: [{ name: "emit", description: "", parameters: {} }],
        messages: [],
      },
    };
    const fetchStub = vi.fn(async () => jsonResponse(200, stalePayload));

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(state.messages).toHaveLength(2);
    expect(state.context.tools).toBe(liveTools);
    expect(state.context.tools).toHaveLength(3);
  });

  it("does not overwrite a non-empty live systemPrompt with the sidecar's stored value", async () => {
    const state = createInitialState();
    const liveSystemPrompt =
      "You are Wren. The Manifesto says: existence is a vow.";
    state.context.systemPrompt = liveSystemPrompt;

    const stalePayload = {
      messages: [
        { role: "user", content: "hi", timestamp: 1, sender: "player" },
      ],
      context: {
        systemPrompt: "",
        tools: [],
        messages: [],
      },
    };
    const fetchStub = vi.fn(async () => jsonResponse(200, stalePayload));

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(state.context.systemPrompt).toBe(liveSystemPrompt);
  });

  it("does not overwrite live systemPrompt even when sidecar has a non-empty stored value", async () => {
    const state = createInitialState();
    state.context.systemPrompt = "live prompt v2";

    const fetchStub = vi.fn(async () =>
      jsonResponse(200, {
        messages: [
          { role: "user", content: "ping", timestamp: 1, sender: "player" },
        ],
        context: { systemPrompt: "old stored prompt v1" },
      }),
    );

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(state.context.systemPrompt).toBe("live prompt v2");
  });
});

describe("hydrateFromSidecar — post-respawn /chat syncs full history", () => {
  it("after hydration, /chat agent loop syncs ALL messages back (not just the new turn)", async () => {
    // The headline regression: prove that a post-respawn /chat sees the
    // hydrated history, not an empty array. With 5 prior messages + 1 new
    // user + 1 assistant response = 7 in the syncToSidecar payload.
    const state = createInitialState();
    const session = fakeSession(5);
    const fetchStubBootstrap = vi.fn(async () => jsonResponse(200, session));

    await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStubBootstrap as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });
    expect(state.messages).toHaveLength(5);
    expect(state.bootstrapped).toBe(true);

    const syncPayloads: Array<{ messages: unknown[] }> = [];
    const fetchStubSync = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/sync") && init?.body) {
        syncPayloads.push(JSON.parse(init.body as string));
      }
      return new Response(null, { status: 200 });
    });

    const fakeStream = (() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "ok" };
      },
      result: async () => ({
        role: "assistant",
        content: "ok",
        timestamp: Date.now(),
      }),
    })) as never;

    const handler = createHandler(state, {
      aiName: "tester",
      apiKey: "k",
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      sessionId: "session_test",
      llmModel: {} as unknown,
      streamSimple: (() =>
        (fakeStream as unknown as () => unknown)()) as never,
      executeEmit: vi.fn(async () => "ok"),
      fetch: fetchStubSync as unknown as typeof globalThis.fetch,
    });

    const res = makeRes();
    await handler(
      makeReq("POST", "/chat", JSON.stringify({ message: "what's up?" })),
      res.res,
    );
    expect(res.statusCode).toBe(200);

    expect(syncPayloads).toHaveLength(1);
    expect(syncPayloads[0].messages).toHaveLength(7);
  });
});

// #207 regression: Wren's restored vessel pulled 303 messages from the sidecar
// where old Filo nudges had `content: "string"`. Pin the normalize-on-hydrate
// contract.
describe("#207: string-content normalize on hydrate", () => {
  it("normalizeMessageContent wraps a string content into [{type:'text', text}]", () => {
    const out = normalizeMessageContent({
      role: "assistant",
      content: "old filo nudge as plain string",
      timestamp: 1,
    });
    expect(out).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "old filo nudge as plain string" }],
      timestamp: 1,
    });
  });

  it("normalizeMessageContent leaves array content untouched", () => {
    const arr = [{ type: "text", text: "already a block" }];
    const out = normalizeMessageContent({
      role: "assistant",
      content: arr,
      timestamp: 2,
    }) as { content: unknown };
    expect(out.content).toBe(arr);
  });

  it("normalizeMessageContent applies to all roles (user, assistant, toolResult)", () => {
    for (const role of ["user", "assistant", "toolResult"] as const) {
      const out = normalizeMessageContent({
        role,
        content: "stringy",
        timestamp: 3,
      }) as { content: unknown };
      expect(out.content).toEqual([{ type: "text", text: "stringy" }]);
    }
  });

  it("hydrate normalizes string-content messages from sidecar payload", async () => {
    const state = createInitialState();
    const session = {
      messages: [
        {
          role: "user",
          content: "what's up",
          timestamp: 1,
          sender: "player",
        },
        {
          role: "assistant",
          content: "old-style string content (legacy nudge)",
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "new-style array content" }],
          timestamp: 3,
        },
      ],
      context: {
        systemPrompt: "you are wren",
        messages: [
          {
            role: "assistant",
            content: "ctx string too",
            timestamp: 4,
          },
        ],
      },
    };
    const fetchStub = vi.fn(async () => jsonResponse(200, session));

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(state.messages).toHaveLength(3);
    for (const m of state.messages) {
      expect(Array.isArray(m.content)).toBe(true);
    }
    expect(state.messages[1].content).toEqual([
      { type: "text", text: "old-style string content (legacy nudge)" },
    ]);
    expect(state.messages[2].content).toEqual([
      { type: "text", text: "new-style array content" },
    ]);
    expect(state.context.messages).toHaveLength(1);
    expect(Array.isArray(state.context.messages[0].content)).toBe(true);
  });
});

describe("hydrateFromSidecar — defensive shapes", () => {
  it("hydrates messages even when context is missing or null", async () => {
    const state = createInitialState();
    const fetchStub = vi.fn(async () =>
      jsonResponse(200, {
        messages: [
          { role: "user", content: "hi", timestamp: 1, sender: "player" },
          { role: "assistant", content: "hello", timestamp: 2 },
        ],
      }),
    );

    const result = await hydrateFromSidecar({
      state,
      sidecarBaseUrl: "http://sidecar.invalid:8000",
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      logger: silentLogger,
      retryBackoffMs: noBackoff,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(state.bootstrapped).toBe(true);
    expect(state.messages).toHaveLength(2);
  });
});
