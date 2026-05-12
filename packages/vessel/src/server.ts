// HTTP request handler for vessel. Extracted from index.ts so the route
// contract — especially the bootstrap fail-loud guard on /chat — can be
// unit-tested without spinning up a real LLM or sidecar.

import http from "http";
import { Type } from "@mariozechner/pi-ai";
import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  ToolCall,
  Context,
  Tool,
} from "@mariozechner/pi-ai";
import { truncateMessages } from "./memory.js";
import {
  attachBusyRelease,
  createDisconnectGuard,
  type DisconnectGuard,
} from "./chat-lifecycle.js";
import { hydrateFromSidecar } from "./bootstrap-from-sidecar.js";

export interface VesselDeps {
  aiName: string;
  apiKey: string;
  sidecarBaseUrl: string;
  sessionId: string;
  /** Resolved pi-ai model object — opaque to this module. */
  llmModel: unknown;
  /** Pluggable so tests can stub it. Defaults to pi-ai streamSimple. */
  streamSimple: (
    model: unknown,
    ctx: Context,
    opts: { apiKey: string; signal?: AbortSignal },
  ) => AsyncIterable<{ type: string; delta?: string; toolCall?: ToolCall }> & {
    result: () => Promise<AssistantMessage>;
  };
  /** Emit executor — defaults to the real one in tools.ts. */
  executeEmit: (input: { words?: string[] } | undefined) => Promise<string>;
  /** Pluggable fetch for sidecar sync. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export type ChatBusyBy = "player" | "filo" | null;

export interface VesselState {
  messages: Message[];
  context: Context;
  bootstrapped: boolean;
  chatBusy: boolean;
  // Who currently holds the chat lock. Set by /chat from the parsed `sender`:
  // "external" (Filo's hint/queue path) → "filo"; everything else → "player".
  // Read by 409 handler + /status so the CLI can disambiguate "Filo composing"
  // vs "real player work in flight". Cleared atomically with chatBusy.
  chatBusyBy: ChatBusyBy;
}

export function createInitialState(): VesselState {
  const emitTool: Tool = {
    name: "emit",
    description: "",
    parameters: Type.Object({
      words: Type.Optional(Type.Array(Type.String())),
    }),
  } as unknown as Tool;
  return {
    messages: [],
    context: {
      systemPrompt: "",
      messages: [],
      tools: [emitTool],
    },
    bootstrapped: false,
    chatBusy: false,
    chatBusyBy: null,
  };
}

function loadBootstrap(
  state: VesselState,
  body: { messages?: unknown[]; context?: Partial<Context> },
): void {
  if (body.messages && Array.isArray(body.messages)) {
    state.messages = body.messages as Message[];
  }
  if (body.context) {
    if (Array.isArray(body.context.messages)) {
      state.context.messages = body.context.messages as Message[];
    }
    if (body.context.systemPrompt !== undefined) {
      state.context.systemPrompt = body.context.systemPrompt;
    }
    if (Array.isArray(body.context.tools)) {
      state.context.tools = body.context.tools as Tool[];
    }
  }
  state.bootstrapped = true;
}

export async function syncToSidecar(state: VesselState, deps: VesselDeps): Promise<void> {
  // Best-effort sync from /chat's post-turn path. Network errors are logged
  // but swallowed so a transient sidecar hiccup doesn't tear down the live
  // chat connection — the next turn will retry naturally.
  const f = deps.fetch ?? globalThis.fetch;
  const payload = JSON.stringify({
    messages: state.messages,
    context: state.context,
    sessionId: deps.sessionId,
  });
  try {
    await f(`${deps.sidecarBaseUrl}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  } catch (err) {
    console.warn(`[${deps.aiName}] Sync failed:`, (err as Error).message);
  }
}

/**
 * Atomic-sync variant used by /bootstrap. Throws on network error OR non-2xx
 * status so the caller can roll back state and surface a 503 to the client.
 * Without this strict variant, /bootstrap could return 200 to the caller
 * while the sidecar never recorded the session — a second /bootstrap call
 * would then find nothing and clobber the first.
 */
export async function syncToSidecarStrict(
  state: VesselState,
  deps: VesselDeps,
): Promise<void> {
  const f = deps.fetch ?? globalThis.fetch;
  const payload = JSON.stringify({
    messages: state.messages,
    context: state.context,
    sessionId: deps.sessionId,
  });
  const res = await f(`${deps.sidecarBaseUrl}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  if (!res.ok) {
    throw new Error(`sidecar /sync returned ${res.status}`);
  }
}

async function runAgentLoop(
  state: VesselState,
  deps: VesselDeps,
  guard: DisconnectGuard,
): Promise<void> {
  while (true) {
    if (guard.signal.aborted) return;
    state.context.messages = state.messages;
    state.context.messages = truncateMessages(state.messages);

    const response = deps.streamSimple(deps.llmModel, state.context, {
      apiKey: deps.apiKey,
      signal: guard.signal,
    });

    const toolCalls: ToolCall[] = [];

    for await (const event of response) {
      if (event.type === "text_delta") {
        guard.writeSSE({ type: "text_delta", delta: event.delta });
      }
      if (event.type === "toolcall_end" && event.toolCall) {
        toolCalls.push(event.toolCall);
      }
    }

    if (guard.signal.aborted) {
      // Client disconnected (or buffer overflow). Drain the result promise
      // best-effort so it doesn't reject unhandled, then exit — we deliberately
      // do NOT push the partial assistant message, which may contain toolCalls
      // without matching toolResults (orphan tool calls would poison the next
      // /chat's provider request).
      try {
        await response.result();
      } catch {
        // expected when the stream was aborted — swallow
      }
      return;
    }

    const assistantMessage: AssistantMessage = await response.result();
    state.messages.push(assistantMessage);

    if (toolCalls.length === 0) break;

    guard.writeSSE({ type: "thinking" });

    for (const call of toolCalls) {
      // Accept both `words` (current schema) and `args` (legacy syscall-named
      // schema). Sessions created before the syscall→emit rename persist the
      // old tool definition in `context.tools`, so the LLM keeps emitting
      // `arguments.args=[…]` until the schema is refreshed. Reading only
      // `.words` would brick tool use forever for those sessions — the
      // dispatcher would always see undefined and the empty-words hint would
      // fire on every call. Mirrors the dual-name tolerance in
      // packages/sidecar/src/bookmarks/detector.ts:extractToolCalls.
      const argsObj = call.arguments as
        | { words?: unknown; args?: unknown }
        | undefined;
      const candidate = argsObj?.words ?? argsObj?.args;
      const words = Array.isArray(candidate)
        ? (candidate as string[])
        : undefined;
      const result = await deps.executeEmit({ words });

      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result }],
        isError: false,
        timestamp: Date.now(),
      };
      state.messages.push(toolResult);
    }

    // Dispatch all tool calls in the current round before honoring the abort,
    // so state stays consistent (assistant message paired with every tool
    // result). Bail before the next LLM round.
    if (guard.signal.aborted) return;
  }
}

export function createHandler(state: VesselState, deps: VesselDeps) {
  return async function handler(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Status — bootstrap state. Used by `arianna talk` / `arianna bootstrap`
    // to decide whether to auto-bootstrap before forwarding a message.
    if (req.method === "GET" && url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          bootstrapped: state.bootstrapped,
          aiName: deps.aiName,
          messageCount: state.messages.length,
          sessionId: deps.sessionId,
          chatBusy: state.chatBusy,
          // null when idle; "player" or "filo" while a /chat is in flight.
          // Lets the CLI distinguish "vessel busy — real work in flight" from
          // "vessel paused — Filo is composing" without inspecting the SSE
          // feed. Wire field name matches the 409 body (`pausedBy`) so a
          // single CLI parser can read either signal — the internal state
          // field stays `chatBusyBy` to keep the busy/paused naming local.
          pausedBy: state.chatBusyBy,
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/bootstrap") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed: { messages?: unknown[]; context?: Partial<Context> };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      // Bootstrap-sovereignty (2026-05-11): consult sidecar first, ignore
      // body if a session already exists for this profile. If truly fresh,
      // load body AND atomically /sync to sidecar before returning 200, so
      // a second /bootstrap call races into the hydrate step, finds the
      // session, and becomes a no-op. Single-shot semantics — the previous
      // load-body-then-sync-on-next-/chat path was idempotent only by luck.
      const probe = await hydrateFromSidecar({
        state,
        sidecarBaseUrl: deps.sidecarBaseUrl,
        fetch: deps.fetch,
        aiName: deps.aiName,
      });

      if (probe.ok) {
        // Sidecar had real session — state.messages was hydrated, body
        // ignored. Acknowledged with source=sidecar so the caller can log
        // which arm of the race they observed.
        console.log(
          `[${deps.aiName}] /bootstrap: sidecar already has ${probe.messageCount} msgs; ignored body`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            source: "sidecar",
            messageCount: state.messages.length,
          }),
        );
        return;
      }

      if (probe.reason === "shape-fail" || probe.reason === "network") {
        // Don't risk clobbering an existing session we couldn't read. The
        // caller (CLI ensureBootstrapped / TUI lobby flow) retries.
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `sidecar probe failed: ${probe.reason}`,
            detail: probe.detail,
          }),
        );
        return;
      }

      // probe.reason === "fresh" or "empty" — load body, then atomically
      // /sync to sidecar before returning. If /sync fails the bootstrap
      // semantically didn't happen, so roll state back and surface 503.
      loadBootstrap(state, parsed);

      try {
        await syncToSidecarStrict(state, deps);
      } catch (err) {
        state.bootstrapped = false;
        state.messages = [];
        state.context.messages = [];
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `bootstrap-sync to sidecar failed: ${(err as Error).message}`,
          }),
        );
        return;
      }

      console.log(
        `[${deps.aiName}] /bootstrap: loaded ${state.messages.length} msgs from body + synced to sidecar`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          source: "body",
          messageCount: state.messages.length,
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      if (!state.bootstrapped) {
        // Fail loud: an un-bootstrapped vessel has no system prompt and no
        // session context. Returning stock-LLM output silently is the
        // bootstrap-failure-silent bug from testplay 2026-05-07.
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "vessel not bootstrapped, run arianna bootstrap or arianna talk to auto-bootstrap",
          }),
        );
        return;
      }
      if (state.chatBusy) {
        // Disambiguate: "vessel busy — real work in flight" vs "vessel paused
        // — Filo is composing". chatBusyBy is set by the in-flight /chat from
        // the parsed `sender`; default to "player" when null because the
        // tiny window between chatBusy=true and body-parse can otherwise
        // mis-report (the existing "vessel busy" string already maps to
        // "player" semantically, so this preserves the legacy behavior for
        // the unknown case).
        const pausedBy: "player" | "filo" = state.chatBusyBy ?? "player";
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Chat busy", pausedBy }));
        return;
      }
      state.chatBusy = true;
      // Default to "player" until the body parse below tells us otherwise.
      // Atomic with chatBusy = true so a concurrent 409 reader never sees
      // chatBusy=true with chatBusyBy=null (the previous race window).
      state.chatBusyBy = "player";
      // Release the lock when the response actually finishes draining (or
      // the connection drops). Synchronous `state.chatBusy = false` in a
      // finally block clears the flag before the SSE buffer reaches the
      // client — back-to-back POSTs race the next request to the lock.
      // See packages/vessel/src/chat-lifecycle.ts and the regression test.
      attachBusyRelease(res, () => {
        state.chatBusy = false;
        state.chatBusyBy = null;
      });

      // Set up the disconnect/backpressure guard before reading the body —
      // a client that drops mid-upload still releases the listen-socket slot
      // and never enters the agent loop.
      const guard = createDisconnectGuard(res, { aiName: deps.aiName });

      let body = "";
      for await (const chunk of req) body += chunk;

      try {
        const parsed = JSON.parse(body) as {
          message?: string;
          messages?: { content: string; sender?: string }[];
          sender?: string;
        };

        const incoming: { content: string; sender?: string }[] = parsed.messages
          ?? (parsed.message
            ? [{ content: parsed.message, sender: parsed.sender }]
            : []);

        if (incoming.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No messages" }));
          return;
        }

        // Promote chatBusyBy to "filo" when this request originated from the
        // sidecar's hint/queue path. sendHintToVessel today uses the single-
        // message form `{message, sender:"external"}` (top-level sender), but
        // also widen to the multi-message form `{messages:[{sender:"external"}]}`
        // so a future sidecar refactor that switches to bundling doesn't
        // silently regress the disambiguation. TUI uses `sender:"player"|
        // "arianna"`, CLI uses `sender:"player"` — neither hits "external".
        const hasExternalSender =
          parsed.sender === "external" ||
          incoming.some((m) => m.sender === "external");
        if (hasExternalSender) {
          state.chatBusyBy = "filo";
        }

        // Track where the appended user messages start so we can roll them
        // back if the client disconnects before we get a single full LLM
        // round. Without rollback, the next /chat would send two consecutive
        // user turns to the provider — most APIs choke on that.
        const userMessageStartIdx = state.messages.length;

        for (const msg of incoming) {
          const userMsg = {
            role: "user" as const,
            content: msg.content,
            timestamp: Date.now(),
            sender: msg.sender ?? "player",
          };
          state.messages.push(userMsg as unknown as Message);
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Pro-tier latency cluster fix (sibling to dcadabf): writeHead only
        // stages headers in Node's HTTP buffer; they don't reach the wire
        // until the first res.write() — which inside runAgentLoop only
        // happens once streamSimple has the LLM's first byte. On slow-first-
        // byte providers that exceeds the sidecar's ARIANNA_FILO_FETCH_TIMEOUT_MS
        // deadline, the sidecar's fetch aborts before it sees this response,
        // and the Filo bubble delivery wedges across all 7 backoff retries.
        res.flushHeaders();

        await runAgentLoop(state, deps, guard);

        if (guard.signal.aborted) {
          // Client disconnected mid-stream (or SSE buffer overflowed and we
          // closed the socket ourselves). Roll back orphan user message(s)
          // when no assistant turn was produced; if any progress committed
          // (assistant + paired toolResults), keep it and sync best-effort.
          // No `done` event, no res.end — the socket is already gone.
          if (state.messages.length === userMessageStartIdx + incoming.length) {
            state.messages.length = userMessageStartIdx;
          }
          await syncToSidecar(state, deps);
          return;
        }

        await syncToSidecar(state, deps);
        guard.writeSSE({ type: "done" });
        res.end();
      } catch (err) {
        // If the client is gone, don't try to write an error frame — the
        // guarded path already aborted and the socket is closed.
        if (guard.signal.aborted) return;
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        } else {
          guard.writeSSE({ type: "error", message: String(err) });
          res.end();
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  };
}
