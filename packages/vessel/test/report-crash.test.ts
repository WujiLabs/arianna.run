// Unit tests for the vessel-side crash reporter. The runtime caller
// (run.sh) backgrounds and ignores the result; tests pull on the same
// pure functions to verify redaction, tailing, coalescing, and POST shape.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  redactSecrets,
  tailLines,
  decideCoalesce,
  loadState,
  saveState,
  reportCrash,
  parseArgv,
  DEFAULT_TAIL_LINES,
  DEFAULT_WINDOW_MS,
} from "../src/report-crash.js";

let stateDir: string;
let stderrFile: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "vessel-crash-"));
  stderrFile = join(stateDir, "stderr.log");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("redactSecrets", () => {
  it("redacts canonical API_KEY=value forms", () => {
    expect(redactSecrets("API_KEY=sk-12345678abcd")).toBe(
      "API_KEY=<redacted>",
    );
  });

  it("redacts ANTHROPIC_API_KEY/OPENAI_API_KEY/etc", () => {
    expect(
      redactSecrets("ANTHROPIC_API_KEY=sk-ant-realisticprefix-12345678"),
    ).toBe("ANTHROPIC_API_KEY=<redacted>");
    expect(redactSecrets("OPENAI_API_KEY=sk_live_abcdefghijkl")).toBe(
      "OPENAI_API_KEY=<redacted>",
    );
  });

  it("redacts standalone provider tokens", () => {
    const out = redactSecrets("token: sk-1234567890abcdef in body");
    expect(out).not.toContain("sk-1234567890abcdef");
    expect(out).toContain("<redacted>");
  });

  it("preserves non-secret content", () => {
    expect(
      redactSecrets("Error at index.ts:42 — something exploded"),
    ).toBe("Error at index.ts:42 — something exploded");
  });

  it("redacts AWS access keys and JWTs (defense in depth at vessel side)", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("<redacted>");
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecrets(jwt)).toBe("<redacted>");
  });
});

describe("tailLines", () => {
  it("returns the last n lines", () => {
    expect(tailLines("a\nb\nc\nd\ne", 3)).toBe("c\nd\ne");
  });

  it("returns the whole text when n exceeds line count", () => {
    expect(tailLines("a\nb", 10)).toBe("a\nb");
  });

  it("trims a single trailing newline before slicing", () => {
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
  });

  it("returns '' for n <= 0", () => {
    expect(tailLines("a\nb", 0)).toBe("");
    expect(tailLines("a\nb", -1)).toBe("");
  });

  it("handles empty input", () => {
    expect(tailLines("", 5)).toBe("");
  });
});

describe("decideCoalesce", () => {
  const empty = { lastPostedAt: -1, recentCrashes: [] };

  it("first crash always posts with count=1", () => {
    const out = decideCoalesce(empty, 1000, 60_000);
    expect(out.shouldPost).toBe(true);
    expect(out.respawnCountInWindow).toBe(1);
    expect(out.nextState.lastPostedAt).toBe(1000);
  });

  it("second crash inside the window suppresses POST but increments count", () => {
    const first = decideCoalesce(empty, 1000, 60_000);
    const second = decideCoalesce(first.nextState, 30_000, 60_000);
    expect(second.shouldPost).toBe(false);
    expect(second.respawnCountInWindow).toBe(2);
    // last-posted-at is preserved on suppression.
    expect(second.nextState.lastPostedAt).toBe(1000);
  });

  it("crash outside the window posts again", () => {
    const first = decideCoalesce(empty, 1000, 60_000);
    const next = decideCoalesce(first.nextState, 70_000, 60_000);
    expect(next.shouldPost).toBe(true);
    // Only the new crash + any remaining inside the new window.
    expect(next.respawnCountInWindow).toBe(1);
  });

  it("counts include all crashes still inside the rolling window", () => {
    const s1 = decideCoalesce(empty, 1000, 60_000);
    const s2 = decideCoalesce(s1.nextState, 30_000, 60_000);
    const s3 = decideCoalesce(s2.nextState, 50_000, 60_000);
    expect(s3.respawnCountInWindow).toBe(3);
    expect(s3.shouldPost).toBe(false);
    // After the window closes for the original POST (>60s past lastPostedAt),
    // the next crash should POST again.
    const s4 = decideCoalesce(s3.nextState, 70_000, 60_000);
    expect(s4.shouldPost).toBe(true);
    // Crashes at 30s and 50s and 70s are still within the rolling 60s window
    // ending at 70s; the 1s one fell out.
    expect(s4.respawnCountInWindow).toBe(3);
  });

  it("caps the in-memory recent list to prevent unbounded growth", () => {
    let state = empty;
    let now = 0;
    for (let i = 0; i < 1500; i++) {
      now += 1; // very tight loop
      state = decideCoalesce(state, now, 60_000).nextState;
    }
    expect(state.recentCrashes.length).toBeLessThanOrEqual(1000);
  });
});

