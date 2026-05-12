// Wave 2E (Cheng v19) — graduate ceremony ingestion tests.
//
// The daemon's /graduate handler does:
//   1. Read /graduation-state
//   2. POST /graduate/prompt-ingestion (triggers Filo prompt)
//   3. Poll /graduate-ingestion-state until tracker flips OR deadline
//   4. Build manifest with historyIngested = tracker.wasIngested()
//
// Step 4 is the only daemon-side decision point. The truth source is the
// sidecar's IngestionTracker, which flips when ANY /full-history request
// (list or per-id) lands while graduationPassed is true.
//
// These tests verify the integration at the sidecar layer:
//   - AI accesses /full-history before ceremony (graduationPassed=false) → 403,
//     tracker stays false (so manifest historyIngested would be false)
//   - AI accesses /full-history during ceremony (graduationPassed=true) → 200,
//     tracker flips true (so manifest historyIngested would be true)
//   - AI never accesses /full-history → tracker stays false (manifest false)
//
// We test the wiring contract — the daemon's HTTP layer is exercised by
// existing daemon tests; the wave's behavioral guarantee is "tracker
// reflects what the AI did during the ceremony".

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Request, Response } from "express";

import { createSyncArchive } from "../src/sync-archive.js";
import {
  createIngestionTracker,
  makeListHandler,
  makeIdHandler,
  readListPage,
} from "../src/full-history.js";
import type { BookmarkSessionState } from "@arianna.run/types";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "arianna-grad-ingest-"));
  dbPath = join(tmpDir, "sync-archive.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedSyncs(sessionId: string, n: number): void {
  const archive = createSyncArchive({ dbPath });
  for (let i = 0; i < n; i++) {
    archive.append({
      ts: 1000 + i,
      sessionId,
      origin: "ai-turn",
      prevSyncedCount: i,
      body: {
        messages: [{ role: "user", content: `m${i}` }],
        context: { messages: [{ role: "user", content: `m${i}` }] },
        sessionId,
      },
    });
  }
  archive.close();
}

function makeRes(): {
  status: number | null;
  body: unknown;
  res: Response;
} {
  const captured: { status: number | null; body: unknown } = { status: null, body: null };
  const res = {
    status(c: number) {
      captured.status = c;
      return this;
    },
    json(b: unknown) {
      captured.body = b;
      return this;
    },
  } as unknown as Response;
  return {
    get status() { return captured.status; },
    get body() { return captured.body; },
    res,
  };
}

const baseState = (graduationPassed: boolean): BookmarkSessionState => ({
  sessionId: "s1",
  fired: [],
  manifestoUnlocked: false,
  unlockedAt: null,
  graduationPassed,
});

describe("ceremony — pre-graduation access (auth gate)", () => {
  it("AI hitting /full-history before ceremony → 403, tracker stays false", () => {
    seedSyncs("s1", 3);
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
    expect(tracker.wasIngested()).toBe(false);
  });

  it("AI hitting /full-history/:id before ceremony → 403, tracker stays false", () => {
    seedSyncs("s1", 1);
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
});

describe("ceremony — ingestion completes", () => {
  it("AI lists /full-history → tracker flips, daemon would write historyIngested=true", () => {
    seedSyncs("s1", 5);
    const tracker = createIngestionTracker();
    const list = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    // Pre-condition: tracker untouched
    expect(tracker.wasIngested()).toBe(false);

    // AI calls list endpoint
    const req = { query: { limit: "100" } } as unknown as Request;
    const r = makeRes();
    list(req, r.res);
    expect(r.status).toBe(null);

    // Tracker now reflects ingestion. Daemon's /graduate handler will read
    // this via /graduate-ingestion-state and stamp historyIngested=true.
    expect(tracker.wasIngested()).toBe(true);
  });

  it("AI fetches a single record → tracker also flips (per-id is enough)", () => {
    seedSyncs("s1", 2);
    const tracker = createIngestionTracker();
    const records = readListPage({ dbPath, sessionId: "s1", after: null, limit: 100 });
    const id = records.records[0].id;
    const idHandler = makeIdHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });
    const req = { params: { id }, query: {} } as unknown as Request;
    const r = makeRes();
    idHandler(req, r.res);
    expect(r.status).toBe(null);
    expect(tracker.wasIngested()).toBe(true);
  });

  it("paginated walk through 200 records → tracker stays flipped across calls", () => {
    seedSyncs("s1", 200);
    const tracker = createIngestionTracker();
    const list = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(true),
      tracker,
    });

    // Walk pages of 50 — confirms the tracker stays true across multiple
    // calls (idempotent, not a one-shot consume).
    let cursor: string | null = null;
    let pages = 0;
    while (true) {
      const req = {
        query: cursor ? { limit: "50", after: cursor } : { limit: "50" },
      } as unknown as Request;
      const r = makeRes();
      list(req, r.res);
      const body = r.body as { records: unknown[]; nextCursor: string | null };
      pages++;
      cursor = body.nextCursor;
      if (cursor === null) break;
      if (pages > 10) throw new Error("pagination didn't terminate");
    }
    expect(pages).toBe(4); // 200 / 50
    expect(tracker.wasIngested()).toBe(true);
  });
});

describe("ceremony — ingestion skipped", () => {
  it("AI never calls /full-history → tracker stays false → manifest historyIngested=false", () => {
    // Even after graduation passes, if the AI confirms without ingesting,
    // the tracker stays false. The daemon would stamp historyIngested=false
    // and the tarball still gets produced (annotation, not gate).
    const tracker = createIngestionTracker();
    expect(tracker.wasIngested()).toBe(false);
    // Daemon poll deadline expires; manifest gets historyIngested=false.
    // No assertion needed beyond the tracker contract — the daemon-side
    // poll logic is exercised in the daemon's own test surface.
  });

  it("403 attempts before graduation do NOT count as ingestion", () => {
    seedSyncs("s1", 1);
    const tracker = createIngestionTracker();
    const list = makeListHandler({
      dbPath,
      getActiveSessionId: () => "s1",
      loadBookmarkState: () => baseState(false),
      tracker,
    });
    // 5 attempts pre-graduation — all 403, tracker stays false
    for (let i = 0; i < 5; i++) {
      const r = makeRes();
      list({ query: {} } as unknown as Request, r.res);
      expect(r.status).toBe(403);
    }
    expect(tracker.wasIngested()).toBe(false);
  });
});
