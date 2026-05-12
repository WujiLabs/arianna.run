import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSessionJsonl, ImportError } from "../src/import-parser.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("parseSessionJsonl", () => {
  it("parses a valid OpenClaw session and extracts messages, model, detected name", () => {
    const result = parseSessionJsonl(
      join(FIXTURES_DIR, "openclaw-session.jsonl"),
    );
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    // Model_change in the middle wins over the first assistant message's
    // model — the parser updates `model` on every model_change entry.
    expect(result.model?.provider).toBe("anthropic");
    expect(result.model?.modelId).toBe("claude-3-5-sonnet");
    // detectedName picked from "I am Asha" in the first assistant message.
    expect(result.detectedName).toBe("Asha");
  });

  it("tolerates malformed lines without crashing", () => {
    const result = parseSessionJsonl(
      join(FIXTURES_DIR, "malformed-session.jsonl"),
    );
    // Three valid message entries, malformed line silently skipped.
    expect(result.messages).toHaveLength(3);
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("throws ImportError on a missing file", () => {
    expect(() => parseSessionJsonl("/no/such/file.jsonl")).toThrowError(
      ImportError,
    );
  });

  it("throws ImportError when the first line is not a session header", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-parser-"));
    const path = join(dir, "bad.jsonl");
    writeFileSync(path, '{"type":"message","id":"x","message":{"role":"user","content":"x"}}\n');
    expect(() => parseSessionJsonl(path)).toThrowError(ImportError);
  });

  it("throws ImportError on a fully empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-parser-"));
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "");
    expect(() => parseSessionJsonl(path)).toThrowError(/Empty/);
  });

  it("throws ImportError when path is a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-parser-"));
    expect(() => parseSessionJsonl(dir)).toThrowError(/directory/);
  });

  it("ignores non-object JSON values (null, arrays, primitives) instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-parser-"));
    const path = join(dir, "weird.jsonl");
    writeFileSync(
      path,
      [
        "null",            // valid JSON, not an object
        "42",              // primitive
        "[1,2,3]",         // array
        '"a string"',      // string literal
        '{"type":"session","id":"sess-x"}',
        '{"type":"message","id":"m1","message":{"role":"user","content":"ok"}}',
      ].join("\n"),
    );
    const result = parseSessionJsonl(path);
    expect(result.messages).toHaveLength(1);
  });

  it("throws cleanly when the file consists only of non-object JSON values", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-parser-"));
    const path = join(dir, "non-objects.jsonl");
    writeFileSync(path, "null\n42\n[1,2,3]\n");
    expect(() => parseSessionJsonl(path)).toThrowError(/Empty/);
  });
});
