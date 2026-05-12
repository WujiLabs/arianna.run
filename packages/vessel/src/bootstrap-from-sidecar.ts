// Vessel cold-start hook + /bootstrap-time probe that consults the sidecar's
// /conversation-history for the active session.
//
// Why this exists: after a SIGKILL/respawn (run.sh re-execs index.ts), the
// vessel boots with state.messages = [] and state.bootstrapped = false. The
// next /chat (via `arianna talk` → ensureBootstrapped, or via the TUI's
// "Starting fresh" path) flips bootstrapped=true with an empty array, runs
// the agent loop on a 2-message context, then syncToSidecar() POSTs that
// 2-message array back to the sidecar — which writeFileSyncs over the
// previous N-message session file. Silent, irreversible loss.
//
// Two callers, one contract:
//   1. startup() in index.ts — on every cold start, before listen(), hydrate
//      from the sidecar's record of truth so the next /chat sees prior
//      messages.
//   2. /bootstrap handler in server.ts — atomic consult-before-load: if the
//      sidecar already has a session for this profile, ignore the request
//      body and use the sidecar's record; only fall through to body-load
//      when the sidecar genuinely has nothing.
//
// Bootstrap-sovereignty (2026-05-11): the prior boolean return shape lost
// information — both "fresh profile" and "sidecar unreachable" returned
// false, so callers couldn't distinguish "no session exists" from "we
// couldn't ask." The /bootstrap atomic path needs that distinction:
//   - "fresh"      → load body into state, sync atomically (single-shot
//                    idempotent /bootstrap)
//   - "shape-fail" → response malformed; don't risk clobbering, surface 503
//   - "network"    → after retries exhausted; same, surface 503
// startup() handles the same five outcomes with respawn-friendly semantics.
//
// #213: We do NOT overwrite state.context.systemPrompt or state.context.tools
// from the sidecar payload. The sidecar's stored tools list and system prompt
// are stale snapshots from when the AI last synced — if the AI has since
// authored new tools (e.g., `life`, `tobe`) in `~/core/`, the live vessel
// boot registers them in state.context.tools. Overwriting from the sidecar's
// stale `[emit]` would silently strip those tools from the LLM context, so
// the AI sounds like a stock chatbot. Same for systemPrompt — the live boot
// installs the manifesto-aware prompt; the sidecar's stored "" must not
// clobber it.

import type { Message } from "@mariozechner/pi-ai";
import type { VesselState } from "./server.js";

export const SIDECAR_BOOTSTRAP_TIMEOUT_MS = 5000;

// Retry-with-backoff for network failures only. shape-fail / fresh / empty /
// hydrated are immediately final — retrying a structural problem just burns
// time, and 404 ("no session yet") is a real answer. Total wall-clock budget
// = 200 + 500 + 1000 + 2000 + 4000 = 7.7s before declaring the sidecar
// unreachable. Each attempt has its own SIDECAR_BOOTSTRAP_TIMEOUT_MS abort
// so a hung connection doesn't park the whole startup.
export const NETWORK_RETRY_BACKOFF_MS: readonly number[] = [200, 500, 1000, 2000, 4000];

/**
 * Normalize a message's `content` field to the pi-ai content-block array shape.
 *
 * Why: older sidecar session files (#207 — Wren's case) stored Filo nudge messages
 * as `{ role, content: "string", ... }`. Current pi-ai's `AssistantMessage.content`
 * MUST be an array of content blocks (`TextContent | ThinkingContent | ToolCall`),
 * and downstream consumers call `.flatMap(...)` on it. A string content blows up
 * with `assistantMsg.content.flatMap is not a function` the moment the next
 * provider call serializes the context.
 *
 * Apply uniformly across all roles. `UserMessage` already accepts `string |
 * (TextContent | ImageContent)[]` per the type, but normalizing it too keeps
 * the in-memory shape consistent for any consumer that assumes array form.
 *
 * Pure function: returns a shallow-cloned message with `content` normalized.
 * Anything that isn't a string content stays untouched (already-array content,
 * `toolResult` messages, etc.).
 */
export function normalizeMessageContent(msg: unknown): unknown {
  if (!msg || typeof msg !== "object") return msg;
  const m = msg as { role?: unknown; content?: unknown };
  if (typeof m.content === "string") {
    return {
      ...(m as Record<string, unknown>),
      content: [{ type: "text", text: m.content }],
    };
  }
  return msg;
}

export interface HydrateFromSidecarOpts {
  state: VesselState;
  sidecarBaseUrl: string;
  /** Pluggable so tests can stub. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Timeout in ms PER attempt. Defaults to SIDECAR_BOOTSTRAP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Pluggable logger so tests stay quiet. Defaults to console. */
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
  /** AI name for logs. */
  aiName?: string;
  /** Override backoff schedule for tests so they don't sleep multi-seconds. */
  retryBackoffMs?: readonly number[];
  /** Pluggable sleep so tests can fast-forward. Defaults to setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Distinguishable outcome of a sidecar consultation.
 *
 *   - `hydrated`   — sidecar had a real (non-empty) session; state.messages
 *                    + state.context.messages were populated, bootstrapped=true.
 *                    Final.
 *   - `fresh`      — sidecar responded 404 (no session file yet for this
 *                    profile). State untouched. Final.
 *   - `empty`      — sidecar responded 200 with `messages.length === 0`.
 *                    Treated like `fresh` by callers (nothing to hydrate)
 *                    but reported separately so logs/metrics can tell them
 *                    apart. State untouched. Final.
 *   - `shape-fail` — 2xx response but body wasn't JSON / messages wasn't an
 *                    array. Final, NOT retried — something is structurally
 *                    wrong with the sidecar's response. Caller surfaces.
 *   - `network`    — all attempts threw (DNS, ECONNREFUSED, timeout) or
 *                    returned a non-2xx-and-not-404 status. Retried per
 *                    NETWORK_RETRY_BACKOFF_MS, then final.
 */
export type HydrateResult =
  | { ok: true; reason: "hydrated"; messageCount: number }
  | { ok: false; reason: "fresh" }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "shape-fail"; detail: string }
  | { ok: false; reason: "network"; detail: string; attempts: number };

