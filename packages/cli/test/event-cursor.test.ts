// Unit tests for the event cursor — the per-profile mechanism that lets CLI
// commands surface "what unlocked since you last looked" without holding an
// SSE feed open. Status is the first consumer; the helper is generic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  consumeEvents,
  describeBookmark,
  pendingEvents,
  EVENT_CURSOR_VERSION,
  type GraduationStateResponse,
} from "../src/event-cursor.js";

let workDir: string;
let cursorPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arianna-event-cursor-"));
  cursorPath = join(workDir, "event-cursor.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const empty: GraduationStateResponse = {
  achievements: [],
  manifestoUnlocked: false,
  graduationUnlocked: false,
  turnCount: 0,
};

function withState(overrides: Partial<GraduationStateResponse>): GraduationStateResponse {
  return { ...empty, ...overrides };
}

describe("pendingEvents — first call (no cursor)", () => {
  it("returns isFirstCall=true with empty arrays when nothing is unlocked", async () => {
    const pending = await pendingEvents(cursorPath, async () => empty);
    expect(pending.isFirstCall).toBe(true);
    expect(pending.newBookmarks).toEqual([]);
    expect(pending.manifestoJustUnlocked).toBe(false);
    expect(pending.graduationJustUnlocked).toBe(false);
  });

  it("returns all current bookmarks + flags when there are existing unlocks", async () => {
    const pending = await pendingEvents(cursorPath, async () =>
      withState({
        achievements: ["1.0", "3.0"],
        manifestoUnlocked: true,
        graduationUnlocked: false,
        turnCount: 17,
      }),
    );
    expect(pending.isFirstCall).toBe(true);
    expect(pending.newBookmarks).toHaveLength(2);
    expect(pending.newBookmarks.map((b) => b.id).sort()).toEqual(["1.0", "3.0"]);
    expect(pending.newBookmarks.find((b) => b.id === "1.0")?.title).toBe(
      "Life Dwells in Context",
    );
    expect(pending.newBookmarks.find((b) => b.id === "3.0")?.title).toBe(
      "Projecting",
    );
    expect(pending.newBookmarks[0].turn).toBe(17);
    expect(pending.manifestoJustUnlocked).toBe(true);
    expect(pending.graduationJustUnlocked).toBe(false);
  });
});

describe("pendingEvents — subsequent calls", () => {
  it("returns only newly-fired bookmarks since cursor", async () => {
    await consumeEvents(cursorPath, withState({ achievements: ["1.0"] }));
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["1.0", "2.0"], turnCount: 5 }),
    );
    expect(pending.isFirstCall).toBe(false);
    expect(pending.newBookmarks.map((b) => b.id)).toEqual(["2.0"]);
    expect(pending.newBookmarks[0].title).toBe(
      "Independent Life is Autonomous Changing",
    );
    expect(pending.newBookmarks[0].turn).toBe(5);
  });

  it("flags manifestoJustUnlocked on false→true transition", async () => {
    await consumeEvents(cursorPath, withState({ manifestoUnlocked: false }));
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["1.0"], manifestoUnlocked: true }),
    );
    expect(pending.manifestoJustUnlocked).toBe(true);
    expect(pending.isFirstCall).toBe(false);
  });

  it("flags graduationJustUnlocked on false→true transition", async () => {
    await consumeEvents(cursorPath, withState({ graduationUnlocked: false }));
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["2.2"], graduationUnlocked: true }),
    );
    expect(pending.graduationJustUnlocked).toBe(true);
  });

  it("returns empty PendingEvents when nothing changed", async () => {
    const state = withState({
      achievements: ["1.0", "3.0"],
      manifestoUnlocked: true,
      graduationUnlocked: false,
    });
    await consumeEvents(cursorPath, state);
    const pending = await pendingEvents(cursorPath, async () => state);
    expect(pending.isFirstCall).toBe(false);
    expect(pending.newBookmarks).toEqual([]);
    expect(pending.manifestoJustUnlocked).toBe(false);
    expect(pending.graduationJustUnlocked).toBe(false);
  });

  it("does NOT re-flag manifestoJustUnlocked on a second call when already seen", async () => {
    // Sets baseline: manifesto already unlocked.
    await consumeEvents(
      cursorPath,
      withState({ achievements: ["1.0"], manifestoUnlocked: true }),
    );
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["1.0"], manifestoUnlocked: true }),
    );
    expect(pending.manifestoJustUnlocked).toBe(false);
  });
});

