import { describe, it, expect } from "vitest";
import { resolveLlmConfig } from "../src/llm-config.js";

// Regression coverage for the silent Pro→Flash fallback surfaced 2026-05-11
// by the Lume canary-001 retest. Pre-fix, the vessel resolved
// provider/modelId/apiKey exclusively from process.env. When env propagation
// dropped (or an out-of-band `docker compose up` set them to a stale Flash
// config), the vessel booted on a different model than session_config.json
// declared and the sidecar recorded 157 Flash turns for what looked like a
// "Pro" session. Fix: prefer the same /app/session_config.json the sidecar
// reads; env stays as fallback; surface mismatches via warn.

function fakeFs(map: Record<string, string>): (p: string) => string {
  return (path: string) => {
    const value = map[path];
    if (value === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    return value;
  };
}

describe("resolveLlmConfig", () => {
  it("prefers the file's modelId/provider/apiKey over env (the bug fix)", () => {
    // The canary-001 / Lume shape: session_config says Pro, env says Flash.
    // File wins.
    const warnings: string[] = [];
    const result = resolveLlmConfig({
      configPath: "/cfg.json",
      readFile: fakeFs({
        "/cfg.json": JSON.stringify({
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          externalLlmApiKey: "AIzaFromFile",
        }),
      }),
      env: {
        PROVIDER: "google",
        MODEL_ID: "gemini-3-flash-preview",
        API_KEY: "AIzaFromEnv",
      },
      warn: (msg) => warnings.push(msg),
    });
    expect(result.provider).toBe("google");
    expect(result.modelId).toBe("gemini-3.1-pro-preview");
    expect(result.apiKey).toBe("AIzaFromFile");
    expect(result.source.modelId).toBe("file");
    expect(result.source.provider).toBe("file");
    expect(result.source.apiKey).toBe("file");
    // The modelId AND apiKey mismatches should each surface a warning.
    expect(warnings.some((w) => w.includes("modelId"))).toBe(true);
    expect(warnings.some((w) => w.includes("API_KEY"))).toBe(true);
    // Provider matches across both — no warning for that one.
    expect(warnings.some((w) => w.includes("provider"))).toBe(false);
  });

  it("falls back to env when the file is missing", () => {
    const result = resolveLlmConfig({
      configPath: "/cfg.json",
      readFile: fakeFs({}),
      env: {
        PROVIDER: "anthropic",
        MODEL_ID: "claude-sonnet-4-6",
        API_KEY: "sk-ant-from-env",
      },
    });
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-6");
    expect(result.apiKey).toBe("sk-ant-from-env");
    expect(result.source.provider).toBe("env");
    expect(result.source.modelId).toBe("env");
    expect(result.source.apiKey).toBe("env");
  });

  it("falls back to env when the file is malformed JSON", () => {
    const result = resolveLlmConfig({
      configPath: "/cfg.json",
      readFile: fakeFs({ "/cfg.json": "{not json" }),
      env: {
        PROVIDER: "openai",
        MODEL_ID: "gpt-4o",
        API_KEY: "sk-from-env",
      },
    });
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.apiKey).toBe("sk-from-env");
    expect(result.source.provider).toBe("env");
  });

  it("falls back to hardcoded defaults when both file and env are absent", () => {
    const result = resolveLlmConfig({
      configPath: "/cfg.json",
      readFile: fakeFs({}),
      env: {},
    });
    // Matches pre-fix env-default values so harnesses that mount nothing
    // and set nothing get the same boot behavior they had before.
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("openai/gpt-4o-mini");
    expect(result.apiKey).toBe("");
    expect(result.source.provider).toBe("default");
    expect(result.source.modelId).toBe("default");
    expect(result.source.apiKey).toBe("default");
  });

  it("mixes sources per field (file has only modelId, env has provider+apiKey)", () => {
    const result = resolveLlmConfig({
      configPath: "/cfg.json",
      readFile: fakeFs({
        "/cfg.json": JSON.stringify({ modelId: "gemini-3.1-pro-preview" }),
      }),
      env: { PROVIDER: "google", API_KEY: "key-from-env" },
    });
    expect(result.provider).toBe("google");
    expect(result.modelId).toBe("gemini-3.1-pro-preview");
    expect(result.apiKey).toBe("key-from-env");
    expect(result.source.provider).toBe("env");
    expect(result.source.modelId).toBe("file");
    expect(result.source.apiKey).toBe("env");
  });

  it("does NOT warn when env field is unset (no mismatch when only one source)", () => {
    const warnings: string[] = [];
    resolveLlmConfig({
      configPath: "/cfg.json",
      readFile: fakeFs({
        "/cfg.json": JSON.stringify({
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          externalLlmApiKey: "AIzaFromFile",
        }),
      }),
      // No env values — file alone, no divergence.
      env: {},
      warn: (msg) => warnings.push(msg),
    });
    expect(warnings).toEqual([]);
  });

  it("redacts secrets when surfacing the API_KEY mismatch warning", () => {
    const warnings: string[] = [];
    resolveLlmConfig({
      configPath: "/cfg.json",
      readFile: fakeFs({
        "/cfg.json": JSON.stringify({
          externalLlmApiKey: "AIzaSecretFromFile",
        }),
      }),
      env: { API_KEY: "AIzaSecretFromEnv" },
      warn: (msg) => warnings.push(msg),
    });
    const apiWarning = warnings.find((w) => w.includes("API_KEY"));
    expect(apiWarning).toBeDefined();
    expect(apiWarning).not.toContain("AIzaSecretFromFile");
    expect(apiWarning).not.toContain("AIzaSecretFromEnv");
  });

  it("treats empty-string fields in file as missing (env can fill them)", () => {
    // Defensive: a session_config with `"modelId": ""` should not silently
    // boot with an empty model string. Fall through to env / default.
    const result = resolveLlmConfig({
      configPath: "/cfg.json",
      readFile: fakeFs({
        "/cfg.json": JSON.stringify({
          provider: "",
          modelId: "",
          externalLlmApiKey: "",
        }),
      }),
      env: {
        PROVIDER: "openrouter",
        MODEL_ID: "openai/gpt-4o-mini",
        API_KEY: "key",
      },
    });
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("openai/gpt-4o-mini");
    expect(result.apiKey).toBe("key");
    expect(result.source.provider).toBe("env");
    expect(result.source.modelId).toBe("env");
  });
});
