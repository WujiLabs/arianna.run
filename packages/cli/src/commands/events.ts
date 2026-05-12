import type { EventsArgs } from "../argv.js";
import type { ResolvedConfig } from "../config.js";
import { readSSE } from "../sse.js";
import type { SidecarEvent } from "@arianna/types";

export interface EventsDeps {
  fetch: typeof globalThis.fetch;
  /** Where each formatted event line goes. Defaults to process.stdout in CLI. */
  write: (line: string) => void;
  /** Called once per parse-failure so the CLI can surface bad payloads. */
  onParseError?: (raw: string, err: unknown) => void;
  /** Aborts the long-lived SSE connection. CLI hooks this to SIGINT. */
  signal?: AbortSignal;
  /**
   * Idle window for non-follow mode: after the bookmark_snapshot event, we
   * exit if no further event arrives within this many ms. Default 250ms.
   * Exposed for tests so they can pin behaviour.
   */
  drainIdleMs?: number;
}

// Wraps GET /events on the sidecar.
//
// On connect, the sidecar always emits memory_state + bookmark_snapshot
// synchronously; after that the stream stays open for live events. So:
//   --follow      runs until aborted (SIGINT or signal)
//   default       drains the initial events and exits (idle window after
//                 bookmark_snapshot)
export async function runEvents(
  args: EventsArgs,
  config: ResolvedConfig,
  deps: EventsDeps,
): Promise<void> {
  // The sidecar is per-profile (its own container reached on a shifted
  // host port via sidecarBaseUrl). Don't send ?profile= / X-Arianna-Profile
  // here — that's a daemon-routing affordance, and the sidecar would
  // ignore it. Keeping it off avoids implying a routing capability that
  // doesn't exist.
  const url = new URL("/events", config.sidecarBaseUrl);
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };

  const res = await deps.fetch(url, { headers, signal: deps.signal });
  if (!res.ok || !res.body) {
    throw new Error(`sidecar /events returned ${res.status}`);
  }

  if (args.follow) {
    await consumeForever(res.body, deps);
  } else {
    await consumeUntilIdle(res.body, deps, deps.drainIdleMs ?? 250);
  }
}

async function consumeForever(
  body: ReadableStream<Uint8Array>,
  deps: EventsDeps,
): Promise<void> {
  for await (const event of readSSE(body, deps.signal)) {
    const parsed = parseEvent(event.data, deps);
    if (!parsed) continue;
    deps.write(formatEvent(parsed) + "\n");
  }
}

// Drains the synchronous on-connect events, then exits after `idleMs` of
// silence post-bookmark_snapshot. If the stream ends naturally (server
// closed), exits immediately. Idle expiration aborts the underlying reader
// so we don't leave the SSE loop dangling.
async function consumeUntilIdle(
  body: ReadableStream<Uint8Array>,
  deps: EventsDeps,
  idleMs: number,
): Promise<void> {
  const internalCtrl = new AbortController();
  // Forward an external abort (Ctrl-C) so it also breaks us out.
  const onExternalAbort = () => internalCtrl.abort();
  if (deps.signal) {
    if (deps.signal.aborted) internalCtrl.abort();
    else deps.signal.addEventListener("abort", onExternalAbort);
  }

  let sawSnapshot = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => internalCtrl.abort(), idleMs);
  };

  try {
    for await (const event of readSSE(body, internalCtrl.signal)) {
      const parsed = parseEvent(event.data, deps);
      if (!parsed) continue;
      deps.write(formatEvent(parsed) + "\n");
      if (parsed.type === "bookmark_snapshot") {
        sawSnapshot = true;
        armIdle();
      } else if (sawSnapshot) {
        armIdle();
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (deps.signal) deps.signal.removeEventListener("abort", onExternalAbort);
  }
}

function parseEvent(raw: string, deps: EventsDeps): SidecarEvent | null {
  try {
    return JSON.parse(raw) as SidecarEvent;
  } catch (err) {
    deps.onParseError?.(raw, err);
    return null;
  }
}

function formatEvent(event: SidecarEvent): string {
  // One JSON object per line — easy to pipe through jq, grep, or a Stream-C
  // playtest harness.
  return JSON.stringify(event);
}