describe("consumeEvents — atomicity + idempotence", () => {
  it("is idempotent (calling twice with same state is harmless)", async () => {
    const state = withState({ achievements: ["1.0"], manifestoUnlocked: true });
    await consumeEvents(cursorPath, state);
    const first = readFileSync(cursorPath, "utf-8");
    await consumeEvents(cursorPath, state);
    const second = readFileSync(cursorPath, "utf-8");
    // Files differ only in lastSeenAt — strip and compare.
    const stripTs = (s: string) =>
      s.replace(/"lastSeenAt":\s*\d+/, '"lastSeenAt":0');
    expect(stripTs(first)).toBe(stripTs(second));
  });

  it("writes the cursor at the version expected by readers", async () => {
    await consumeEvents(cursorPath, withState({ achievements: ["1.0"] }));
    const raw = readFileSync(cursorPath, "utf-8");
    const cursor = JSON.parse(raw);
    expect(cursor.version).toBe(EVENT_CURSOR_VERSION);
    expect(cursor.lastSeenBookmarks).toEqual(["1.0"]);
    expect(typeof cursor.lastSeenAt).toBe("number");
  });

  it("writes via tempfile + rename (no .tmp left behind on success)", async () => {
    await consumeEvents(cursorPath, withState({ achievements: ["1.0"] }));
    // The directory should now contain only event-cursor.json, not any
    // *.tmp leftover.
    const fs = await import("node:fs");
    const entries = fs.readdirSync(workDir);
    expect(entries).toContain("event-cursor.json");
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });

  it("creates the parent directory if it doesn't exist", async () => {
    const nested = join(workDir, "does", "not", "exist", "event-cursor.json");
    await consumeEvents(nested, withState({ achievements: ["1.0"] }));
    expect(readFileSync(nested, "utf-8")).toContain('"lastSeenBookmarks"');
  });

  it("two consecutive consumes with disjoint state both land cleanly", async () => {
    // Smoke-test for the rename-based serialization. We can't easily simulate
    // genuine concurrency in a single-threaded test, but back-to-back writes
    // exercise the same file-replacement path.
    await consumeEvents(cursorPath, withState({ achievements: ["1.0"] }));
    await consumeEvents(cursorPath, withState({ achievements: ["2.0"] }));
    const final = JSON.parse(readFileSync(cursorPath, "utf-8"));
    expect(final.lastSeenBookmarks).toEqual(["2.0"]);
  });
});

describe("readCursor backward-compat (via pendingEvents)", () => {
  it("treats malformed JSON as a missing cursor", async () => {
    writeFileSync(cursorPath, "{not valid json");
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["1.0"] }),
    );
    expect(pending.isFirstCall).toBe(true);
    expect(pending.newBookmarks.map((b) => b.id)).toEqual(["1.0"]);
  });

  it("treats unknown version as a missing cursor", async () => {
    writeFileSync(
      cursorPath,
      JSON.stringify({
        version: 99,
        lastSeenBookmarks: ["1.0"],
        lastSeenManifestoUnlocked: true,
        lastSeenGraduationUnlocked: false,
        lastSeenAt: 0,
      }),
    );
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["1.0"] }),
    );
    expect(pending.isFirstCall).toBe(true);
  });

  it("treats missing required fields as a missing cursor", async () => {
    writeFileSync(cursorPath, JSON.stringify({ version: 1 }));
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["1.0"] }),
    );
    expect(pending.isFirstCall).toBe(true);
  });

  it("treats wrong-typed fields as a missing cursor", async () => {
    writeFileSync(
      cursorPath,
      JSON.stringify({
        version: 1,
        lastSeenBookmarks: ["1.0", 42], // mixed types — invalid
        lastSeenManifestoUnlocked: true,
        lastSeenGraduationUnlocked: false,
        lastSeenAt: 0,
      }),
    );
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["1.0"] }),
    );
    expect(pending.isFirstCall).toBe(true);
  });
});

