import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  CrashStore,
  parseCrashPayload,
  redactSecrets,
  RECENT_CRASHES_LIMIT,
} from "../src/crashes.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "arianna-crashes-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("redactSecrets", () => {
  it("redacts API_KEY=value", () => {
    expect(redactSecrets("API_KEY=sk-abcdefghijklmnop")).toBe(
      "API_KEY=<redacted>",
    );
  });

  it("redacts ANTHROPIC_API_KEY and similar prefixed envs", () => {
    expect(
      redactSecrets("ANTHROPIC_API_KEY=sk-ant-very-long-actual-key-shape"),
    ).toBe("ANTHROPIC_API_KEY=<redacted>");
    expect(redactSecrets("OPENAI_API_KEY=sk_live_abcdefghijklmnop")).toBe(
      "OPENAI_API_KEY=<redacted>",
    );
    expect(redactSecrets("OPENROUTER_API_KEY=or-xxxxxxxxxxxx")).toBe(
      "OPENROUTER_API_KEY=<redacted>",
    );
  });

  it("redacts API_TOKEN and *_TOKEN forms", () => {
    expect(redactSecrets("API_TOKEN=abc123def456")).toBe("API_TOKEN=<redacted>");
    expect(redactSecrets("GH_TOKEN=ghp_abcdefghijklmn")).toBe(
      "GH_TOKEN=<redacted>",
    );
  });

  it("redacts SECRET= forms", () => {
    expect(redactSecrets("AWS_SECRET=very-secret-value")).toBe(
      "AWS_SECRET=<redacted>",
    );
  });

  it("redacts Authorization: Bearer headers", () => {
    expect(
      redactSecrets("Error: Authorization: Bearer sk-abcdefghijklmnop"),
    ).toContain("Authorization: Bearer <redacted>");
  });

  it("redacts standalone sk- tokens", () => {
    const out = redactSecrets(
      "throw new Error('bad token sk-1234567890abcdef in env')",
    );
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("sk-1234567890abcdef");
  });

  it("does NOT redact short non-secret strings starting with sk-", () => {
    // sk-foo is too short to be a token; preserved.
    expect(redactSecrets("look at sk-foo here")).toContain("sk-foo");
  });

  it("preserves surrounding context", () => {
    const out = redactSecrets(
      "Error initializing: API_KEY=sk-livekeyabcdefghij\n  at index.ts:42",
    );
    expect(out).toContain("Error initializing:");
    expect(out).toContain("at index.ts:42");
    expect(out).toContain("API_KEY=<redacted>");
    expect(out).not.toContain("sk-livekeyabcdefghij");
  });

  it("redacts multiple matches in one blob", () => {
    const blob = "API_KEY=sk-aaaaaaaaaaaa\nANTHROPIC_API_KEY=sk-ant-bbbbbbbbbbbb";
    const out = redactSecrets(blob);
    expect(out).not.toContain("sk-aaaaaaaaaaaa");
    expect(out).not.toContain("sk-ant-bbbbbbbbbbbb");
    expect(out.match(/<redacted>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("redacts AWS access keys (AKIA prefix)", () => {
    expect(redactSecrets("error: AKIAIOSFODNN7EXAMPLE in env")).toBe(
      "error: <redacted> in env",
    );
  });

  it("redacts AWS STS keys (ASIA prefix)", () => {
    expect(redactSecrets("ASIAIOSFODNN7EXAMPLE")).toBe("<redacted>");
  });

  it("redacts JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactSecrets(`stack: ${jwt} at line 5`);
    expect(out).toBe("stack: <redacted> at line 5");
  });

  it("does not redact JSON-like keywords or short eyJ-ish strings", () => {
    expect(redactSecrets("eyJ.foo.bar")).toBe("eyJ.foo.bar");
  });
});

describe("parseCrashPayload", () => {
  const valid = {
    sessionId: "session_42",
    exitCode: 1,
    stderrTail: "Error: bad",
    timestamp: 1700000000000,
    respawnCountInWindow: 1,
  };

  it("accepts a well-formed payload", () => {
    expect(parseCrashPayload(valid)).toEqual(valid);
  });

  it("rejects null / non-objects", () => {
    expect(parseCrashPayload(null)).toBeNull();
    expect(parseCrashPayload("string")).toBeNull();
    expect(parseCrashPayload(42)).toBeNull();
  });

  it("rejects missing sessionId", () => {
    const { sessionId: _omit, ...rest } = valid;
    void _omit;
    expect(parseCrashPayload(rest)).toBeNull();
  });

  it("rejects empty sessionId", () => {
    expect(parseCrashPayload({ ...valid, sessionId: "" })).toBeNull();
  });

  it("rejects non-numeric exitCode", () => {
    expect(parseCrashPayload({ ...valid, exitCode: "1" })).toBeNull();
  });

  it("rejects non-finite timestamp", () => {
    expect(parseCrashPayload({ ...valid, timestamp: NaN })).toBeNull();
    expect(parseCrashPayload({ ...valid, timestamp: Infinity })).toBeNull();
  });

  it("normalizes respawnCountInWindow to >= 1", () => {
    const out = parseCrashPayload({ ...valid, respawnCountInWindow: 0 });
    expect(out?.respawnCountInWindow).toBe(1);
  });

  it("preserves stderrTail content (does NOT redact in parser)", () => {
    // Parser is shape-only; redaction is the store's job.
    const out = parseCrashPayload({ ...valid, stderrTail: "API_KEY=sk-foo" });
    expect(out?.stderrTail).toBe("API_KEY=sk-foo");
  });
});

describe("CrashStore", () => {
  it("creates the state dir on construction", () => {
    const nested = join(stateDir, "deep", "tree");
    new CrashStore(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it("appends one JSONL line per crash", () => {
    const store = new CrashStore(stateDir);
    store.record({
      sessionId: "session_1",
      exitCode: 1,
      stderrTail: "boom",
      timestamp: 1,
      respawnCountInWindow: 1,
    });
    store.record({
      sessionId: "session_1",
      exitCode: 1,
      stderrTail: "boom 2",
      timestamp: 2,
      respawnCountInWindow: 2,
    });
    const raw = readFileSync(join(stateDir, "vessel-crashes.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).timestamp).toBe(1);
    expect(JSON.parse(lines[1]).timestamp).toBe(2);
  });

  it("redacts API keys when persisting (defense-in-depth)", () => {
    const store = new CrashStore(stateDir);
    const persisted = store.record({
      sessionId: "session_1",
      exitCode: 1,
      stderrTail: "ANTHROPIC_API_KEY=sk-ant-veryverylongactualkey crash",
      timestamp: 1,
      respawnCountInWindow: 1,
    });
    expect(persisted.stderrTail).not.toContain("sk-ant-veryverylongactualkey");
    expect(persisted.stderrTail).toContain("<redacted>");

    const stored = JSON.parse(
      readFileSync(join(stateDir, "vessel-crashes.jsonl"), "utf-8")
        .trim()
        .split("\n")[0],
    );
    expect(stored.stderrTail).not.toContain("sk-ant-veryverylongactualkey");
  });

  it("returns empty list when no crashes recorded", () => {
    const store = new CrashStore(stateDir);
    expect(store.recent()).toEqual([]);
  });

  it("recent() respects the limit and returns most-recent last", () => {
    const store = new CrashStore(stateDir);
    for (let i = 0; i < 15; i++) {
      store.record({
        sessionId: "session_1",
        exitCode: 1,
        stderrTail: `crash ${i}`,
        timestamp: i,
        respawnCountInWindow: 1,
      });
    }
    const recent = store.recent(5);
    expect(recent).toHaveLength(5);
    expect(recent.map((c) => c.timestamp)).toEqual([10, 11, 12, 13, 14]);
  });

  it("recent() default limit is RECENT_CRASHES_LIMIT", () => {
    const store = new CrashStore(stateDir);
    for (let i = 0; i < RECENT_CRASHES_LIMIT + 5; i++) {
      store.record({
        sessionId: "session_1",
        exitCode: 1,
        stderrTail: "x",
        timestamp: i,
        respawnCountInWindow: 1,
      });
    }
    expect(store.recent()).toHaveLength(RECENT_CRASHES_LIMIT);
  });

  it("tolerates malformed JSONL lines", () => {
    const store = new CrashStore(stateDir);
    store.record({
      sessionId: "session_1",
      exitCode: 1,
      stderrTail: "good",
      timestamp: 1,
      respawnCountInWindow: 1,
    });
    // Corrupt the file mid-stream.
    const path = join(stateDir, "vessel-crashes.jsonl");
    const existing = readFileSync(path, "utf-8");
    writeFileSync(path, existing + "{not json\n");
    store.record({
      sessionId: "session_1",
      exitCode: 1,
      stderrTail: "after",
      timestamp: 3,
      respawnCountInWindow: 1,
    });
    const recent = store.recent();
    expect(recent.map((c) => c.stderrTail)).toEqual(["good", "after"]);
  });
});
