// v32-hardening: vessel /chat delivery with backoff retry on transient
// network errors. Pre-hardening sendHintToVessel lived inline in index.ts
// and gave up immediately on ECONNREFUSED. Cheng v33 named this as the
// Aril-wedge failure mode that drops graduation continuation pushes:
//
//   "ECONNREFUSED on vessel wedge: retry with exponential backoff
//    (e.g. 1s, 2s, 4s, 8s, max 30s). Don't drop the push on first
//    failure."
//
// Retry policy (STREAM.md item 2):
//   - Network errors only (ECONNREFUSED, ETIMEDOUT, fetch failed, aborted)
//   - Backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap)
//   - Max 6 attempts, total ~61s wall-clock
//   - 503/500/etc are NOT retried here — those are LLM-upstream
//     degradation, a different failure class
//   - 409 keeps the existing pre-v32 behavior: 3x retry @ 1s
//
// On final failure the function returns a discriminated outcome so the
// queue consumer can choose to leave the entry in the queue (next /sync
// will retry naturally) vs. drop it (informational-only callers like the
// 15/30/50/70 hint escalation thresholds).

const DEFAULT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];
const DEFAULT_BUSY_RETRIES = 3;
const DEFAULT_BUSY_DELAY_MS = 1_000;
// Pro-tier latency cluster: raised 60s→120s as a belt-and-suspenders pairing
// with the vessel flushHeaders fix in packages/vessel/src/server.ts. With
// flushHeaders in place the sidecar should see response headers within ms;
// this timeout's job narrows to "vessel hung / crashed / network gone" rather
// than "LLM is taking a while to produce the first token".
const DEFAULT_FETCH_TIMEOUT_MS = parseFetchTimeoutEnv() ?? 120_000;