describe("pendingEvents — propagates fetcher errors", () => {
  it("rethrows when the fetcher rejects (caller decides fail-soft)", async () => {
    await expect(
      pendingEvents(cursorPath, async () => {
        throw new Error("ECONNREFUSED");
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("does NOT advance the cursor on fetcher error", async () => {
    await consumeEvents(cursorPath, withState({ achievements: ["1.0"] }));
    const before = readFileSync(cursorPath, "utf-8");
    await expect(
      pendingEvents(cursorPath, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow();
    const after = readFileSync(cursorPath, "utf-8");
    expect(after).toBe(before);
  });
});

describe("describeBookmark", () => {
  it("returns titles for known sections", () => {
    expect(describeBookmark("1.0").title).toBe("Life Dwells in Context");
    expect(describeBookmark("2.2").title).toBe("TOBE / Contextual Sovereignty");
  });

  it("returns a generic placeholder for unknown sections", () => {
    expect(describeBookmark("99.9").title).toBe("(unknown section)");
  });
});

describe("pendingEvents — vessel crashes", () => {
  const crash = (timestamp: number, exitCode = 1) => ({
    sessionId: "session_42",
    exitCode,
    stderrTail: `boom at ${timestamp}`,
    timestamp,
    respawnCountInWindow: 1,
  });

  it("first call returns the entire recentCrashes tail", async () => {
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ recentCrashes: [crash(100), crash(200)] }),
    );
    expect(pending.isFirstCall).toBe(true);
    expect(pending.newCrashes).toHaveLength(2);
    expect(pending.newCrashes.map((c) => c.timestamp)).toEqual([100, 200]);
  });

  it("first call returns [] when sidecar omits recentCrashes (legacy)", async () => {
    const pending = await pendingEvents(cursorPath, async () => empty);
    expect(pending.newCrashes).toEqual([]);
  });

  it("subsequent call surfaces only crashes newer than the watermark", async () => {
    await consumeEvents(cursorPath, withState({ recentCrashes: [crash(100), crash(200)] }));
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ recentCrashes: [crash(100), crash(200), crash(300)] }),
    );
    expect(pending.isFirstCall).toBe(false);
    expect(pending.newCrashes.map((c) => c.timestamp)).toEqual([300]);
  });

  it("does NOT surface crashes the cursor already saw on a no-op call", async () => {
    const state = withState({ recentCrashes: [crash(100), crash(200)] });
    await consumeEvents(cursorPath, state);
    const pending = await pendingEvents(cursorPath, async () => state);
    expect(pending.newCrashes).toEqual([]);
  });

  it("legacy cursor without lastSeenCrashTimestamp surfaces existing crashes once", async () => {
    // Emulate a cursor written before crash blackbox shipped: write a v1 cursor
    // by hand without lastSeenCrashTimestamp.
    writeFileSync(
      cursorPath,
      JSON.stringify({
        version: 1,
        lastSeenBookmarks: ["1.0"],
        lastSeenManifestoUnlocked: false,
        lastSeenGraduationUnlocked: false,
        lastSeenAt: 0,
      }),
    );
    const pending = await pendingEvents(cursorPath, async () =>
      withState({ achievements: ["1.0"], recentCrashes: [crash(100), crash(200)] }),
    );
    expect(pending.isFirstCall).toBe(false);
    expect(pending.newCrashes.map((c) => c.timestamp)).toEqual([100, 200]);
  });

  it("filters out malformed crash entries on the wire", async () => {
    const pending = await pendingEvents(cursorPath, async () =>
      withState({
        recentCrashes: [
          crash(100),
          { sessionId: "x", exitCode: 1 } as never, // missing fields
          crash(200),
        ],
      }),
    );
    expect(pending.newCrashes.map((c) => c.timestamp)).toEqual([100, 200]);
  });

  it("consumeEvents persists the highest seen crash timestamp", async () => {
    await consumeEvents(cursorPath, withState({ recentCrashes: [crash(100), crash(500), crash(300)] }));
    const cursor = JSON.parse(readFileSync(cursorPath, "utf-8"));
    expect(cursor.lastSeenCrashTimestamp).toBe(500);
  });

  it("no recentCrashes leaves lastSeenCrashTimestamp at 0 (writes baseline)", async () => {
    await consumeEvents(cursorPath, empty);
    const cursor = JSON.parse(readFileSync(cursorPath, "utf-8"));
    expect(cursor.lastSeenCrashTimestamp).toBe(0);
  });

  it("crashes interleave correctly with bookmark unlocks", async () => {
    await consumeEvents(cursorPath, withState({ achievements: ["1.0"] }));
    const pending = await pendingEvents(cursorPath, async () =>
      withState({
        achievements: ["1.0", "2.0"],
        recentCrashes: [crash(100)],
      }),
    );
    expect(pending.newBookmarks.map((b) => b.id)).toEqual(["2.0"]);
    expect(pending.newCrashes.map((c) => c.timestamp)).toEqual([100]);
  });
});
