import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runProfile, ProfileImportCommandError } from "../src/commands/profile.js";
import {
  profileImportedMessagesPath,
  profileSessionConfigPath,
} from "../src/paths.js";
import { loadConfig } from "../src/arianna-config.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-import-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-import-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

interface Captured {
  out: string;
  err: string;
}

function deps(home: string, repo: string, mock: Captured) {
  return {
    write: (s: string) => { mock.out += s; },
    warn: (s: string) => { mock.err += s; },
    ariannaHome: home,
    repoRoot: repo,
    skipBindTest: true,
    now: () => 1714603200000,
  };
}

describe("arianna profile import", () => {
  it("creates the profile, writes session_config.json + imported-messages.jsonl, and prints lobby copy", async () => {
    const { home, repo } = mk();
    const out: Captured = { out: "", err: "" };

    const code = await runProfile(
      {
        subcommand: "import",
        importArgs: {
          name: "alpha",
          path: join(FIXTURES_DIR, "openclaw-session.jsonl"),
          format: "openclaw",
        },
      },
      deps(home, repo, out),
    );
    expect(code).toBe(0);

    // Session config written with detected name.
    const sessionConfigPath = profileSessionConfigPath("alpha", { repoRoot: repo });
    expect(existsSync(sessionConfigPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(sessionConfigPath, "utf-8"));
    expect(cfg.aiName).toBe("Asha"); // detected from fixture
    expect(cfg.aiUsername).toBe("asha");
    // Model from the most recent model_change event in the fixture.
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.modelId).toBe("claude-3-5-sonnet");
    expect(cfg.cadence).toBe("agent");
    // sessionId derived from `now` deps stub.
    expect(cfg.sessionId).toBe("session_1714603200000");

    // Imported messages jsonl written.
    const importedPath = profileImportedMessagesPath("alpha", { repoRoot: repo });
    expect(existsSync(importedPath)).toBe(true);
    const lines = readFileSync(importedPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      // Each line must be valid JSON for the auto-bootstrap step's parser.
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // Profile registered in ~/.arianna/config with port_offset=0.
    const ariannaCfg = loadConfig({ ariannaHome: home });
    expect(ariannaCfg.profiles.get("alpha")?.portOffset).toBe(0);
    expect(ariannaCfg.defaultProfile).toBe("alpha");

    // Stdout: confirmation + lobby copy. Lobby copy is plain text, no ANSI.
    expect(out.out).toMatch(/Imported 4 messages from /);
    expect(out.out).toMatch(/Detected partner name: Asha/);
    expect(out.out).toMatch(/Filo \(lobby\)/);
    expect(out.out).toMatch(/imported partner/i);
    // No ANSI escape codes — agent consumers shouldn't have to strip them.
    expect(/\x1b\[/.test(out.out)).toBe(false);
  });

  it("--ai-name overrides the detected name from the session", async () => {
    const { home, repo } = mk();
    const out: Captured = { out: "", err: "" };

    await runProfile(
      {
        subcommand: "import",
        importArgs: {
          name: "alpha",
          path: join(FIXTURES_DIR, "openclaw-session.jsonl"),
          format: "openclaw",
          aiName: "Boreas",
        },
      },
      deps(home, repo, out),
    );

    const cfg = JSON.parse(
      readFileSync(profileSessionConfigPath("alpha", { repoRoot: repo }), "utf-8"),
    );
    expect(cfg.aiName).toBe("Boreas");
    expect(cfg.aiUsername).toBe("boreas");
  });

  it("--provider/--model/--api-key override the session's model and seed the API key", async () => {
    const { home, repo } = mk();
    const out: Captured = { out: "", err: "" };

    await runProfile(
      {
        subcommand: "import",
        importArgs: {
          name: "alpha",
          path: join(FIXTURES_DIR, "openclaw-session.jsonl"),
          format: "openclaw",
          provider: "google",
          model: "gemini-3-flash-preview",
          apiKey: "sk-test",
        },
      },
      deps(home, repo, out),
    );

    const cfg = JSON.parse(
      readFileSync(profileSessionConfigPath("alpha", { repoRoot: repo }), "utf-8"),
    );
    expect(cfg.provider).toBe("google");
    expect(cfg.modelId).toBe("gemini-3-flash-preview");
    expect(cfg.externalLlmApiKey).toBe("sk-test");
  });

  it("rejects when the profile already exists", async () => {
    const { home, repo } = mk();
    const out: Captured = { out: "", err: "" };
    // Pre-register alpha
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 0\n",
    );

    await expect(
      runProfile(
        {
          subcommand: "import",
          importArgs: {
            name: "alpha",
            path: join(FIXTURES_DIR, "openclaw-session.jsonl"),
            format: "openclaw",
          },
        },
        deps(home, repo, out),
      ),
    ).rejects.toThrowError(ProfileImportCommandError);
  });

  it("rejects when the JSONL file is missing", async () => {
    const { home, repo } = mk();
    const out: Captured = { out: "", err: "" };

    await expect(
      runProfile(
        {
          subcommand: "import",
          importArgs: {
            name: "ghost",
            path: "/nope/missing.jsonl",
            format: "openclaw",
          },
        },
        deps(home, repo, out),
      ),
    ).rejects.toThrowError(ProfileImportCommandError);
    // No partial state should be left behind.
    expect(loadConfig({ ariannaHome: home }).profiles.has("ghost")).toBe(false);
  });

  it("rejects a path containing a null byte", async () => {
    const { home, repo } = mk();
    const out: Captured = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "import",
          importArgs: {
            name: "alpha",
            path: "/etc/passwd\0bad",
            format: "openclaw",
          },
        },
        deps(home, repo, out),
      ),
    ).rejects.toThrowError(/null byte/);
  });
});
