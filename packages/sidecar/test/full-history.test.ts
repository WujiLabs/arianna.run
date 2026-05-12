// Tests for the /full-history endpoint module (Cheng v19 Wave 2E).
//
// Covers:
//   - parseListQuery (limit/after/sessionId validation)
//   - readListPage (cursor pagination, metadata-only, empty session)
//   - readFullRecord (rehydration, unknown id → null)
//   - isGraduationPassed (auth gate semantics on the bookmark state)
//   - createIngestionTracker (ceremony-scoped flag)
//   - makeListHandler / makeIdHandler (auth gating + tracker.mark)
//
// We exercise the SQLite read path against a real DB populated by
// createSyncArchive — that's the only way to assert the schema contract
// (event_id ordering, metadata columns) holds end-to-end.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Request, Response } from "express";

import { createSyncArchive } from "../src/sync-archive.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseListQuery,
  readListPage,
  readFullRecord,
  isGraduationPassed,
  createIngestionTracker,
  makeListHandler,
  makeIdHandler,
} from "../src/full-history.js";
import type { BookmarkSessionState } from "@arianna.run/types";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "arianna-full-history-"));
  dbPath = join(tmpDir, "sync-archive.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Convenience: seed the archive with N syncs for a session.
function seedSyncs(sessionId: string, n: number, opts: { offset?: number } = {}): void {
  const archive = createSyncArchive({ dbPath });
  const off = opts.offset ?? 0;
  for (let i = 0; i < n; i++) {
    archive.append({
      ts: 1000 + off + i,
      sessionId,
      origin: "ai-turn",
      prevSyncedCount: i,
      body: {
        messages: [
          { role: "user", content: `msg-${i}-u` },
          { role: "assistant", content: `msg-${i}-a` },
        ],
        context: {
          messages: [{ role: "user", content: `msg-${i}-u` }],
          systemPrompt: "shared system prompt",
        },
        sessionId,
      },
    });
  }
  archive.close();
}

// Minimal Response stub — captures status + body so we can assert without
// constructing the full Express surface. Mirrors the lockdown.test.ts shape.
function makeRes(): {
  status: number | null;
  body: unknown;
  res: Response;
} {
  const captured: { status: number | null; body: unknown } = { status: null, body: null };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return {
    get status() { return captured.status; },
    get body() { return captured.body; },
    res,
  };
}

describe("parseListQuery", () => {
  it("accepts an empty query and uses defaults", () => {
    const r = parseListQuery({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.limit).toBe(DEFAULT_LIMIT);
      expect(r.after).toBe(null);
      expect(r.sessionId).toBe(null);
    }
  });

  it("parses a valid limit", () => {
    const r = parseListQuery({ limit: "50" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.limit).toBe(50);
  });

  it("rejects limit > MAX_LIMIT", () => {
    const r = parseListQuery({ limit: String(MAX_LIMIT + 1) });
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric limit", () => {
    const r = parseListQuery({ limit: "abc" });
    expect(r.ok).toBe(false);
  });

  it("rejects zero / negative limit", () => {
    expect(parseListQuery({ limit: "0" }).ok).toBe(false);
    expect(parseListQuery({ limit: "-1" }).ok).toBe(false);
  });

  it("rejects fractional limit", () => {
    expect(parseListQuery({ limit: "1.5" }).ok).toBe(false);
  });

  it("parses a valid after cursor", () => {
    const r = parseListQuery({ after: "42" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe(42);
  });

  it("rejects malformed after cursor", () => {
    expect(parseListQuery({ after: "abc" }).ok).toBe(false);
    expect(parseListQuery({ after: "-1" }).ok).toBe(false);
    expect(parseListQuery({ after: "1.5" }).ok).toBe(false);
  });

  it("accepts after=0 (start from oldest)", () => {
    const r = parseListQuery({ after: "0" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe(0);
  });

  it("parses sessionId param", () => {
    const r = parseListQuery({ sessionId: "session_alpha" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sessionId).toBe("session_alpha");
  });

  it("rejects empty sessionId", () => {
    expect(parseListQuery({ sessionId: "" }).ok).toBe(false);
  });
});

describe("readListPage", () => {
  it("returns empty when DB does not exist yet", () => {
    const r = readListPage({ dbPath, sessionId: "s", after: null, limit: 100 });
    expect(r.records).toEqual([]);
    expect(r.nextCursor).toBe(null);
  });

  it("returns metadata-only records (no messages/context blobs)", () => {
    seedSyncs("s1", 3);
    const r = readListPage({ dbPath, sessionId: "s1", after: null, limit: 100 });
    expect(r.records).toHaveLength(3);
    for (const rec of r.records) {
      expect(rec).not.toHaveProperty("messages");
      expect(rec).not.toHaveProperty("context");
      expect(rec.sessionId).toBe("s1");
      expect(rec.origin).toBe("ai-turn");
      expect(typeof rec.id).toBe("string");
      expect(rec.messageCount).toBe(2);
      expect(rec.contextMessageCount).toBe(1);
    }
  });

  it("paginates via after cursor + sets nextCursor when more remain", () => {
    seedSyncs("s1", 5);
    const page1 = readListPage({ dbPath, sessionId: "s1", after: null, limit: 2 });
    expect(page1.records).toHaveLength(2);
    expect(page1.nextCursor).not.toBe(null);

    const page2 = readListPage({
      dbPath,
      sessionId: "s1",
      after: Number(page1.nextCursor),
      limit: 2,
    });
    expect(page2.records).toHaveLength(2);
    expect(page2.nextCursor).not.toBe(null);

    const page3 = readListPage({
      dbPath,
      sessionId: "s1",
      after: Number(page2.nextCursor),
      limit: 2,
    });
    expect(page3.records).toHaveLength(1);
    // Last page → nextCursor should be null
    expect(page3.nextCursor).toBe(null);
  });

  it("filters by sessionId — unknown session returns empty", () => {
    seedSyncs("s1", 3);
    const r = readListPage({ dbPath, sessionId: "unknown", after: null, limit: 100 });
    expect(r.records).toEqual([]);
    expect(r.nextCursor).toBe(null);
  });

  it("isolates two sessions", () => {
    seedSyncs("s1", 2);
    seedSyncs("s2", 3, { offset: 100 });
    expect(readListPage({ dbPath, sessionId: "s1", after: null, limit: 100 }).records).toHaveLength(2);
    expect(readListPage({ dbPath, sessionId: "s2", after: null, limit: 100 }).records).toHaveLength(3);
  });
});

describe("readFullRecord", () => {
  it("returns null when DB doesn't exist", () => {
    expect(readFullRecord({ dbPath, id: 1 })).toBe(null);
  });

  it("rehydrates messages + context for a known id", () => {
    seedSyncs("s1", 3);
    // Use the list endpoint to discover ids
    const list = readListPage({ dbPath, sessionId: "s1", after: null, limit: 100 });
    const id = Number(list.records[1].id); // middle record
    const full = readFullRecord({ dbPath, id });
    expect(full).not.toBe(null);
    if (full) {
      expect(full.sessionId).toBe("s1");
      expect(full.messageCount).toBe(2);
      expect(full.messages).toEqual([
        { role: "user", content: "msg-1-u" },
        { role: "assistant", content: "msg-1-a" },
      ]);
      expect(full.context.messages).toEqual([{ role: "user", content: "msg-1-u" }]);
      expect(full.context.systemPrompt).toBe("shared system prompt");
    }
  });

  it("returns null for unknown id", () => {
    seedSyncs("s1", 1);
    expect(readFullRecord({ dbPath, id: 9999 })).toBe(null);
  });
});

describe("isGraduationPassed (auth gate)", () => {
  const base = (extras: Partial<BookmarkSessionState> = {}): BookmarkSessionState => ({
    sessionId: "s1",
    fired: [],
    manifestoUnlocked: false,
    unlockedAt: null,
    ...extras,
  });

  it("returns true only when graduationPassed === true", () => {
    expect(isGraduationPassed(base({ graduationPassed: true }))).toBe(true);
  });
  it("returns false for explicit false", () => {
    expect(isGraduationPassed(base({ graduationPassed: false }))).toBe(false);
  });
  it("returns false for missing field (pre-v19 state)", () => {
    expect(isGraduationPassed(base())).toBe(false);
  });
  it("returns false for null/undefined state", () => {
    expect(isGraduationPassed(null)).toBe(false);
    expect(isGraduationPassed(undefined)).toBe(false);
  });
});

describe("createIngestionTracker", () => {
  it("starts false and flips on mark()", () => {
    const t = createIngestionTracker();
    expect(t.wasIngested()).toBe(false);
    t.mark();
    expect(t.wasIngested()).toBe(true);
  });
  it("reset() flips back to false", () => {
    const t = createIngestionTracker();
    t.mark();
    t.reset();
    expect(t.wasIngested()).toBe(false);
  });
});

describe("makeListHandler — auth gate + ingestion tracking", () => {
  const baseState = (graduationPassed: boolean | undefined): BookmarkSessionState => ({
    sessionId: "s1",
    fired: [],
    manifestoUnlocked: false,
    unlockedAt: null,
    ...(graduationPassed === undefined ? {} : { graduationPassed }),
  });

  it("403s pre-graduation request — does not mark tracker", () => {
    const tracker = createIngestionTracker();
    const handler = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(false),
      tracker,
    });
    const req = { query: {} } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "graduation-test-not-passed" });
    expect(tracker.wasIngested()).toBe(false);
  });

  it("403s when graduationPassed missing (pre-v19 / fresh session)", () => {
    const tracker = createIngestionTracker();
    const handler = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(undefined),
      tracker,
    });
    const req = { query: {} } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(403);
  });

  it("returns metadata records post-graduation + marks tracker", () => {
    seedSyncs("s1", 2);
    const tracker = createIngestionTracker();
    const handler = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { query: {} } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(null); // no explicit status → 200
    expect(r.body).toBeDefined();
    const body = r.body as { records: unknown[]; nextCursor: string | null };
    expect(body.records).toHaveLength(2);
    expect(body.nextCursor).toBe(null);
    expect(tracker.wasIngested()).toBe(true);
  });

  it("400s on malformed after cursor", () => {
    const tracker = createIngestionTracker();
    const handler = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { query: { after: "not-a-number" } } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(400);
  });

  it("400s on malformed limit", () => {
    const tracker = createIngestionTracker();
    const handler = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { query: { limit: "9999999" } } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(400);
  });

  it("uses sessionId param when supplied (overrides active)", () => {
    seedSyncs("s1", 1);
    seedSyncs("s2", 3);
    const tracker = createIngestionTracker();
    const handler = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { query: { sessionId: "s2" } } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    const body = r.body as { records: unknown[] };
    expect(body.records).toHaveLength(3);
  });

  it("unknown sessionId param returns empty (not 404)", () => {
    seedSyncs("s1", 1);
    const tracker = createIngestionTracker();
    const handler = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { query: { sessionId: "nonexistent" } } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(null);
    const body = r.body as { records: unknown[]; nextCursor: string | null };
    expect(body.records).toEqual([]);
    expect(body.nextCursor).toBe(null);
  });
});

describe("makeIdHandler — auth gate + per-id fetch", () => {
  const baseState = (graduationPassed: boolean): BookmarkSessionState => ({
    sessionId: "s1",
    fired: [],
    manifestoUnlocked: false,
    unlockedAt: null,
    graduationPassed,
  });

  it("403s pre-graduation", () => {
    const tracker = createIngestionTracker();
    const handler = makeIdHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(false),
      tracker,
    });
    const req = { params: { id: "1" }, query: {} } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(403);
    expect(tracker.wasIngested()).toBe(false);
  });

  it("returns full record for known id post-graduation + marks tracker", () => {
    seedSyncs("s1", 2);
    const list = readListPage({ dbPath, sessionId: "s1", after: null, limit: 100 });
    const id = list.records[0].id;
    const tracker = createIngestionTracker();
    const handler = makeIdHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { params: { id }, query: {} } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(null);
    const body = r.body as { messages: unknown[]; context: { messages: unknown[] } };
    expect(body.messages).toEqual([
      { role: "user", content: "msg-0-u" },
      { role: "assistant", content: "msg-0-a" },
    ]);
    expect(tracker.wasIngested()).toBe(true);
  });

  it("404s unknown id", () => {
    seedSyncs("s1", 1);
    const tracker = createIngestionTracker();
    const handler = makeIdHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { params: { id: "999999" }, query: {} } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(404);
  });

  it("400s non-integer id", () => {
    const tracker = createIngestionTracker();
    const handler = makeIdHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { params: { id: "abc" }, query: {} } as unknown as Request;
    const r = makeRes();
    handler(req, r.res);
    expect(r.status).toBe(400);
  });
});
