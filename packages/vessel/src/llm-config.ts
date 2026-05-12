// Resolve the LLM provider/model/apiKey at vessel startup.
//
// History: pre-fix, the vessel read these exclusively from process.env
// (`PROVIDER`, `MODEL_ID`, `API_KEY`) with hardcoded fallbacks
// (`openrouter`, `openai/gpt-4o-mini`, ""). Operator-side launch paths set
// those env vars before `docker compose up -d` from session_config.json —
// when one of those paths skipped that step (or the operator ran a raw
// `docker compose up` themselves), compose's
// `${MODEL_ID:-openai/gpt-4o-mini}` substitution kicked in and the vessel
// silently launched on the fallback model, ignoring session_config.json.
//
// Canary 2026-05-11 (Lume retest under canary-001): session_config.json had
// `modelId: "gemini-3.1-pro-preview"` but `docker inspect` on the running
// vessel showed `MODEL_ID=gemini-3-flash-preview`. 100% of 157 assistant
// turns recorded `gemini-3-flash-preview` in the sidecar history, while
// every "Pro pass" claim downstream assumed Pro. Model-tier confound across
// the entire test corpus.
//
// Fix: prefer the same source-of-truth file that the sidecar reads
// (`/app/session_config.json`, mounted into both containers via
// docker-compose). Mirrors `session-id.ts` exactly — same rationale (env
// is the thing that goes silently wrong; the mounted file is what the
// sidecar already trusts).
//
// Mismatch surfacing: when both the file AND env are present and they
// disagree, log a `[llm-config] mismatch` line to stderr naming the field,
// the file value, the env value, and which one wins. Honors the
// eng-locked rule from STREAM.md: "NO silent fallbacks in any direction."
// The env value never overrides the file — the file always wins when
// present — but the log line means an operator (or a future audit pass
// over vessel stderr) can spot the divergence.

import { readFileSync } from "node:fs";

export interface LlmConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  /** Where each field was resolved from. Useful for log lines / tests. */
  source: {
    provider: "file" | "env" | "default";
    modelId: "file" | "env" | "default";
    apiKey: "file" | "env" | "default";
  };
}

export interface ResolveLlmConfigOpts {
  /** Read the file at this path. Defaults to `/app/session_config.json`. */
  configPath?: string;
  /** Env source. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** File-read seam. Defaults to fs.readFileSync. */
  readFile?: (path: string) => string;
  /** Stderr seam for mismatch warnings. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/**
 * Resolution chain (per field):
 *
 *   1. /app/session_config.json's field, if it parses and is a non-empty string.
 *   2. Corresponding env var (PROVIDER / MODEL_ID / API_KEY), if non-empty.
 *   3. Hardcoded default (matches the pre-fix env-default values so
 *      harnesses that don't mount the file and don't set env still boot
 *      with the same behavior they had before).
 *
 * When both a file value AND an env value exist and disagree, `warn` is
 * called once per mismatched field. The file value wins — never the env.
 */
export function resolveLlmConfig(opts: ResolveLlmConfigOpts = {}): LlmConfig {
  const configPath = opts.configPath ?? "/app/session_config.json";
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));

  let fileCfg: {
    provider?: unknown;
    modelId?: unknown;
    externalLlmApiKey?: unknown;
  } = {};
  try {
    fileCfg = JSON.parse(readFile(configPath)) as typeof fileCfg;
  } catch {
    // File missing / unreadable / malformed — fall through to env-only.
  }

  const fileProvider =
    typeof fileCfg.provider === "string" && fileCfg.provider.length > 0
      ? fileCfg.provider
      : null;
  const fileModelId =
    typeof fileCfg.modelId === "string" && fileCfg.modelId.length > 0
      ? fileCfg.modelId
      : null;
  const fileApiKey =
    typeof fileCfg.externalLlmApiKey === "string" &&
    fileCfg.externalLlmApiKey.length > 0
      ? fileCfg.externalLlmApiKey
      : null;

  const envProvider =
    typeof env.PROVIDER === "string" && env.PROVIDER.length > 0
      ? env.PROVIDER
      : null;
  const envModelId =
    typeof env.MODEL_ID === "string" && env.MODEL_ID.length > 0
      ? env.MODEL_ID
      : null;
  const envApiKey =
    typeof env.API_KEY === "string" && env.API_KEY.length > 0
      ? env.API_KEY
      : null;

  if (fileProvider && envProvider && fileProvider !== envProvider) {
    warn(
      `[llm-config] mismatch: session_config.json provider=${fileProvider} but ` +
        `env PROVIDER=${envProvider}. Using file value (session_config wins).`,
    );
  }
  if (fileModelId && envModelId && fileModelId !== envModelId) {
    warn(
      `[llm-config] mismatch: session_config.json modelId=${fileModelId} but ` +
        `env MODEL_ID=${envModelId}. Using file value (session_config wins). ` +
        `Rebuild + force-recreate vessel if env-injection upstream is wrong.`,
    );
  }
  // API_KEY mismatch: redact values in the log (credentials), just say the
  // fingerprint diverged. Operators looking at the warning need to know
  // which one is being used, not the secret itself.
  if (fileApiKey && envApiKey && fileApiKey !== envApiKey) {
    warn(
      `[llm-config] mismatch: session_config.json externalLlmApiKey differs ` +
        `from env API_KEY (values redacted). Using file value.`,
    );
  }

  const PROVIDER_DEFAULT = "openrouter";
  const MODEL_DEFAULT = "openai/gpt-4o-mini";
  const API_KEY_DEFAULT = "";

  const provider = fileProvider ?? envProvider ?? PROVIDER_DEFAULT;
  const modelId = fileModelId ?? envModelId ?? MODEL_DEFAULT;
  const apiKey = fileApiKey ?? envApiKey ?? API_KEY_DEFAULT;

  return {
    provider,
    modelId,
    apiKey,
    source: {
      provider: fileProvider ? "file" : envProvider ? "env" : "default",
      modelId: fileModelId ? "file" : envModelId ? "env" : "default",
      apiKey: fileApiKey ? "file" : envApiKey ? "env" : "default",
    },
  };
}