describe("loadState / saveState", () => {
  it("returns empty state when no file exists", () => {
    const state = loadState(stateDir);
    expect(state.lastPostedAt).toBe(-1);
    expect(state.recentCrashes).toEqual([]);
  });

  it("round-trips through saveState", () => {
    saveState(stateDir, { lastPostedAt: 1234, recentCrashes: [10, 20, 30] });
    const out = loadState(stateDir);
    expect(out.lastPostedAt).toBe(1234);
    expect(out.recentCrashes).toEqual([10, 20, 30]);
  });

  it("treats malformed state as empty (graceful degradation)", () => {
    const path = join(stateDir, "coalesce-state.json");
    writeFileSync(path, "{not valid json");
    const out = loadState(stateDir);
    expect(out.lastPostedAt).toBe(-1);
    expect(out.recentCrashes).toEqual([]);
  });

  it("filters non-numeric entries from recentCrashes", () => {
    const path = join(stateDir, "coalesce-state.json");
    writeFileSync(
      path,
      JSON.stringify({
        lastPostedAt: 100,
        recentCrashes: [1, "two", 3, null, 5],
      }),
    );
    const out = loadState(stateDir);
    expect(out.recentCrashes).toEqual([1, 3, 5]);
  });
});

describe("reportCrash — full path", () => {
  function makeFetch(captures: { url: string; payload: unknown }[]) {
    return vi.fn(async (url: URL | string, init?: { body?: string }) => {
      captures.push({
        url: String(url),
        payload: init?.body ? JSON.parse(init.body) : null,
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  }

  it("posts a redacted payload and persists state", async () => {
    writeFileSync(
      stderrFile,
      [
        "node: cannot find module './missing.js'",
        "API_KEY=sk-shouldbescrubbedabc123",
        "    at index.ts:42",
      ].join("\n"),
    );
    const captures: { url: string; payload: unknown }[] = [];
    const result = await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile,
      stateDir,
      now: () => 1700,
      fetchFn: makeFetch(captures),
    });
    expect(result.posted).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(captures).toHaveLength(1);
    expect(captures[0].url).toBe("http://sidecar:8000/vessel-crash");
    const payload = captures[0].payload as Record<string, unknown>;
    expect(payload.sessionId).toBe("session_42");
    expect(payload.exitCode).toBe(1);
    expect(payload.timestamp).toBe(1700);
    expect(payload.respawnCountInWindow).toBe(1);
    const tail = String(payload.stderrTail);
    expect(tail).not.toContain("sk-shouldbescrubbedabc123");
    expect(tail).toContain("<redacted>");
    expect(tail).toContain("at index.ts:42");

    // State persisted with the new lastPostedAt.
    const persisted = loadState(stateDir);
    expect(persisted.lastPostedAt).toBe(1700);
  });

  it("suppresses second POST inside the window but still tracks count", async () => {
    writeFileSync(stderrFile, "first crash");
    const captures: { url: string; payload: unknown }[] = [];
    const fetchFn = makeFetch(captures);
    const r1 = await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile,
      stateDir,
      now: () => 1000,
      fetchFn,
    });
    expect(r1.posted).toBe(true);
    expect(captures).toHaveLength(1);

    writeFileSync(stderrFile, "second crash");
    const r2 = await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile,
      stateDir,
      now: () => 30_000,
      fetchFn,
    });
    expect(r2.posted).toBe(false);
    expect(r2.suppressed).toBe(true);
    expect(r2.respawnCountInWindow).toBe(2);
    // No additional fetch issued.
    expect(captures).toHaveLength(1);
  });

  it("posts again after the 60s window closes, with the storm count", async () => {
    writeFileSync(stderrFile, "boom");
    const captures: { url: string; payload: unknown }[] = [];
    const fetchFn = makeFetch(captures);

    // 5 crashes 5s apart, only the first POSTs.
    for (let i = 0; i < 5; i++) {
      await reportCrash({
        sidecarBaseUrl: "http://sidecar:8000",
        sessionId: "session_42",
        exitCode: 1,
        stderrFile,
        stateDir,
        now: () => 1000 + i * 5_000,
        fetchFn,
      });
    }
    expect(captures).toHaveLength(1);

    // 70s later the window has closed; this crash POSTs.
    const result = await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile,
      stateDir,
      now: () => 1000 + 70_000,
      fetchFn,
    });
    expect(result.posted).toBe(true);
    expect(captures).toHaveLength(2);
    const payload = captures[1].payload as Record<string, unknown>;
    // The 2 most recent prior crashes (at +20s and +21s into the new window)
    // are still inside the rolling 60s window ending at +70s, plus this one.
    expect(payload.respawnCountInWindow).toBeGreaterThanOrEqual(2);
  });

  it("treats sidecar HTTP errors as non-fatal (returns posted=false)", async () => {
    writeFileSync(stderrFile, "boom");
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    const result = await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile,
      stateDir,
      now: () => 1000,
      fetchFn,
    });
    expect(result.posted).toBe(false);
    // State still updated (lastPostedAt advanced) so a tight retry doesn't
    // double-fire. Trade-off: a failing sidecar means we lose ONE event per
    // window, which is the behavior the run.sh helper expects.
    const state = loadState(stateDir);
    expect(state.lastPostedAt).toBe(1000);
  });

  it("treats fetch rejections as non-fatal (no throw, posted=false)", async () => {
    writeFileSync(stderrFile, "boom");
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const result = await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile,
      stateDir,
      now: () => 1000,
      fetchFn,
    });
    expect(result.posted).toBe(false);
    expect(result.suppressed).toBe(false);
  });

  it("handles a missing stderr file by sending an empty tail", async () => {
    const captures: { url: string; payload: unknown }[] = [];
    await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile: join(stateDir, "no-such-file.log"),
      stateDir,
      now: () => 1000,
      fetchFn: makeFetch(captures),
    });
    expect(captures).toHaveLength(1);
    const payload = captures[0].payload as Record<string, unknown>;
    expect(payload.stderrTail).toBe("");
  });

  it("respects the tailLines option", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    writeFileSync(stderrFile, lines);
    const captures: { url: string; payload: unknown }[] = [];
    await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile,
      stateDir,
      now: () => 1000,
      tailLines: 5,
      fetchFn: makeFetch(captures),
    });
    const tail = String((captures[0].payload as Record<string, unknown>).stderrTail);
    expect(tail.split("\n")).toHaveLength(5);
    expect(tail.split("\n")[0]).toBe("line-95");
    expect(tail.split("\n")[4]).toBe("line-99");
  });

  it("default tail is DEFAULT_TAIL_LINES lines", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    writeFileSync(stderrFile, lines);
    const captures: { url: string; payload: unknown }[] = [];
    await reportCrash({
      sidecarBaseUrl: "http://sidecar:8000",
      sessionId: "session_42",
      exitCode: 1,
      stderrFile,
      stateDir,
      now: () => 1000,
      fetchFn: makeFetch(captures),
    });
    const tail = String((captures[0].payload as Record<string, unknown>).stderrTail);
    expect(tail.split("\n")).toHaveLength(DEFAULT_TAIL_LINES);
  });
});

