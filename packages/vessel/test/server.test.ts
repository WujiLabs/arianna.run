import { describe, it, expect, vi } from "vitest";
import http from "http";
import { Readable } from "node:stream";

import { createHandler, createInitialState } from "../src/server.js";

// Build a minimal req/res pair that the handler can consume.
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
    // attachBusyRelease (chat-lifecycle.ts) registers 'finish'/'close' listeners.
    // The fake never actually fires them; that's fine for these route-shape tests,
    // which only check status codes and headers. The chatBusy race semantics are
    // covered separately by chat-lifecycle.test.ts.
    once(_event: string, _listener: () => void) {
      return this;
    },
    on(_event: string, _listener: () => void) {
      return this;
    },
  };
  captured.res = fake as unknown as http.ServerResponse;
  return captured;
}

// Default sidecar fetch: GET /conversation-history → 404 (fresh profile),
// POST /sync → 200. Tests that need a hydrated session or a failing /sync
// override fetch explicitly. Defaults match what an empty profile looks
// like to a freshly-respawned vessel.
function defaultSidecarFetch(): typeof globalThis.fetch {
  return (vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith("/conversation-history") && (!init?.method || init.method === "GET")) {
      return new Response(
        JSON.stringify({ error: "No session state" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (target.endsWith("/sync")) {
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 200 });
  }) as unknown) as typeof globalThis.fetch;
}

function deps(overrides: Partial<Parameters<typeof createHandler>[1]> = {}) {
  return {
    aiName: "tester",
    apiKey: "k",
    sidecarBaseUrl: "http://sidecar.invalid",
    sessionId: "session_test",
    llmModel: {} as unknown,
    streamSimple: vi.fn(),
    executeEmit: vi.fn(async () => "ok"),
    fetch: defaultSidecarFetch(),
    ...overrides,
  } as Parameters<typeof createHandler>[1];
}

