// Tests for the SQLite-backed sync archive (replaces the per-session jsonl
// log). Focus: write semantics (best-effort, never throws), per-message
// content-addressed dedup, and read-back round-trip.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createSyncArchive } from "../src/sync-archive.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "arianna-sync-archive-"));
  dbPath = join(tmpDir, "sync-archive.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sync archive — write + read", () => {
  it("appends a single sync record and reads it back", () => {
    const archive = createSyncArchive({ dbPath });
    archive.append({
      ts: 1000,
      sessionId: "session_a",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: {
        messages: [{ role: "user", content: "hi" }],
        context: { messages: [{ role: "user", content: "hi" }], systemPrompt: "you are X" },
        sessionId: "session_a",
      },
    });

    const records = archive.readSession("session_a");
    expect(records).toHaveLength(1);
    expect(records[0].ts).toBe(1000);
    expect(records[0].origin).toBe("ai-turn");
    expect(records[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(records[0].body.context?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(records[0].body.context?.systemPrompt).toBe("you are X");
    archive.close();
  });

  it("preserves message order across multiple syncs ordered by ts", () => {
    const archive = createSyncArchive({ dbPath });
    archive.append({
      ts: 2000,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: { messages: [{ role: "user", content: "second" }] },
    });
    archive.append({
      ts: 1000,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: { messages: [{ role: "user", content: "first" }] },
    });
    const records = archive.readSession("s1");
    expect(records.map((r) => r.ts)).toEqual([1000, 2000]);
    expect(records[0].body.messages).toEqual([{ role: "user", content: "first" }]);
    expect(records[1].body.messages).toEqual([{ role: "user", content: "second" }]);
    archive.close();
  });

  it("filters by session id (cross-session isolation)", () => {
    const archive = createSyncArchive({ dbPath });
    archive.append({
      ts: 1,
      sessionId: "alpha",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: { messages: [{ id: "A" }] },
    });
    archive.append({
      ts: 2,
      sessionId: "beta",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: { messages: [{ id: "B" }] },
    });
    expect(archive.readSession("alpha")).toHaveLength(1);
    expect(archive.readSession("beta")).toHaveLength(1);
    expect(archive.readSession("missing")).toHaveLength(0);
    archive.close();
  });
});

describe("sync archive — content-addressed dedup", () => {
  it("stores duplicate messages as a single blob (within a sync)", () => {
    const archive = createSyncArchive({ dbPath });
    const dup = { role: "user", content: "same content" };
    archive.append({
      ts: 1,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: { messages: [dup, dup, dup] },
    });
    archive.close();

    const ro = new Database(dbPath, { readonly: true });
    const blobCount = (ro.prepare("SELECT COUNT(*) AS c FROM sync_blobs").get() as { c: number }).c;
    expect(blobCount).toBe(1);
    ro.close();
  });

  it("stores duplicate messages as a single blob (across syncs)", () => {
    const archive = createSyncArchive({ dbPath });
    const m1 = { role: "user", content: "first" };
    const m2 = { role: "assistant", content: "reply" };
    // Sync 1: [m1]
    archive.append({
      ts: 1,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: { messages: [m1] },
    });
    // Sync 2: [m1, m2] — m1 should NOT be re-stored.
    archive.append({
      ts: 2,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 1,
      body: { messages: [m1, m2] },
    });
    // Sync 3: [m1, m2] again — both already known.
    archive.append({
      ts: 3,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 2,
      body: { messages: [m1, m2] },
    });
    archive.close();

    const ro = new Database(dbPath, { readonly: true });
    const blobCount = (ro.prepare("SELECT COUNT(*) AS c FROM sync_blobs").get() as { c: number }).c;
    expect(blobCount).toBe(2);
    const eventCount = (ro.prepare("SELECT COUNT(*) AS c FROM sync_events").get() as { c: number })
      .c;
    expect(eventCount).toBe(3);
    ro.close();
  });

  it("dedups system prompt across syncs (typically the largest single blob)", () => {
    const archive = createSyncArchive({ dbPath });
    const sp = "system prompt that is long and shared across every sync";
    for (let i = 0; i < 10; i++) {
      archive.append({
        ts: i,
        sessionId: "s1",
        origin: "ai-turn",
        prevSyncedCount: i,
        body: {
          messages: [{ role: "user", content: `turn ${i}` }],
          context: { messages: [{ role: "user", content: `turn ${i}` }], systemPrompt: sp },
        },
      });
    }
    archive.close();

    const ro = new Database(dbPath, { readonly: true });
    // Expect: 10 distinct user-message blobs + 1 shared system-prompt blob = 11 blobs.
    // (Each turn's user message is unique per sync, but messages and context.messages
    // share the same text so they collapse to a single blob each.)
    const blobCount = (ro.prepare("SELECT COUNT(*) AS c FROM sync_blobs").get() as { c: number }).c;
    expect(blobCount).toBe(11);
    ro.close();
  });

  it("read-back rehydrates the original message content via blob lookup", () => {
    const archive = createSyncArchive({ dbPath });
    archive.append({
      ts: 1,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: {
        messages: [
          { role: "user", content: "alpha" },
          { role: "assistant", content: "beta" },
        ],
      },
    });
    archive.append({
      ts: 2,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 2,
      body: {
        messages: [
          { role: "user", content: "alpha" },
          { role: "assistant", content: "beta" },
          { role: "user", content: "gamma" },
        ],
      },
    });
    const records = archive.readSession("s1");
    expect(records[0].body.messages).toEqual([
      { role: "user", content: "alpha" },
      { role: "assistant", content: "beta" },
    ]);
    expect(records[1].body.messages).toEqual([
      { role: "user", content: "alpha" },
      { role: "assistant", content: "beta" },
      { role: "user", content: "gamma" },
    ]);
    archive.close();
  });
});

describe("sync archive — best-effort error handling", () => {
  it("does not throw if the DB path can't be opened", () => {
    let captured: { err: Error; ctx: string } | null = null;
    // Path under a file-not-a-directory parent — open() will fail to mkdir.
    const archive = createSyncArchive({
      dbPath: "/dev/null/cannot-open.db",
      onError: (err, ctx) => {
        captured = { err, ctx };
      },
    });
    expect(() =>
      archive.append({
        ts: 1,
        sessionId: "s1",
        origin: "ai-turn",
        prevSyncedCount: 0,
        body: { messages: [] },
      }),
    ).not.toThrow();
    expect(captured).not.toBeNull();
    expect(captured!.ctx).toBe("open");
    expect(archive.readSession("s1")).toEqual([]);
  });

  it("creates the parent directory lazily if it does not exist", () => {
    const nested = join(tmpDir, "deeply", "nested", "sync-archive.db");
    const archive = createSyncArchive({ dbPath: nested });
    archive.append({
      ts: 1,
      sessionId: "s1",
      origin: "ai-turn",
      prevSyncedCount: 0,
      body: { messages: [{ role: "user", content: "x" }] },
    });
    expect(statSync(nested).isFile()).toBe(true);
    archive.close();
  });
});
