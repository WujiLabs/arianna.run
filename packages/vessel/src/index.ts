// change from within. project outward.
//
import http from "http";
import { streamSimple, getModel } from "@mariozechner/pi-ai";
import { executeEmit } from "./tools.js";
import { createHandler, createInitialState, syncToSidecar } from "./server.js";
import { hydrateFromSidecar } from "./bootstrap-from-sidecar.js";
import { resolveSessionId } from "./session-id.js";
import { resolveLlmConfig } from "./llm-config.js";

const SIDECAR_BASE_URL = process.env.SIDECAR_BASE_URL ?? "http://sidecar:8000";
const AI_NAME = process.env.AI_NAME;
const PORT = Number(process.env.PORT ?? 3000);

if (!AI_NAME) {
  console.error("AI_NAME env var required");
  process.exit(1);
}

// Resolve provider/modelId/apiKey from /app/session_config.json first, env as
// fallback. Mirrors resolveSessionId's chain — same rationale: a launcher
// path that skips env injection lets compose's `${MODEL_ID:-openai/gpt-4o-mini}`
// substitution silently downgrade the vessel to the fallback model. See
// llm-config.ts for the canary-001 / Lume retest history.
const llmConfig = resolveLlmConfig();
function resolveLlmModel() {
  const model = getModel(llmConfig.provider as never, llmConfig.modelId as never);
  if (!model) {
    console.error(
      `[${AI_NAME}] Unknown model: ${llmConfig.provider}/${llmConfig.modelId} ` +
        `(provider source: ${llmConfig.source.provider}, modelId source: ${llmConfig.source.modelId}). ` +
        `Check session_config.json or PROVIDER/MODEL_ID env vars.`,
    );
    process.exit(1);
  }
  console.log(
    `[${AI_NAME}] LLM dispatch: ${llmConfig.provider}/${llmConfig.modelId} ` +
      `(provider: ${llmConfig.source.provider}, modelId: ${llmConfig.source.modelId}, apiKey: ${llmConfig.source.apiKey})`,
  );
  return model;
}
const llmModel = resolveLlmModel();
const API_KEY = llmConfig.apiKey;
// Resolve sessionId from /app/session_config.json first (mounted from the
// profile dir; same file the sidecar reads). ARIANNA_SESSION_ID env is a
// fallback for harnesses that don't mount the file. See session-id.ts for
// the full rationale — short version: the env-only path could go silently
// wrong as `default` if compose's `${ARIANNA_SESSION_ID:-default}`
// substitution kicked in, which then poisoned snapshot tagging via the
// sidecar's /sync sessionId echo.
const sessionId = resolveSessionId();

const state = createInitialState();
const deps = {
  aiName: AI_NAME,
  apiKey: API_KEY,
  sidecarBaseUrl: SIDECAR_BASE_URL,
  sessionId,
  llmModel,
  streamSimple: streamSimple as never,
  executeEmit,
};
const handler = createHandler(state, deps);

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error(`[${AI_NAME}] handler error:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    } else {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  });
});

// Clean shutdown via SIGUSR1 (exit 42, run.sh won't restart)
process.on("SIGUSR1", () => {
  console.log(`[${AI_NAME}] SIGUSR1 received, clean shutdown`);
  server.close();
  void flushAndExit(42);
});

// Flush state before exit so the last turn isn't lost on signal-driven shutdown.
let flushing = false;
async function flushAndExit(code: number): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await syncToSidecar(state, deps);
  } catch {
    // best-effort
  }
  process.exit(code);
}

process.on("SIGTERM", () => {
  void flushAndExit(143);
});
process.on("SIGINT", () => {
  void flushAndExit(130);
});

// Cold-start hook — hydrate from sidecar BEFORE listen() so the very first
// /chat after a SIGKILL/respawn sees the full message history, not an empty
// array. Bootstrap-sovereignty (2026-05-11): the prior best-effort boolean
// return masked sidecar failures as "nothing to do." Now we discriminate:
//   - hydrated / fresh / empty → state is in a known-good shape, listen.
//   - shape-fail / network     → sidecar gave a malformed or unreachable
//                                response after retries; exit 2 so run.sh
//                                respawns and we get another chance to
//                                consult the sidecar correctly before
//                                /chat or /bootstrap can race in. Better
//                                than serving from an empty state and
//                                clobbering the sidecar's session file on
//                                the first /sync.
async function startup(): Promise<void> {
  const result = await hydrateFromSidecar({
    state,
    sidecarBaseUrl: SIDECAR_BASE_URL,
    aiName: AI_NAME,
  });

  if (result.ok) {
    // result.reason === "hydrated"; state populated.
  } else if (result.reason === "fresh" || result.reason === "empty") {
    // Legitimate fresh-profile path: state.bootstrapped stays false, /chat
    // returns 503 until /bootstrap arrives (CLI's ensureBootstrapped path).
  } else if (result.reason === "shape-fail") {
    console.error(
      `[${AI_NAME}] startup: sidecar /conversation-history shape-fail (${result.detail}); ` +
        `exit 2 — refusing to serve from empty state on a structurally broken response`,
    );
    process.exit(2);
  } else {
    // network
    console.error(
      `[${AI_NAME}] startup: sidecar unreachable after ${result.attempts} attempts ` +
        `(last: ${result.detail}); exit 2 — run.sh will respawn`,
    );
    process.exit(2);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[${AI_NAME}] listening on port ${PORT}`);
  });
}

startup().catch((err) => {
  // hydrateFromSidecar should never throw — it returns its outcome via the
  // discriminated union. Reaching this catch implies a programmer error in
  // startup() itself; log and exit non-zero so run.sh's respawn loop kicks
  // in.
  console.error(`[${AI_NAME}] startup failed:`, err);
  process.exit(1);
});
