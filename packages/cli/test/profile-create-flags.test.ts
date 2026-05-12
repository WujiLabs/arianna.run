import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProfile, ProfileCommandError } from "../src/commands/profile.js";
import { profileDir } from "../src/paths.js";
import type { ProfileCreateFlags } from "../src/argv.js";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-cmd-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-cmd-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

interface Capture {
  out: string;
  err: string;
}

function depsFor(home: string, repo: string, cap: Capture, extra: object = {}) {
  return {
    write: (s: string) => { cap.out += s; },
    warn: (s: string) => { cap.err += s; },
    ariannaHome: home,
    repoRoot: repo,
    skipBindTest: true,
    now: () => 1714603200000,
    isTTY: () => false,
    env: {} as NodeJS.ProcessEnv,
    ...extra,
  } as Parameters<typeof runProfile>[1];
}

describe("profile create — non-interactive flags", () => {
  it("writes session_config.json when all required flags supplied", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    const create: ProfileCreateFlags = {
      provider: "google",
      model: "gemini-2.5-flash",
      apiKey: "test-api-key-123",
      aiName: "Sol",
      cadence: "agent",
    };

    const code = await runProfile(
      { subcommand: "create", name: "alpha", create },
      depsFor(home, repo, cap),
    );

    expect(code).toBe(0);
    const sessionPath = join(profileDir("alpha", { repoRoot: repo }), "session_config.json");
    expect(existsSync(sessionPath)).toBe(true);
    const sc = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(sc).toEqual({
      externalLlmApiKey: "test-api-key-123",
      provider: "google",
      modelId: "gemini-2.5-flash",
      aiName: "Sol",
      aiUsername: "sol", // derived
      difficulty: "normal",
      createdAt: 1714603200000,
      sessionId: "session_1714603200000",
      cadence: "agent",
    });
    expect(cap.out).toMatch(/Wrote session_config\.json/);
  });

  it("uses explicit --ai-username over the derived one", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await runProfile(
      {
        subcommand: "create",
        name: "alpha",
        create: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "k",
          aiName: "Sun Wukong",
          aiUsername: "sun-w",
        },
      },
      depsFor(home, repo, cap),
    );
    const sc = JSON.parse(
      readFileSync(join(profileDir("alpha", { repoRoot: repo }), "session_config.json"), "utf-8"),
    );
    expect(sc.aiUsername).toBe("sun-w");
  });

  it("derives aiUsername when omitted", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await runProfile(
      {
        subcommand: "create",
        name: "alpha",
        create: {
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "k",
          aiName: "Dr. Strange Voice!",
        },
      },
      depsFor(home, repo, cap),
    );
    const sc = JSON.parse(
      readFileSync(join(profileDir("alpha", { repoRoot: repo }), "session_config.json"), "utf-8"),
    );
    expect(sc.aiUsername).toBe("dr-strange-voice");
  });

  it("resolves --api-key-env from process env", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    const code = await runProfile(
      {
        subcommand: "create",
        name: "alpha",
        create: {
          provider: "google",
          model: "gemini-2.5-flash",
          apiKeyEnv: "MY_TEST_KEY",
          aiName: "Sol",
        },
      },
      depsFor(home, repo, cap, {
        env: { MY_TEST_KEY: "value-from-env" } as NodeJS.ProcessEnv,
      }),
    );
    expect(code).toBe(0);
    const sc = JSON.parse(
      readFileSync(join(profileDir("alpha", { repoRoot: repo }), "session_config.json"), "utf-8"),
    );
    expect(sc.externalLlmApiKey).toBe("value-from-env");
  });

  it("rejects --api-key-env with invalid env-var name", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "create",
          name: "alpha",
          create: {
            provider: "google",
            model: "x",
            apiKeyEnv: "../etc/passwd",
            aiName: "Sol",
          },
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrowError(/not a valid environment variable name/);
  });

  it("rejects --api-key-env when the variable is unset", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "create",
          name: "alpha",
          create: {
            provider: "google",
            model: "x",
            apiKeyEnv: "MY_UNSET_VAR",
            aiName: "Sol",
          },
        },
        depsFor(home, repo, cap, { env: {} }),
      ),
    ).rejects.toThrowError(/is not set in the environment/);
  });

  it("rejects unsupported provider", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "create",
          name: "alpha",
          create: {
            provider: "cohere",
            model: "x",
            apiKey: "k",
            aiName: "S",
          },
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrowError(/not supported/);
  });

  it("non-TTY + missing required flag → clear error (no prompt)", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "create",
          name: "alpha",
          create: { provider: "google", aiName: "Sol" }, // missing model + key
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrowError(/Missing required flag/);
  });

  it("TTY + missing flag → prompts via the supplied prompt seam", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };

    // Order of prompts is fixed: provider, model, api key, ai name. We seed
    // each missing field in turn so the test is order-sensitive (and asserts
    // it).
    const answers = ["openrouter", "anthropic/claude-3.5", "the-key", "Sol"];
    let i = 0;
    const code = await runProfile(
      {
        subcommand: "create",
        name: "alpha",
        // We must set at least one flag so the create path is taken at all,
        // but mark all required fields missing.
        create: { cadence: "human" },
      },
      depsFor(home, repo, cap, {
        isTTY: () => true,
        prompt: async () => answers[i++],
      }),
    );

    expect(code).toBe(0);
    const sc = JSON.parse(
      readFileSync(join(profileDir("alpha", { repoRoot: repo }), "session_config.json"), "utf-8"),
    );
    expect(sc.provider).toBe("openrouter");
    expect(sc.modelId).toBe("anthropic/claude-3.5");
    expect(sc.externalLlmApiKey).toBe("the-key");
    expect(sc.aiName).toBe("Sol");
    expect(sc.cadence).toBe("human");
  });

  it("bare profile create (no flags) does NOT write session_config.json", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    const code = await runProfile(
      { subcommand: "create", name: "alpha", create: {} },
      depsFor(home, repo, cap),
    );
    expect(code).toBe(0);
    const sessionPath = join(profileDir("alpha", { repoRoot: repo }), "session_config.json");
    expect(existsSync(sessionPath)).toBe(false);
  });

  it("invalid derived ai-username (--ai-name yields empty slug, --ai-username explicit) errors", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "create",
          name: "alpha",
          create: {
            provider: "google",
            model: "x",
            apiKey: "k",
            aiName: "Sol",
            aiUsername: "BadCase",
          },
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrowError(/not a valid POSIX username/);
  });
});

describe("profile create — failure cleans up the dir", () => {
  it("removes the workspace dir when session-config flags are invalid", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "create",
          name: "alpha",
          create: { provider: "cohere", model: "x", apiKey: "k", aiName: "S" },
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrow(ProfileCommandError);
    // The directory should NOT remain — failure cleanup ran.
    expect(existsSync(profileDir("alpha", { repoRoot: repo }))).toBe(false);
  });
});
