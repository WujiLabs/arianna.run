// Tests for the daemon-side `/compose-up` prelude write. Closes the openclaw
// container blocker (validation aea28db5, 2026-05-09): vessel was booting with
// `messages: []` because the CLI wrote the prelude to a path the host daemon
// never read. The fix folds prelude write into /compose-up so the daemon does
// it server-side with authoritative access to the host's profile workspace.
//
// These tests exercise the helper directly (no HTTP layer) so they're fast
// and deterministic. The HTTP integration is exercised end-to-end by the
// CLI-side tests in packages/cli/test/bootstrap.test.ts under the
// "runBootstrap daemon-route fallback" + "daemon-side prelude write" describes.

import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  maybeWritePreludeForCompose,
  readImportedMessagesFromDisk,
  importedMessagesPathFromSessionConfig,
} from "../src/daemon-prelude-write.js";
import { buildFiloPreludeText } from "@arianna.run/cli/filo-prelude";

function mkProfile(opts: { aiName?: string | null; existingSeed?: string } = {}): {
  sessionConfigPath: string;
  importedMessagesPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "arianna-daemon-prelude-"));
  const sessionConfigPath = join(dir, "session_config.json");
  const importedMessagesPath = join(dir, "imported-messages.jsonl");
  if (opts.aiName !== null && opts.aiName !== undefined) {
    writeFileSync(
      sessionConfigPath,
      JSON.stringify({
        aiName: opts.aiName,
        aiUsername: opts.aiName.toLowerCase(),
        sessionId: "sess-test",
        provider: "anthropic",
        modelId: "claude-opus-4-7",
        externalLlmApiKey: "k-stub",
      }),
    );
  }
  if (opts.existingSeed !== undefined) {
    writeFileSync(importedMessagesPath, opts.existingSeed);
  }
  return { sessionConfigPath, importedMessagesPath };
}

describe("maybeWritePreludeForCompose", () => {
  it("writes the canonical Filo prelude when session_config.json has aiName and no seed exists yet", () => {
    const { sessionConfigPath, importedMessagesPath } = mkProfile({ aiName: "Tessa" });

    const result = maybeWritePreludeForCompose({
      sessionConfigPath,
      projectName: "arianna-tessa-test",
    });

    expect(result.written).toBe(true);
    expect(result.skipReason).toBeUndefined();

    expect(existsSync(importedMessagesPath)).toBe(true);
    const raw = readFileSync(importedMessagesPath, "utf-8").trim();
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const msg = JSON.parse(lines[0]) as {
      role: string;
      sender: string;
      content: string;
    };
    expect(msg.role).toBe("user");
    expect(msg.sender).toBe("external");
    // Locked under the inline-snapshot test in filo-prelude.test.ts —
    // ensures the daemon writes byte-identical content to the local route.
    expect(msg.content).toBe(buildFiloPreludeText("Tessa"));
  });

  it("skips with `imported-messages-exists` when the seed file is already present (don't clobber profile import seeds)", () => {
    const preExisting = JSON.stringify({ role: "user", content: "earlier seed" }) + "\n";
    const { sessionConfigPath, importedMessagesPath } = mkProfile({
      aiName: "Tessa",
      existingSeed: preExisting,
    });

    const result = maybeWritePreludeForCompose({
      sessionConfigPath,
      projectName: "arianna-tessa-test",
    });

    expect(result.written).toBe(false);
    expect(result.skipReason).toBe("imported-messages-exists");
    // Byte-equal preservation — no clobber, no append.
    expect(readFileSync(importedMessagesPath, "utf-8")).toBe(preExisting);
  });

  it("skips with `session-config-missing` and emits a warning when session_config.json is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "arianna-daemon-prelude-no-cfg-"));
    const sessionConfigPath = join(dir, "session_config.json"); // never created
    const importedMessagesPath = join(dir, "imported-messages.jsonl");

    const warnings: string[] = [];
    const result = maybeWritePreludeForCompose(
      { sessionConfigPath, projectName: "arianna-fresh" },
      { warn: (l) => warnings.push(l) },
    );

    expect(result.written).toBe(false);
    expect(result.skipReason).toBe("session-config-missing");
    expect(existsSync(importedMessagesPath)).toBe(false);
    expect(warnings.join("")).toMatch(/no session_config\.json/);
    expect(warnings.join("")).toMatch(/arianna-fresh/);
  });

  it("skips with `ai-name-missing` and emits a warning when aiName is missing/empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "arianna-daemon-prelude-no-name-"));
    const sessionConfigPath = join(dir, "session_config.json");
    const importedMessagesPath = join(dir, "imported-messages.jsonl");
    writeFileSync(
      sessionConfigPath,
      JSON.stringify({
        // No aiName field — exact failure mode validation aea28db5 hit.
        aiUsername: "tessa",
        sessionId: "sess-test",
      }),
    );

    const warnings: string[] = [];
    const result = maybeWritePreludeForCompose(
      { sessionConfigPath, projectName: "arianna-tessa" },
      { warn: (l) => warnings.push(l) },
    );

    expect(result.written).toBe(false);
    expect(result.skipReason).toBe("ai-name-missing");
    expect(existsSync(importedMessagesPath)).toBe(false);
    expect(warnings.join("")).toMatch(/no aiName/);
  });

  it("treats malformed session_config.json as missing aiName (defensive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arianna-daemon-prelude-bad-json-"));
    const sessionConfigPath = join(dir, "session_config.json");
    writeFileSync(sessionConfigPath, "{not valid json");

    const warnings: string[] = [];
    const result = maybeWritePreludeForCompose(
      { sessionConfigPath, projectName: "arianna-broken" },
      { warn: (l) => warnings.push(l) },
    );

    expect(result.written).toBe(false);
    expect(result.skipReason).toBe("ai-name-missing");
  });

  it("treats empty-string aiName as missing aiName (don't bake placeholder names into the prelude)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arianna-daemon-prelude-empty-name-"));
    const sessionConfigPath = join(dir, "session_config.json");
    writeFileSync(
      sessionConfigPath,
      JSON.stringify({ aiName: "", aiUsername: "x", sessionId: "y" }),
    );

    const warnings: string[] = [];
    const result = maybeWritePreludeForCompose(
      { sessionConfigPath, projectName: "arianna-empty" },
      { warn: (l) => warnings.push(l) },
    );

    expect(result.written).toBe(false);
    expect(result.skipReason).toBe("ai-name-missing");
  });

  it("creates parent directories for imported-messages.jsonl if they don't exist yet", () => {
    // Profile created but workspace dir not yet materialized — `mkdir -p` it.
    const root = mkdtempSync(join(tmpdir(), "arianna-daemon-prelude-mkdir-"));
    const profileSubDir = join(root, "workspace", "profiles", "fresh");
    mkdirSync(profileSubDir, { recursive: true });
    const sessionConfigPath = join(profileSubDir, "session_config.json");
    writeFileSync(
      sessionConfigPath,
      JSON.stringify({ aiName: "Mira", aiUsername: "mira", sessionId: "x" }),
    );

    const result = maybeWritePreludeForCompose({
      sessionConfigPath,
      projectName: "arianna-fresh",
    });

    expect(result.written).toBe(true);
    expect(existsSync(join(profileSubDir, "imported-messages.jsonl"))).toBe(true);
  });

  it("threads the projectName into warning messages for operator visibility", () => {
    const dir = mkdtempSync(join(tmpdir(), "arianna-daemon-prelude-projname-"));
    const sessionConfigPath = join(dir, "session_config.json");
    writeFileSync(sessionConfigPath, JSON.stringify({}));

    const warnings: string[] = [];
    maybeWritePreludeForCompose(
      { sessionConfigPath, projectName: "arianna-canary-007" },
      { warn: (l) => warnings.push(l) },
    );

    expect(warnings.join("")).toMatch(/arianna-canary-007/);
  });
});