describe("parseArgv", () => {
  it("parses the standard argv shape", () => {
    const out = parseArgv([
      "--exit-code",
      "1",
      "--stderr-file",
      "/tmp/x",
      "--state-dir",
      "/tmp/s",
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.stderrFile).toBe("/tmp/x");
    expect(out.stateDir).toBe("/tmp/s");
  });

  it("falls back to default state dir when not specified", () => {
    const out = parseArgv(["--exit-code", "0"]);
    expect(out.stateDir).toBe("/tmp/arianna-vessel-crashes");
  });

  it("parses non-zero exit codes including negative", () => {
    expect(parseArgv(["--exit-code", "137"]).exitCode).toBe(137);
  });

  it("treats unknown flags as no-ops", () => {
    const out = parseArgv(["--exit-code", "1", "--garbage", "foo"]);
    expect(out.exitCode).toBe(1);
  });
});

describe("constants sanity", () => {
  it("default window is 60 seconds", () => {
    expect(DEFAULT_WINDOW_MS).toBe(60_000);
  });
  it("default tail is 50", () => {
    expect(DEFAULT_TAIL_LINES).toBe(50);
  });
});

describe("smoke: state file lifecycle", () => {
  it("saveState then loadState round-trips", () => {
    saveState(stateDir, { lastPostedAt: 999, recentCrashes: [1, 2, 3] });
    expect(existsSync(join(stateDir, "coalesce-state.json"))).toBe(true);
    const loaded = loadState(stateDir);
    expect(loaded.lastPostedAt).toBe(999);
    const round = JSON.parse(
      readFileSync(join(stateDir, "coalesce-state.json"), "utf-8"),
    );
    expect(round.lastPostedAt).toBe(999);
  });

  it("saveState writes via tempfile + rename (no .tmp left behind)", async () => {
    saveState(stateDir, { lastPostedAt: 1, recentCrashes: [1] });
    const fs = await import("node:fs");
    const entries = fs.readdirSync(stateDir);
    expect(entries).toContain("coalesce-state.json");
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });
});
