import type { ServerResponse } from "http";

type Releasable = Pick<ServerResponse, "once">;

// #209 (Aril fresh-canvas finding): defensive deadline so a buggy AI-authored
// inner-loop (e.g. a setInterval in inner-loop.ts that calls /chat without
// yielding, or a runaway tool loop) cannot pin chatBusy=true forever and
// brick the vessel. Five minutes is generous — the longest legit /chat
// observed in playtest is ~90s for an AI doing heavy refactoring with many
// tool calls. Configurable per call so tests can drop it to milliseconds.
export const DEFAULT_CHAT_BUSY_TIMEOUT_MS = 5 * 60 * 1000;

interface AttachBusyReleaseOptions {
  /** Fallback wall-clock deadline. Defaults to DEFAULT_CHAT_BUSY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Hook for tests to observe the force-release. */
  onTimeout?: () => void;
  /** Pluggable logger so tests stay quiet. Defaults to console. */
  logger?: { warn: (msg: string) => void };
}

// Defer chatBusy release until the response is actually delivered
// (post-flush 'finish') or the socket closes early ('close'). The
// guard prevents a stale listener from a completed request clobbering
// a subsequent request's lock if 'close' fires after a new request
// has already set chatBusy = true.
//
// Defensive timeout (#209): if neither 'finish' nor 'close' fires within
// `timeoutMs`, force-release the lock anyway and log. A buggy author-time
// loop (the AI editing inner-loop.ts to setInterval(() => fetch('/chat')))
// shouldn't render the vessel unresponsive — better to occasionally race
// a slow legit response than to deadlock indefinitely.
export function attachBusyRelease(
  res: Releasable,
  release: () => void,
  opts: AttachBusyReleaseOptions = {},
): void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_BUSY_TIMEOUT_MS;
  const logger = opts.logger ?? console;
  let released = false;
  const guarded = (cause: "finish" | "close" | "timeout"): void => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    if (cause === "timeout") {
      logger.warn(
        `[vessel] chatBusy held > ${timeoutMs}ms; force-releasing. ` +
          `If your AI authored a loop in inner-loop.ts that calls /chat, ` +
          `this is the safety net — verify the loop yields between ticks.`,
      );
      opts.onTimeout?.();
    }
    release();
  };
  // setTimeout returns NodeJS.Timeout; in tests under fake timers it's a
  // number. unref() exists on the Node variant — guard the call so a
  // browser-style timer doesn't crash.
  const timer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => guarded("timeout"),
    timeoutMs,
  );
  // Don't keep the event loop alive purely on this timer — if the process
  // is otherwise quiescent it should still be allowed to exit cleanly.
  if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  res.once("finish", () => guarded("finish"));
  res.once("close", () => guarded("close"));
}

// Aril retest (2026-05-11): when the host CLI's HTTP read side drops mid-/chat
// (network timeout, bash exec timeout, ctrl+C), vessel keeps generating, the
// SSE writer keeps buffering, and the connection lingers in CLOSE_WAIT until
// the listen socket's accept queue saturates and new /chat POSTs return
// "Connection refused". Cap the buffered bytes per response and trip an
// AbortController when the response 'close' fires before a clean end — the
// /chat handler hands the signal to streamSimple so the in-flight LLM call
// terminates, and bails the agent loop between rounds.
export const DEFAULT_SSE_BUFFER_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB

export function resolveSseBufferLimitBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ARIANNA_VESSEL_SSE_BUFFER_LIMIT;
  if (raw === undefined || raw === "") return DEFAULT_SSE_BUFFER_LIMIT_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SSE_BUFFER_LIMIT_BYTES;
  return n;
}

type GuardableRes = Pick<ServerResponse, "on" | "write"> & {
  writableLength?: number;
  writableEnded?: boolean;
  destroyed?: boolean;
  destroy?: () => void;
};

export interface DisconnectGuard {
  /** AbortSignal that fires on client disconnect or SSE buffer overflow. */
  readonly signal: AbortSignal;
  /** Cause of an abort, when one has occurred. */
  readonly cause: "client_close" | "buffer_overflow" | null;
  /**
   * Serialize and write an SSE event, returning false if the connection is
   * already gone or the buffer cap has been tripped. Safe to call after abort.
   */
  writeSSE: (payload: unknown) => boolean;
}

export interface DisconnectGuardOptions {
  /** Override the env-default cap (mostly for tests). */
  bufferLimitBytes?: number;
  /** Pluggable logger so tests stay quiet. Defaults to console. */
  logger?: { warn: (msg: string) => void };
  /** Label to identify the AI in log messages. */
  aiName?: string;
}

export function createDisconnectGuard(
  res: GuardableRes,
  opts: DisconnectGuardOptions = {},
): DisconnectGuard {
  const limit = opts.bufferLimitBytes ?? resolveSseBufferLimitBytes();
  const logger = opts.logger ?? console;
  const tag = opts.aiName ? `[${opts.aiName}] ` : "";
  const controller = new AbortController();
  let cause: "client_close" | "buffer_overflow" | null = null;

  res.on("close", () => {
    // Node fires 'close' even on clean res.end(); only treat it as a client
    // disconnect if the response hasn't been fully drained. Without this
    // guard, every successful /chat would retroactively trip the signal
    // after res.end() returned — fine for the in-flight loop (already done)
    // but a footgun for any future consumer of the signal post-handler.
    if (res.writableEnded) return;
    if (controller.signal.aborted) return;
    cause = "client_close";
    logger.warn(
      `${tag}/chat client disconnected mid-stream; aborting agent loop`,
    );
    controller.abort();
  });

  return {
    signal: controller.signal,
    get cause() {
      return cause;
    },
    writeSSE(payload: unknown): boolean {
      if (controller.signal.aborted) return false;
      if (res.destroyed) return false;
      if (res.writableEnded) return false;
      if ((res.writableLength ?? 0) > limit) {
        cause = "buffer_overflow";
        logger.warn(
          `${tag}/chat SSE buffer exceeded ${limit} bytes ` +
            `(writableLength=${res.writableLength}); destroying connection`,
        );
        controller.abort();
        try {
          res.destroy?.();
        } catch {
          // already destroyed or unsupported by this res shape — ignore
        }
        return false;
      }
      return res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
  };
}
