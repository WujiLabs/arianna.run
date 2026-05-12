import type { TalkArgs } from "../argv.js";
import type { ResolvedConfig } from "../config.js";
import { readSSE } from "../sse.js";
import { ensureBootstrapped } from "../bootstrap.js";
import type { PathOpts } from "../paths.js";

export interface TalkResult {
  /** Concatenated assistant text (post-stream). Empty on tool-only turns. */
  responseText: string;
  /** Transport-level status. 409 means vessel busy; otherwise 200 if streamed. */
  status: number;
  /**
   * Disambiguates the 409 cause when the vessel exposes it in the response
   * body: "filo" means Filo is composing a queued external_message and the
   * caller should wait for `interaction_resumed` rather than retry; "player"
   * is the legacy "real work in flight" case. Undefined when the field is
   * absent (older vessel) or status !== 409.
   */
  pausedBy?: "player" | "filo";
  /**
   * v25 driver-silence-during-test: set when the pre-flight check refused
   * the talk because the AI is mid-graduation-test. The dispatcher in
   * index.ts maps this to a distinct exit message ("graduation test in
   * flight; AI must complete or invoke /abort-test from her own tools, or
   * operator can run `arianna abort-test <profile>` for sandbox-locked
   * vessels"). Status 0 in this case (no HTTP attempt was made).
   */
  graduationLocked?: { sessionId: string; attemptCount?: number };
}

export interface TalkDeps {
  fetch: typeof globalThis.fetch;
  /** Where streamed text deltas go. Defaults to process.stdout in CLI. */
  write: (chunk: string) => void;
  /** Where one-line status messages (auto-bootstrap output) go. Default: stderr-equivalent. */
  warn?: (line: string) => void;
  /** Path overrides for tests. Threaded through to the auto-bootstrap step. */
  pathOpts?: PathOpts;
}

// Wraps POST /chat. Single-message form — the multi-message bundling that the
// TUI uses (bookmark dividers + player message in one payload) is a TUI
// affordance, not something an external CLI caller needs by default.
export async function runTalk(
  args: TalkArgs,
  config: ResolvedConfig,
  deps: TalkDeps,
): Promise<TalkResult> {
  // Auto-bootstrap: an un-bootstrapped vessel now 503s on /chat. Make the
  // headless flow "just work" by GET'ing /status and POSTing /bootstrap
  // ourselves before forwarding. This is the talk-side counterpart to
  // `arianna bootstrap` (E2 from the bootstrap-import task). A second talk
  // racing in parallel would re-call /bootstrap, which is a safe overwrite
  // (vessel just reloads the same imported messages).
  const result = await ensureBootstrapped(config, {
    fetch: deps.fetch,
    pathOpts: deps.pathOpts,
  });
  if (result.bootstrapped && deps.warn) {
    deps.warn(
      `auto-bootstrap: ${result.importedMessageCount} imported messages\n`,
    );
  }

  // v25 driver-silence-during-test: pre-flight lockout check. When the
  // graduation test is in flight, the host MUST refuse to deliver a
  // sender:"player" message (Cheng v30-reply spec). Skip for sender !==
  // "player" so internal callers (e.g. test harness inserting external
  // messages, future automation) aren't blocked. Probe the sidecar's
  // /admin/lockout-status endpoint — failure to reach it (older sidecar
  // without the endpoint, transient network) falls through to the legacy
  // direct-post behavior so the new gate doesn't break preexisting
  // workflows. Defense-in-depth, not the only line.
  if (args.sender === "player" || args.sender === undefined) {
    try {
      const probeUrl = new URL("/admin/lockout-status", config.sidecarBaseUrl);
      const probeRes = await deps.fetch(probeUrl, { method: "GET" });
      if (probeRes.ok) {
        const probe = (await probeRes.json()) as {
          locked?: boolean;
          sessionId?: string;
          attemptCount?: number;
        };
        if (probe.locked === true) {
          return {
            responseText: "",
            status: 0,
            graduationLocked: {
              sessionId: probe.sessionId ?? "",
              attemptCount: probe.attemptCount,
            },
          };
        }
      }
      // Non-OK (404 on older sidecars, etc.) → fall through. Logging this
      // would be noisy on a typical multi-talk loop; rely on the operator
      // to run `arianna events --follow` if the gate seems to be silent.
    } catch {
      // Network/parse failure → fall through. Same rationale as non-OK.
    }
  }

  // The vessel doesn't route by profile — it's a per-profile container
  // reached via its own host port (vesselBaseUrl already encodes the
  // profile via port_offset). Don't send `?profile=` or
  // `X-Arianna-Profile` here; that's a daemon affordance, not a vessel
  // affordance, and including it would be misleading mental model.
  const url = new URL("/chat", config.vesselBaseUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  const res = await deps.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: args.message,
      sender: args.sender,
    }),
  });

  if (res.status === 409) {
    // Best-effort decode of the new pausedBy disambiguator. Old vessels emit
    // a raw "busy" string or `{error:"Chat busy"}` without the field — both
    // fall through with pausedBy:undefined, and the caller defaults to the
    // legacy "vessel busy — try again" message.
    let pausedBy: "player" | "filo" | undefined;
    try {
      const text = await res.text();
      if (text) {
        const parsed = JSON.parse(text) as { pausedBy?: unknown };
        if (parsed.pausedBy === "filo" || parsed.pausedBy === "player") {
          pausedBy = parsed.pausedBy;
        }
      }
    } catch {
      // not JSON or not readable — leave pausedBy undefined
    }
    return { responseText: "", status: 409, pausedBy };
  }

  if (!res.ok || !res.body) {
    throw new Error(`vessel /chat returned ${res.status}`);
  }

  let responseText = "";
  for await (const event of readSSE(res.body)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      continue;
    }
    const evt = parsed as { type?: string; delta?: string; message?: string };
    if (evt.type === "text_delta" && typeof evt.delta === "string") {
      responseText += evt.delta;
      deps.write(evt.delta);
    } else if (evt.type === "error" && typeof evt.message === "string") {
      throw new Error(`vessel error: ${evt.message}`);
    } else if (evt.type === "done") {
      break;
    }
  }

  return { responseText, status: res.status };
}