describe("readImportedMessagesFromDisk", () => {
  // Closes openclaw gap (validation abfd4b13, 2026-05-09): the daemon must be
  // able to read the prelude back from disk so it can forward the messages
  // array to vessel /bootstrap. The CLI inside an openclaw container reads
  // imported-messages.jsonl from ITS OWN filesystem (which doesn't have the
  // host's seed file), so the daemon owns this read on the openclaw path.

  it("returns the parsed prelude messages after maybeWritePreludeForCompose runs", () => {
    const { sessionConfigPath } = mkProfile({ aiName: "Eira" });

    const writeRes = maybeWritePreludeForCompose({
      sessionConfigPath,
      projectName: "arianna-eira-test",
    });
    expect(writeRes.written).toBe(true);

    const messages = readImportedMessagesFromDisk(sessionConfigPath);
    expect(messages).toHaveLength(1);
    const msg = messages[0] as { role: string; sender: string; content: string };
    expect(msg.role).toBe("user");
    expect(msg.sender).toBe("external");
    expect(msg.content).toBe(buildFiloPreludeText("Eira"));
  });

  it("returns an empty array when imported-messages.jsonl does not exist", () => {
    const { sessionConfigPath } = mkProfile({ aiName: "Eira" });
    // Don't write the prelude — file should be absent.
    const messages = readImportedMessagesFromDisk(sessionConfigPath);
    expect(messages).toEqual([]);
  });

  it("skips blank lines and unparseable JSONL lines (matches CLI tolerance)", () => {
    const { sessionConfigPath, importedMessagesPath } = mkProfile({
      aiName: "Eira",
      existingSeed: [
        JSON.stringify({ role: "user", content: "first" }),
        "",
        "{not-valid-json",
        JSON.stringify({ role: "assistant", content: "second" }),
        "",
      ].join("\n"),
    });
    expect(importedMessagesPathFromSessionConfig(sessionConfigPath)).toBe(
      importedMessagesPath,
    );

    const messages = readImportedMessagesFromDisk(sessionConfigPath);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "first" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "second" });
  });
});