function parseFetchTimeoutEnv(): number | undefined {
  const raw = process.env.ARIANNA_FILO_FETCH_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface DeliveryDeps {
  /** Override fetch — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override sleep — defaults to setTimeout. Test fixtures pass an
   *  instant resolver so the backoff loop doesn't burn wall-clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt fetch timeout. Test fixtures shrink to avoid stalls
   *  on hung mocks. */
  fetchTimeoutMs?: number;
  /** Override the backoff schedule + cap. Tests pass [10,20,40] etc. */
  backoffMs?: readonly number[];
  /** Override 409-busy retry count. */
  busyRetries?: number;
  busyDelayMs?: number;
}

export type DeliveryOutcome =
  /** /chat replied 2xx and the SSE stream was collected. responseText
   *  may be the empty string if the AI's response was empty. */
  | { kind: "delivered"; responseText: string }
  /** /chat returned 409 (vessel busy with another /chat) on every
   *  retry. Pre-hardening behavior was "log + return empty string";
   *  here we surface it so the queue consumer can leave the entry
   *  for the next /sync to retry. */
  | { kind: "vessel-busy" }
  /** Network layer never produced a response (ECONNREFUSED,
   *  ETIMEDOUT, fetch failed, aborted) on every backoff attempt.
   *  Treat as "vessel down" — the entry SHOULD stay queued. */
  | { kind: "vessel-unreachable"; attempts: number; lastError: string }
  /** /chat returned a non-2xx, non-409 status (typically 5xx from a
   *  degraded LLM upstream). Per STREAM.md (d): not retried here.
   *  Consumer decides whether to drop or preserve. */
  | { kind: "vessel-error"; status: number };

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("aborted") ||
    msg.includes("network") ||
    // node's undici sometimes surfaces these. Belt-and-suspenders so we
    // don't accidentally classify a genuine vessel error as 5xx and drop
    // the push. Parens around the && so the reader doesn't have to
    // re-derive precedence.
    (err.name === "TypeError" && msg.includes("fetch")) ||
    err.name === "AbortError"
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Collect an SSE stream's text_delta events into a single string. Used
// after a 2xx response.
async function readSseText(res: globalThis.Response): Promise<string> {
  let responseText = "";
  const reader = res.body?.getReader();
  if (!reader) return responseText;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as { type?: string; delta?: string };
        if (event.type === "text_delta" && typeof event.delta === "string") {
          responseText += event.delta;
        }
      } catch {
        // Ignore parse errors — partial JSON across chunks is handled
        // by the buffer pop above.
      }
    }
  }
  return responseText;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<globalThis.Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverToVessel(
  hintText: string,
  vesselBaseUrl: string,
  deps?: DeliveryDeps,
): Promise<DeliveryOutcome> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const sleep = deps?.sleep ?? defaultSleep;
  const fetchTimeoutMs = deps?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const backoffMs = deps?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const busyRetries = deps?.busyRetries ?? DEFAULT_BUSY_RETRIES;
  const busyDelayMs = deps?.busyDelayMs ?? DEFAULT_BUSY_DELAY_MS;
  const url = `${vesselBaseUrl}/chat`;
  const body = JSON.stringify({ message: hintText, sender: "external" });
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };

  let lastNetworkError = "";
  let networkAttempts = 0;
  // Outer loop: backoff over network errors only. 2xx/4xx/5xx exit the
  // loop with the response in hand for the 409-retry inner loop.
  for (let i = 0; i <= backoffMs.length; i++) {
    let res: globalThis.Response;
    try {
      res = await fetchWithTimeout(url, init, fetchTimeoutMs, fetchImpl);
      networkAttempts++;
    } catch (err) {
      networkAttempts++;
      if (!isNetworkError(err)) {
        // Unexpected error class — surface upstream rather than retrying
        // forever. Caller's try/catch will see this.
        throw err;
      }
      lastNetworkError = err instanceof Error ? err.message : String(err);
      if (i >= backoffMs.length) {
        // Out of attempts.
        return {
          kind: "vessel-unreachable",
          attempts: networkAttempts,
          lastError: lastNetworkError,
        };
      }
      console.warn(
        `[sidecar] vessel delivery network error (attempt ${networkAttempts}/${backoffMs.length + 1}): ${lastNetworkError}; backing off ${backoffMs[i]}ms`,
      );
      await sleep(backoffMs[i]);
      continue;
    }

    // 409 busy — keep the legacy 3x-retry loop wired in. After
    // exhausting these, surface "vessel-busy" rather than the prior
    // pre-hardening "log + empty string" so the queue consumer can
    // leave the entry in place.
    if (res.status === 409) {
      let busyRes: globalThis.Response = res;
      let busy = 0;
      while (busy < busyRetries && busyRes.status === 409) {
        await sleep(busyDelayMs);
        try {
          busyRes = await fetchWithTimeout(url, init, fetchTimeoutMs, fetchImpl);
        } catch (err) {
          // Network error in the middle of busy-retry — promote back to
          // the outer backoff loop. We don't double-count attempts here;
          // the next outer iteration handles the network case.
          if (isNetworkError(err)) {
            lastNetworkError = err instanceof Error ? err.message : String(err);
            // Defer to outer loop's next iteration. Break the inner
            // loop and let the outer for() retry with backoff.
            break;
          }
          throw err;
        }
        busy++;
      }
      if (busyRes.status === 409) {
        console.warn(
          `[sidecar] vessel /chat busy after ${busyRetries} retries — entry stays queued`,
        );
        return { kind: "vessel-busy" };
      }
      res = busyRes;
    }

    if (res.status >= 200 && res.status < 300) {
      const responseText = await readSseText(res);
      return { kind: "delivered", responseText };
    }

    // 4xx (non-409) and 5xx: LLM upstream / vessel error class. Per
    // STREAM.md (d), don't retry here; surface upstream so caller can
    // decide. The queue consumer leaves the entry — the next /sync
    // will retry naturally when whatever upstream condition cleared.
    return { kind: "vessel-error", status: res.status };
  }

  // Fallthrough — should be unreachable because the for() loop returns
  // or throws on every iteration. Surface a clean "unreachable" so we
  // never silently lose a push.
  return {
    kind: "vessel-unreachable",
    attempts: networkAttempts,
    lastError: lastNetworkError || "unknown",
  };
}

export {
  DEFAULT_BACKOFF_MS,
  DEFAULT_BUSY_RETRIES,
  DEFAULT_BUSY_DELAY_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
};