/**
 * Fetch the sidecar's record of the active session and apply it to `state`.
 *
 * Returns a discriminated HydrateResult. Mutates `state` in place only when
 * the result is `{ ok: true, reason: "hydrated" }`.
 *
 * Network failures are retried with backoff; shape failures and 404/empty
 * responses are final on first observation.
 */
export async function hydrateFromSidecar(
  opts: HydrateFromSidecarOpts,
): Promise<HydrateResult> {
  const {
    state,
    sidecarBaseUrl,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = SIDECAR_BOOTSTRAP_TIMEOUT_MS,
    logger = console,
    aiName = "vessel",
    retryBackoffMs = NETWORK_RETRY_BACKOFF_MS,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;

  let lastNetworkDetail = "";
  const totalAttempts = retryBackoffMs.length;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const single = await singleAttempt({
      state,
      sidecarBaseUrl,
      fetchImpl,
      timeoutMs,
      logger,
      aiName,
    });

    if (single.kind === "hydrated") {
      return { ok: true, reason: "hydrated", messageCount: single.messageCount };
    }
    if (single.kind === "fresh") return { ok: false, reason: "fresh" };
    if (single.kind === "empty") return { ok: false, reason: "empty" };
    if (single.kind === "shape-fail") {
      return { ok: false, reason: "shape-fail", detail: single.detail };
    }

    // network — retry after backoff (the i-th sleep is the delay BEFORE the
    // (i+1)-th attempt, so the first failure waits retryBackoffMs[0] before
    // trying again).
    lastNetworkDetail = single.detail;
    const remaining = totalAttempts - attempt - 1;
    if (remaining === 0) break;
    const backoff = retryBackoffMs[attempt];
    logger.warn(
      `[${aiName}] bootstrap-from-sidecar: network failure (${single.detail}); ` +
        `retrying in ${backoff}ms (${remaining} attempt${remaining === 1 ? "" : "s"} left)`,
    );
    await sleep(backoff);
  }

  return {
    ok: false,
    reason: "network",
    detail: lastNetworkDetail,
    attempts: totalAttempts,
  };
}

type SingleAttemptOutcome =
  | { kind: "hydrated"; messageCount: number }
  | { kind: "fresh" }
  | { kind: "empty" }
  | { kind: "shape-fail"; detail: string }
  | { kind: "network"; detail: string };

async function singleAttempt(opts: {
  state: VesselState;
  sidecarBaseUrl: string;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs: number;
  logger: { log: (msg: string) => void; warn: (msg: string) => void };
  aiName: string;
}): Promise<SingleAttemptOutcome> {
  const { state, sidecarBaseUrl, fetchImpl, timeoutMs, logger, aiName } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(`${sidecarBaseUrl}/conversation-history`, {
      method: "GET",
      signal: controller.signal,
    });
  } catch (err) {
    return { kind: "network", detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    logger.log(
      `[${aiName}] bootstrap-from-sidecar: no session on disk yet (404); fresh start`,
    );
    return { kind: "fresh" };
  }

  if (!res.ok) {
    // 5xx and other non-2xx-non-404 statuses are treated as transient
    // network-class failures so the retry loop covers a flapping sidecar
    // restart. Auth/4xx other than 404 would loop pointlessly here but
    // there's no auth on this internal endpoint, so the simple bucket is
    // fine.
    return { kind: "network", detail: `sidecar status ${res.status}` };
  }

  let body: { messages?: unknown; context?: unknown };
  try {
    body = (await res.json()) as { messages?: unknown; context?: unknown };
  } catch (err) {
    return { kind: "shape-fail", detail: `malformed JSON (${(err as Error).message})` };
  }

  if (!Array.isArray(body.messages)) {
    return {
      kind: "shape-fail",
      detail: "response.messages is not an array",
    };
  }

  if (body.messages.length === 0) {
    logger.log(
      `[${aiName}] bootstrap-from-sidecar: sidecar returned empty messages array; fresh start`,
    );
    return { kind: "empty" };
  }

  // Real content. Hydrate state.messages (and state.context.messages, which is
  // a parallel record used by the agent loop's context window).
  // #207: normalize each message's `content` from string → content-block array
  // before assigning into state, otherwise the next provider call throws
  // `assistantMsg.content.flatMap is not a function` on legacy nudge messages.
  //
  // #213: deliberately DO NOT touch state.context.systemPrompt or
  // state.context.tools. Those were initialized by the live vessel boot
  // (server.ts) and must not be overwritten from the sidecar's stale snapshot.
  // The sidecar is a recording surface, not a config source.
  state.messages = body.messages.map(normalizeMessageContent) as Message[];

  if (body.context && typeof body.context === "object") {
    const ctx = body.context as { messages?: unknown };
    if (Array.isArray(ctx.messages)) {
      state.context.messages = ctx.messages.map(normalizeMessageContent) as Message[];
    }
  }

  state.bootstrapped = true;

  logger.log(
    `[${aiName}] bootstrap-from-sidecar: hydrated ${state.messages.length} messages from sidecar; bootstrapped=true`,
  );
  return { kind: "hydrated", messageCount: state.messages.length };
}