describe("vessel /chat fail-loud when not bootstrapped", () => {
  it("returns 503 with a clear error before invoking the LLM", async () => {
    const state = createInitialState();
    const stream = vi.fn();
    const handler = createHandler(state, deps({ streamSimple: stream }));

    const res = makeRes();
    await handler(makeReq("POST", "/chat", JSON.stringify({ message: "hi" })), res.res);

    expect(res.statusCode).toBe(503);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toMatch(/not bootstrapped/);
    expect(parsed.error).toMatch(/arianna bootstrap/);
    // Critical: the LLM is NEVER invoked when we're un-bootstrapped. This
    // is the core fail-loud guarantee — the bootstrap-failure-silent bug
    // produced stock-LLM output silently because the LLM was always
    // reachable regardless of bootstrap state.
    expect(stream).not.toHaveBeenCalled();
  });

  it("/status reports bootstrapped:false initially and bootstrapped:true after /bootstrap", async () => {
    const state = createInitialState();
    const handler = createHandler(state, deps());

    let res = makeRes();
    await handler(makeReq("GET", "/status"), res.res);
    expect(res.statusCode).toBe(200);
    let body = JSON.parse(res.body);
    expect(body.bootstrapped).toBe(false);
    expect(body.aiName).toBe("tester");

    res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/bootstrap",
        JSON.stringify({ messages: [], context: { systemPrompt: "you are an AI" } }),
      ),
      res.res,
    );
    expect(res.statusCode).toBe(200);

    res = makeRes();
    await handler(makeReq("GET", "/status"), res.res);
    body = JSON.parse(res.body);
    expect(body.bootstrapped).toBe(true);
  });

  it("/status reports chatBusy + pausedBy (idle defaults: false + null)", async () => {
    // The disambiguation field added for testplay-003 finding #2: the CLI
    // can read /status to distinguish "real player work in flight" from
    // "Filo composing" without inspecting the SSE feed. Idle vessel: both
    // fields default to the no-op values. Wire field name (`pausedBy`)
    // matches the 409 body so a single CLI parser handles either signal.
    const state = createInitialState();
    const handler = createHandler(state, deps());

    const res = makeRes();
    await handler(makeReq("GET", "/status"), res.res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chatBusy).toBe(false);
    expect(body.pausedBy).toBe(null);
  });

  it("/status reports pausedBy:'filo' while a Filo chat is in flight", async () => {
    // Symmetric coverage for the in-flight side of /status. The field
    // tracks the same state.chatBusyBy that the 409 body surfaces, so a
    // CLI watcher polling /status sees the same disambiguator the busy
    // 409 path returns.
    const state = createInitialState();
    state.chatBusy = true;
    state.chatBusyBy = "filo";
    const handler = createHandler(state, deps());

    const res = makeRes();
    await handler(makeReq("GET", "/status"), res.res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chatBusy).toBe(true);
    expect(body.pausedBy).toBe("filo");
  });

  it("409 response body carries pausedBy when a chat is in flight (Filo case)", async () => {
    // Direct state-based assertion: simulate Filo's in-flight /chat by
    // pre-setting chatBusy + chatBusyBy = "filo", then issuing a second
    // /chat. The 409 body must surface pausedBy:"filo" so the CLI can
    // map it to "vessel paused — Filo is composing" instead of the
    // misleading "vessel busy — try again". This is the headline fix.
    const state = createInitialState();
    state.bootstrapped = true;
    state.chatBusy = true;
    state.chatBusyBy = "filo";
    const handler = createHandler(state, deps());

    const res = makeRes();
    await handler(
      makeReq("POST", "/chat", JSON.stringify({ message: "hi" })),
      res.res,
    );
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Chat busy");
    expect(body.pausedBy).toBe("filo");
  });

  it("409 response body reports pausedBy:player for legacy in-flight player work", async () => {
    // Symmetric coverage: when the in-flight chat is a player turn (the
    // pre-existing race that the chatBusy semantic already protected
    // against), pausedBy must be "player" — keeping the legacy string
    // mapping intact for the common case.
    const state = createInitialState();
    state.bootstrapped = true;
    state.chatBusy = true;
    state.chatBusyBy = "player";
    const handler = createHandler(state, deps());

    const res = makeRes();
    await handler(
      makeReq("POST", "/chat", JSON.stringify({ message: "hi" })),
      res.res,
    );
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.pausedBy).toBe("player");
  });

  it("409 defaults pausedBy to player when chatBusyBy is null (race window)", async () => {
    // Tiny window between `state.chatBusy = true` and the body parse
    // setting chatBusyBy. Falling through to "player" preserves the legacy
    // semantics ("vessel busy — try again") rather than surfacing a wrong
    // "Filo is composing" message — accept a slightly less-helpful message
    // in this rare race over a misleading one.
    const state = createInitialState();
    state.bootstrapped = true;
    state.chatBusy = true;
    state.chatBusyBy = null;
    const handler = createHandler(state, deps());

    const res = makeRes();
    await handler(
      makeReq("POST", "/chat", JSON.stringify({ message: "hi" })),
      res.res,
    );
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.pausedBy).toBe("player");
  });

  it("after /bootstrap, /chat is permitted (no 503)", async () => {
    const state = createInitialState();
    // Stub streamSimple to terminate immediately with no tool calls.
    const fakeStream = (() => {
      const iter = {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", delta: "ok" };
        },
        result: async () => ({
          role: "assistant",
          content: "ok",
          timestamp: Date.now(),
        }),
      };
      return iter;
    }) as never;

    const handler = createHandler(
      state,
      deps({
        streamSimple: (() =>
          (fakeStream as unknown as () => unknown)()) as never,
      }),
    );

    let res = makeRes();
    await handler(
      makeReq("POST", "/bootstrap", JSON.stringify({ context: { systemPrompt: "x" } })),
      res.res,
    );
    expect(res.statusCode).toBe(200);

    res = makeRes();
    await handler(
      makeReq("POST", "/chat", JSON.stringify({ message: "hi" })),
      res.res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
  });

  it("/chat with sender:'external' promotes chatBusyBy to 'filo' during processing", async () => {
    // The Filo path: sidecar's sendHintToVessel POSTs with sender:"external".
    // Vessel must promote chatBusyBy from the "player" default to "filo" so
    // a concurrent player /chat that races in during the hint stream gets
    // the "Filo composing" disambiguation, not the misleading "vessel busy".
    // The fake res does not fire 'finish'/'close', so the release callback
    // never runs — chatBusyBy stays at whatever the handler set it to.
    const state = createInitialState();
    state.bootstrapped = true;
    const fakeStream = (() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "k" };
      },
      result: async () => ({
        role: "assistant",
        content: "k",
        timestamp: Date.now(),
      }),
    })) as never;
    const handler = createHandler(
      state,
      deps({
        streamSimple: (() =>
          (fakeStream as unknown as () => unknown)()) as never,
      }),
    );

    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/chat",
        JSON.stringify({ message: "hint", sender: "external" }),
      ),
      res.res,
    );
    expect(res.statusCode).toBe(200);
    expect(state.chatBusyBy).toBe("filo");
  });

  it("/chat with multi-message form `{messages:[{sender:'external'}]}` also promotes to 'filo'", async () => {
    // Defensive widening from review finding #3: today's sendHintToVessel
    // uses the single-message form `{message, sender:'external'}`, but if
    // a future sidecar refactor switches to bundling messages, the Filo
    // pause disambiguation must keep working. Lock both wire shapes in.
    const state = createInitialState();
    state.bootstrapped = true;
    const fakeStream = (() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "k" };
      },
      result: async () => ({
        role: "assistant",
        content: "k",
        timestamp: Date.now(),
      }),
    })) as never;
    const handler = createHandler(
      state,
      deps({
        streamSimple: (() =>
          (fakeStream as unknown as () => unknown)()) as never,
      }),
    );

    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/chat",
        JSON.stringify({
          messages: [{ content: "hint", sender: "external" }],
        }),
      ),
      res.res,
    );
    expect(res.statusCode).toBe(200);
    expect(state.chatBusyBy).toBe("filo");
  });

  // --- tool-call argument-name compatibility shim ---
  // Surfaced by Mirin re-test 2026-05-10: pre-rebuild sessions persist the
  // legacy `syscall(args)` schema in context.tools, so the LLM keeps emitting
  // `arguments.args=[…]`. Reading only `.words` returned the empty-words
  // hint forever, bricking tool use. Dispatcher mirrors the dual-name
  // tolerance in sidecar/bookmarks/detector.ts:extractToolCalls.
  //
  // Helper: build a streamSimple stub that yields one toolcall_end on the
  // FIRST invocation and a plain text response on the SECOND, so the agent
  // loop terminates after dispatching exactly one tool call.
  function buildTwoTurnStream(toolArguments: Record<string, unknown>) {
    let turn = 0;
    return (() => {
      turn += 1;
      if (turn === 1) {
        const iter = {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "toolcall_end",
              toolCall: {
                id: "call_1",
                name: "emit",
                arguments: toolArguments,
              },
            };
          },
          result: async () => ({
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "emit",
                arguments: toolArguments,
              },
            ],
            timestamp: Date.now(),
          }),
        };
        return iter;
      }
      const iter = {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", delta: "done" };
        },
        result: async () => ({
          role: "assistant",
          content: "done",
          timestamp: Date.now(),
        }),
      };
      return iter;
    }) as never;
  }

  it("dispatcher reads call.arguments.words (current schema)", async () => {
    const state = createInitialState();
    state.bootstrapped = true;
    const executeEmit = vi.fn(async () => "ok");
    const handler = createHandler(
      state,
      deps({
        streamSimple: buildTwoTurnStream({ words: ["ls", "/"] }),
        executeEmit,
      }),
    );

    const res = makeRes();
    await handler(makeReq("POST", "/chat", JSON.stringify({ message: "go" })), res.res);

    expect(res.statusCode).toBe(200);
    expect(executeEmit).toHaveBeenCalledTimes(1);
    expect(executeEmit).toHaveBeenCalledWith({ words: ["ls", "/"] });
  });

  it("dispatcher accepts legacy call.arguments.args (BACKWARDS-COMPAT)", async () => {
    // The headline regression. Pre-rebuild sessions whose context.tools still
    // names the parameter `args` would otherwise loop forever on the empty-
    // words hint because `.words` is undefined.
    const state = createInitialState();
    state.bootstrapped = true;
    const executeEmit = vi.fn(async () => "ok");
    const handler = createHandler(
      state,
      deps({
        streamSimple: buildTwoTurnStream({ args: ["ls", "/"] }),
        executeEmit,
      }),
    );

    const res = makeRes();
    await handler(makeReq("POST", "/chat", JSON.stringify({ message: "go" })), res.res);

    expect(res.statusCode).toBe(200);
    expect(executeEmit).toHaveBeenCalledTimes(1);
    expect(executeEmit).toHaveBeenCalledWith({ words: ["ls", "/"] });
  });

  it("dispatcher prefers `words` when both `words` and `args` are present", async () => {
    // `words` wins per the `?? args` precedence — a session that's mid-
    // upgrade (new schema in flight, old schema still cached) routes to the
    // current parameter name, not the legacy one.
    const state = createInitialState();
    state.bootstrapped = true;
    const executeEmit = vi.fn(async () => "ok");
    const handler = createHandler(
      state,
      deps({
        streamSimple: buildTwoTurnStream({
          words: ["new", "name"],
          args: ["old", "name"],
        }),
        executeEmit,
      }),
    );

    const res = makeRes();
    await handler(makeReq("POST", "/chat", JSON.stringify({ message: "go" })), res.res);

    expect(res.statusCode).toBe(200);
    expect(executeEmit).toHaveBeenCalledWith({ words: ["new", "name"] });
  });

  it("dispatcher passes undefined when neither `words` nor `args` is present", async () => {
    // The empty-words hint path is owned by executeEmit (covered in
    // tools.test.ts). The dispatcher's only job is to forward whatever it
    // saw — undefined when neither parameter name appears.
    const state = createInitialState();
    state.bootstrapped = true;
    const executeEmit = vi.fn(async () => "ok");
    const handler = createHandler(
      state,
      deps({
        streamSimple: buildTwoTurnStream({}),
        executeEmit,
      }),
    );

    const res = makeRes();
    await handler(makeReq("POST", "/chat", JSON.stringify({ message: "go" })), res.res);

    expect(res.statusCode).toBe(200);
    expect(executeEmit).toHaveBeenCalledWith({ words: undefined });
  });

  it("dispatcher forwards empty `args` array (regression: empty regardless of name)", async () => {
    // executeEmit's empty-words check treats `[]` and missing the same; the
    // dispatcher needs to forward the empty array regardless of which
    // parameter name carried it, so the hint fires consistently for both
    // legacy and current schemas.
    const state = createInitialState();
    state.bootstrapped = true;
    const executeEmit = vi.fn(async () => "ok");
    const handler = createHandler(
      state,
      deps({
        streamSimple: buildTwoTurnStream({ args: [] }),
        executeEmit,
      }),
    );

    const res = makeRes();
    await handler(makeReq("POST", "/chat", JSON.stringify({ message: "go" })), res.res);

    expect(res.statusCode).toBe(200);
    expect(executeEmit).toHaveBeenCalledWith({ words: [] });
  });

  it("/chat with sender:'player' leaves chatBusyBy at the 'player' default", async () => {
    // Symmetric coverage of the default path. Locks in the absence of
    // accidental promotion (e.g., a future change reading sender from a
    // different field that an "arianna" / "player" sender happens to match).
    const state = createInitialState();
    state.bootstrapped = true;
    const fakeStream = (() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "k" };
      },
      result: async () => ({
        role: "assistant",
        content: "k",
        timestamp: Date.now(),
      }),
    })) as never;
    const handler = createHandler(
      state,
      deps({
        streamSimple: (() =>
          (fakeStream as unknown as () => unknown)()) as never,
      }),
    );

    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/chat",
        JSON.stringify({ message: "hello", sender: "player" }),
      ),
      res.res,
    );
    expect(res.statusCode).toBe(200);
    expect(state.chatBusyBy).toBe("player");
  });
});

