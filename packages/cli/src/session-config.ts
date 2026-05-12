// Build the per-profile session_config.json that the vessel/sidecar/daemon
// stack reads on startup. Used by `arianna profile create --model ...` and
// (eventually) any other CLI verb that materialises a session before the TUI
// lobby has run.
//
// The shape mirrors @arianna/types' SessionConfig. We deliberately don't
// import that type here to avoid a cycle (types depends on nothing; cli
// depends on types only for runtime dispatching, not for static layout).

import type { SessionConfig } from "@arianna/types";

export type Provider = "google" | "anthropic" | "openai" | "openrouter";
export const SUPPORTED_PROVIDERS: readonly Provider[] = [
  "google",
  "anthropic",
  "openai",
  "openrouter",
];

export class SessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConfigError";
  }
}

export interface BuildSessionConfigInputs {
  externalLlmApiKey: string;
  provider: string;
  modelId: string;
  aiName: string;
  aiUsername?: string;
  cadence?: "human" | "agent";
  /** Defaults to "normal". Boarding scene's choice; not exposed via CLI flags yet. */
  difficulty?: "easy" | "normal" | "hard";
  /** Test seam — defaults to Date.now. */
  now?: () => number;
}

/**
 * Produce a fully-populated SessionConfig from CLI inputs. Validates
 * provider, defaults difficulty, derives aiUsername if missing, and stamps
 * createdAt/sessionId from the same timestamp so they stay aligned (the
 * daemon's session-id discovery falls back to `session_${createdAt}`).
 */
export function buildSessionConfig(inputs: BuildSessionConfigInputs): SessionConfig {
  if (!inputs.externalLlmApiKey || inputs.externalLlmApiKey.length === 0) {
    throw new SessionConfigError("externalLlmApiKey is required.");
  }
  if (!isSupportedProvider(inputs.provider)) {
    throw new SessionConfigError(
      `Unsupported provider "${inputs.provider}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}.`,
    );
  }
  if (!inputs.modelId || inputs.modelId.length === 0) {
    throw new SessionConfigError("modelId is required.");
  }
  if (!inputs.aiName || inputs.aiName.length === 0) {
    throw new SessionConfigError("aiName is required.");
  }

  const aiUsername = inputs.aiUsername ?? deriveAiUsername(inputs.aiName);
  if (!isValidAiUsername(aiUsername)) {
    throw new SessionConfigError(
      `aiUsername "${aiUsername}" is not a valid POSIX username (^[a-z][a-z0-9-]{0,31}$).`,
    );
  }

  const createdAt = (inputs.now ?? Date.now)();
  const cfg: SessionConfig = {
    externalLlmApiKey: inputs.externalLlmApiKey,
    provider: inputs.provider,
    modelId: inputs.modelId,
    aiName: inputs.aiName,
    aiUsername,
    difficulty: inputs.difficulty ?? "normal",
    createdAt,
    sessionId: `session_${createdAt}`,
  };
  if (inputs.cadence) cfg.cadence = inputs.cadence;
  return cfg;
}

export function isSupportedProvider(value: string): value is Provider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Mirrors the rule used by @arianna/tui's lobby naming step: lowercase,
 * spaces→hyphens, strip everything outside [a-z0-9-], collapse repeats. Falls
 * back to "vessel" if the result is empty.
 */
export function deriveAiUsername(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "vessel";
}

// POSIX-ish username constraint. We're stricter than Linux (32 chars, must
// start with a letter) because the value also lands in shell-quoted docker
// build args and as a literal in /etc/passwd.
const AI_USERNAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export function isValidAiUsername(value: string): boolean {
  return AI_USERNAME_RE.test(value);
}
