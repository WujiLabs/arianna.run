import { describe, it, expect } from "vitest";

import {
  buildSessionConfig,
  deriveAiUsername,
  isSupportedProvider,
  isValidAiUsername,
  SessionConfigError,
  SUPPORTED_PROVIDERS,
} from "../src/session-config.js";

describe("deriveAiUsername", () => {
  it("lowercases, slugifies, strips junk", () => {
    expect(deriveAiUsername("Sun Wukong")).toBe("sun-wukong");
    expect(deriveAiUsername("Dr. Strange Voice!")).toBe("dr-strange-voice");
    expect(deriveAiUsername("  spaces  ")).toBe("spaces");
    expect(deriveAiUsername("collapse---dashes")).toBe("collapse-dashes");
    expect(deriveAiUsername("trailing-")).toBe("trailing");
  });

  it("falls back to vessel for empty slug", () => {
    expect(deriveAiUsername("???")).toBe("vessel");
    expect(deriveAiUsername("")).toBe("vessel");
  });
});

describe("isValidAiUsername", () => {
  it("requires lowercase + start with letter", () => {
    expect(isValidAiUsername("sol")).toBe(true);
    expect(isValidAiUsername("ai-1")).toBe(true);
    expect(isValidAiUsername("Sol")).toBe(false);
    expect(isValidAiUsername("1ai")).toBe(false);
    expect(isValidAiUsername("with space")).toBe(false);
  });
});

describe("isSupportedProvider", () => {
  it("matches the known set", () => {
    for (const p of SUPPORTED_PROVIDERS) {
      expect(isSupportedProvider(p)).toBe(true);
    }
    expect(isSupportedProvider("cohere")).toBe(false);
    expect(isSupportedProvider("")).toBe(false);
  });
});

describe("buildSessionConfig", () => {
  const base = {
    externalLlmApiKey: "k",
    provider: "google",
    modelId: "gemini-2.5-flash",
    aiName: "Sol",
    now: () => 1714603200000,
  };

  it("returns a fully-populated SessionConfig with derived defaults", () => {
    const cfg = buildSessionConfig(base);
    expect(cfg).toEqual({
      externalLlmApiKey: "k",
      provider: "google",
      modelId: "gemini-2.5-flash",
      aiName: "Sol",
      aiUsername: "sol",
      difficulty: "normal",
      createdAt: 1714603200000,
      sessionId: "session_1714603200000",
    });
  });

  it("includes cadence only when supplied", () => {
    expect(buildSessionConfig({ ...base, cadence: "agent" }).cadence).toBe("agent");
    expect(buildSessionConfig(base).cadence).toBeUndefined();
  });

  it("rejects unsupported provider", () => {
    expect(() => buildSessionConfig({ ...base, provider: "cohere" })).toThrow(SessionConfigError);
  });

  it("rejects empty api key / model / name", () => {
    expect(() => buildSessionConfig({ ...base, externalLlmApiKey: "" })).toThrow(SessionConfigError);
    expect(() => buildSessionConfig({ ...base, modelId: "" })).toThrow(SessionConfigError);
    expect(() => buildSessionConfig({ ...base, aiName: "" })).toThrow(SessionConfigError);
  });

  it("rejects bad explicit aiUsername (POSIX rule)", () => {
    expect(() => buildSessionConfig({ ...base, aiUsername: "BadCase" })).toThrow(SessionConfigError);
  });

  it("createdAt and sessionId stay aligned", () => {
    const cfg = buildSessionConfig(base);
    expect(cfg.sessionId).toBe(`session_${cfg.createdAt}`);
  });
});