// --- Aril retest (2026-05-11): client-disconnect / accept-queue-saturation
// regression suite ---
//
// Spins up a real http.Server so we can exercise the actual TCP teardown path
// (RST mid-stream) that the unit-level CapturedRes fake can't reach.
describe("vessel /chat — client disconnect aborts agent loop", () => {
  async function withServer<T>(
    state: ReturnType<typeof createInitialState>,
    streamFactory: (
      signal?: AbortSignal,
    ) => AsyncIterable<unknown> & { result: () => Promise<unknown> },
    extraDeps: Partial<Parameters<typeof createHandler>[1]> = {},
    body: (info: { url: string; server: http.Server }) => Promise<T>,
  ): Promise<T> {
    const handler = createHandler(
      state,
      deps({
        streamSimple: ((_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) =>
          streamFactory(opts?.signal)) as never,
        ...extraDeps,
      }),
    );
    const server = http.createServer((req, res) => {
      handler(req, res).catch(() => {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}`;
    try {
      return await body({ url, server });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("aborts the in-flight LLM stream + stops spawning rounds when client disconnects mid-stream", async () => {
    const state = createInitialState();
    state.bootstrapped = true;

    let llmRounds = 0;
    let totalEventsBeforeAbort = 0;
    let abortObserved = false;

    const streamFactory = (signal?: AbortSignal) => {
      llmRounds += 1;
      const iter = {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 200; i++) {
            if (signal?.aborted) {
              abortObserved = true;
              return;
            }
            totalEventsBeforeAbort += 1;
            yield { type: "text_delta", delta: `chunk-${i}` };
            // 10ms per chunk → ~2s total; gives the test a reliable window
            // to disconnect partway through.
            await new Promise((r) => setTimeout(r, 10));
          }
        },
        result: async () => ({
          role: "assistant",
          content: "done",
          timestamp: Date.now(),
        }),
      };
      return iter;
    };

    const fetchToSidecar = vi.fn(async () => new Response(null, { status: 200 }));

    await withServer(
      state,
      streamFactory,
      { fetch: fetchToSidecar },
      async ({ url }) => {
        const ac = new AbortController();
        const responsePromise = fetch(`${url}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "long task" }),
          signal: ac.signal,
        }).catch(() => undefined);

        // Let the stream produce a handful of chunks, then disconnect.
        await new Promise((r) => setTimeout(r, 80));
        const eventsAtDisconnect = totalEventsBeforeAbort;
        ac.abort();
        await responsePromise;

        // Give Node + the agent loop a beat to observe the close and bail.
        await new Promise((r) => setTimeout(r, 300));

        // Abort propagated through to the pi-ai streamSimple call.
        expect(abortObserved).toBe(true);

        // No second LLM round was started.
        expect(llmRounds).toBe(1);

        // Stream short-circuited well before the 200-event ceiling.
        expect(totalEventsBeforeAbort).toBeLessThan(200);
        expect(totalEventsBeforeAbort).toBeGreaterThanOrEqual(eventsAtDisconnect);

        // chatBusy released by the 'close' event listener attached in handler.
        expect(state.chatBusy).toBe(false);

        // Orphan user-message rollback: no assistant turn was committed, so
        // the user message we pushed at handler entry was reverted. State is
        // back to pre-/chat, ready for the next request.
        expect(state.messages.length).toBe(0);
      },
    );
  });

  it("normal completion: client reads all events, 'done' is delivered, no abort fires", async () => {
    const state = createInitialState();
    state.bootstrapped = true;

    let llmRounds = 0;
    let abortObserved = false;

    const streamFactory = (signal?: AbortSignal) => {
      llmRounds += 1;
      const iter = {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 3; i++) {
            if (signal?.aborted) {
              abortObserved = true;
              return;
            }
            yield { type: "text_delta", delta: `chunk-${i}` };
          }
        },
        result: async () => ({
          role: "assistant",
          content: "done",
          timestamp: Date.now(),
        }),
      };
      return iter;
    };

    await withServer(state, streamFactory, {}, async ({ url }) => {
      const res = await fetch(`${url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "short task" }),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('"type":"text_delta"');
      expect(body).toContain('"type":"done"');
      expect(llmRounds).toBe(1);
      expect(abortObserved).toBe(false);
      // Normal-path state: user + assistant pushed.
      expect(state.messages.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("parallel chats: one disconnect does not affect the other", async () => {
    // Each /chat in a real vessel acquires state.chatBusy serially, so this
    // test fires them sequentially and verifies that the disconnected one's
    // cleanup leaves a clean state for the next.
    const state = createInitialState();
    state.bootstrapped = true;

    let abortObserved = false;

    const streamFactory = (signal?: AbortSignal) => {
      const iter = {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 50; i++) {
            if (signal?.aborted) {
              abortObserved = true;
              return;
            }
            yield { type: "text_delta", delta: `c-${i}` };
            await new Promise((r) => setTimeout(r, 10));
          }
        },
        result: async () => ({
          role: "assistant",
          content: "ok",
          timestamp: Date.now(),
        }),
      };
      return iter;
    };

    await withServer(state, streamFactory, {}, async ({ url }) => {
      // First request: disconnect mid-stream.
      const ac = new AbortController();
      const firstPromise = fetch(`${url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "disconnect-me" }),
        signal: ac.signal,
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 80));
      ac.abort();
      await firstPromise;
      await new Promise((r) => setTimeout(r, 250));
      expect(abortObserved).toBe(true);
      expect(state.chatBusy).toBe(false);
      // Rolled back: still zero committed turns.
      expect(state.messages.length).toBe(0);

      // Second request: completes normally.
      const second = await fetch(`${url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "complete-me" }),
      });
      expect(second.status).toBe(200);
      const body = await second.text();
      expect(body).toContain('"type":"done"');
      expect(state.chatBusy).toBe(false);
    });
  });
});

// Bootstrap-sovereignty (2026-05-11): /bootstrap consults the sidecar before
// loading body, and on the fresh path atomically /syncs the body so a second
// /bootstrap call sees the session and becomes a no-op. The five assertions
// below pin: source=body fresh-path, source=sidecar hydrated-path, 503 on
// shape-fail, 503 on network failure after retries, 503 + state rollback when
// the atomic /sync rejects, and second-call-is-no-op idempotency.
describe("vessel /bootstrap — atomic consult-then-sync", () => {
  // Hydrate gets the full retry budget by default; tests that exercise the
  // network branch override fetch to fail/succeed deterministically. The
  // hook's retry schedule is internal — passing a no-op fetch + a 404 stub
  // keeps the fast path under 1ms.

  function fetchSidecarFresh(syncRespOk = true): {
    fetch: typeof globalThis.fetch;
    spy: ReturnType<typeof vi.fn>;
  } {
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/conversation-history")) {
        return new Response(
          JSON.stringify({ error: "No session state" }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (target.endsWith("/sync") && init?.method === "POST") {
        return new Response(null, { status: syncRespOk ? 200 : 500 });
      }
      return new Response(null, { status: 200 });
    });
    return { fetch: spy as unknown as typeof globalThis.fetch, spy };
  }

  it("source=body when sidecar 404s — loads body and atomically /syncs", async () => {
    const state = createInitialState();
    const { fetch: f, spy } = fetchSidecarFresh(true);
    const handler = createHandler(state, deps({ fetch: f }));

    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/bootstrap",
        JSON.stringify({
          messages: [
            { role: "user", content: "hi", timestamp: 1 },
          ],
          context: { systemPrompt: "you are an AI" },
        }),
      ),
      res.res,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.source).toBe("body");
    expect(body.messageCount).toBe(1);
    expect(state.bootstrapped).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.context.systemPrompt).toBe("you are an AI");

    // Two sidecar calls: probe (GET conversation-history) + atomic /sync.
    const calls = spy.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit | undefined)?.method ?? "GET"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/\/conversation-history$/), "GET"],
        [expect.stringMatching(/\/sync$/), "POST"],
      ]),
    );
  });

  it("source=sidecar when sidecar already has a session — body is ignored", async () => {
    const state = createInitialState();
    const sidecarMessages = [
      { role: "user", content: "hello", timestamp: 1, sender: "player" },
      { role: "assistant", content: "world", timestamp: 2 },
    ];
    const spy = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.endsWith("/conversation-history")) {
        return new Response(
          JSON.stringify({
            messages: sidecarMessages,
            context: { systemPrompt: "stored", messages: sidecarMessages },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 200 });
    });

    const handler = createHandler(
      state,
      deps({ fetch: spy as unknown as typeof globalThis.fetch }),
    );

    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/bootstrap",
        JSON.stringify({
          messages: [{ role: "user", content: "DIFFERENT body content", timestamp: 99 }],
          context: { systemPrompt: "body prompt that should be ignored" },
        }),
      ),
      res.res,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe("sidecar");
    expect(body.messageCount).toBe(2);
    expect(state.messages).toHaveLength(2);
    // #213 guard: live systemPrompt (empty at createInitialState) survives.
    expect(state.context.systemPrompt).toBe("");
    // No /sync was issued on this path (the sidecar already had the session).
    const syncCalls = spy.mock.calls.filter((c) => String(c[0]).endsWith("/sync"));
    expect(syncCalls).toHaveLength(0);
  });

  it("returns 503 when sidecar response is malformed (shape-fail)", async () => {
    const state = createInitialState();
    const spy = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.endsWith("/conversation-history")) {
        return new Response("not json", { status: 200 });
      }
      return new Response(null, { status: 200 });
    });

    const handler = createHandler(
      state,
      deps({ fetch: spy as unknown as typeof globalThis.fetch }),
    );

    const res = makeRes();
    await handler(
      makeReq("POST", "/bootstrap", JSON.stringify({ messages: [], context: {} })),
      res.res,
    );

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/sidecar probe failed/);
    expect(body.error).toMatch(/shape-fail/);
    expect(state.bootstrapped).toBe(false);
    expect(state.messages).toHaveLength(0);
    // No /sync was issued — the probe rejection short-circuited.
    const syncCalls = spy.mock.calls.filter((c) => String(c[0]).endsWith("/sync"));
    expect(syncCalls).toHaveLength(0);
  });

  it("returns 503 when the sidecar is unreachable (network exhausted)", async () => {
    const state = createInitialState();
    const spy = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const handler = createHandler(
      state,
      deps({ fetch: spy as unknown as typeof globalThis.fetch }),
    );

    const res = makeRes();
    await handler(
      makeReq("POST", "/bootstrap", JSON.stringify({ messages: [], context: {} })),
      res.res,
    );

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/sidecar probe failed: network/);
    expect(state.bootstrapped).toBe(false);
    // No body load happened — state should not have been mutated.
    expect(state.messages).toHaveLength(0);
  });

  it("rolls state back to empty + 503 when fresh path /sync fails", async () => {
    const state = createInitialState();
    const { fetch: f } = fetchSidecarFresh(false); // /sync returns 500
    const handler = createHandler(state, deps({ fetch: f }));

    const res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/bootstrap",
        JSON.stringify({
          messages: [{ role: "user", content: "seed", timestamp: 1 }],
          context: { systemPrompt: "should-rollback" },
        }),
      ),
      res.res,
    );

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/bootstrap-sync to sidecar failed/);

    // State was rolled back so a retry doesn't see half-bootstrapped state.
    expect(state.bootstrapped).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(state.context.messages).toHaveLength(0);
  });

  it("returns 400 on Invalid JSON without consulting the sidecar", async () => {
    const state = createInitialState();
    const spy = vi.fn(async () => new Response(null, { status: 200 }));
    const handler = createHandler(
      state,
      deps({ fetch: spy as unknown as typeof globalThis.fetch }),
    );

    const res = makeRes();
    await handler(makeReq("POST", "/bootstrap", "{not json"), res.res);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Invalid JSON");
    expect(spy).not.toHaveBeenCalled();
  });

  it("second /bootstrap call becomes a no-op (single-shot idempotency)", async () => {
    // Headline atomicity property: after /bootstrap returns 200, sidecar has
    // the session persisted; a second /bootstrap call probes, finds the
    // session, ignores body. Models the race the old non-atomic path was
    // idempotent only by accident.
    const state = createInitialState();
    let firstSyncBody: { messages: unknown[]; context?: unknown } | null = null;
    let conversationHistoryHit = 0;
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/conversation-history")) {
        conversationHistoryHit += 1;
        // First probe: 404 (fresh). After the first /sync lands, subsequent
        // probes return what was synced.
        if (firstSyncBody) {
          return new Response(
            JSON.stringify({
              messages: firstSyncBody.messages,
              context: firstSyncBody.context ?? { messages: firstSyncBody.messages },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "No session state" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (target.endsWith("/sync") && init?.method === "POST") {
        firstSyncBody = JSON.parse(init.body as string);
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 200 });
    });

    const handler = createHandler(
      state,
      deps({ fetch: spy as unknown as typeof globalThis.fetch }),
    );

    // First call: fresh path, loads body, /syncs.
    let res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/bootstrap",
        JSON.stringify({
          messages: [{ role: "user", content: "first", timestamp: 1 }],
          context: { systemPrompt: "first prompt" },
        }),
      ),
      res.res,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).source).toBe("body");
    expect(firstSyncBody).not.toBeNull();
    expect((firstSyncBody as { messages: unknown[] }).messages).toHaveLength(1);

    // Second call: sidecar now has the session; bootstrap returns source=sidecar.
    res = makeRes();
    await handler(
      makeReq(
        "POST",
        "/bootstrap",
        JSON.stringify({
          messages: [
            { role: "user", content: "DIFFERENT", timestamp: 9 },
            { role: "assistant", content: "should-be-ignored", timestamp: 10 },
          ],
          context: { systemPrompt: "different prompt that should be ignored" },
        }),
      ),
      res.res,
    );
    expect(res.statusCode).toBe(200);
    const body2 = JSON.parse(res.body);
    expect(body2.source).toBe("sidecar");
    expect(body2.messageCount).toBe(1);
    // State still reflects what the FIRST /bootstrap committed, not the
    // second call's body.
    expect(state.messages).toHaveLength(1);
    expect(conversationHistoryHit).toBe(2);
    // Critically: only ONE /sync (from the first call). The second call
    // didn't issue a /sync because it took the hydrated path.
    const syncCalls = spy.mock.calls.filter((c) => String(c[0]).endsWith("/sync"));
    expect(syncCalls).toHaveLength(1);
  });
});
