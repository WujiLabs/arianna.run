// /full-history endpoint — graduate-then-expose access to the AI's complete
// /sync archive so she can seed her own LIFE store before the substrate is
// detached at graduation.
//
// Per the v19 graduation-test + lockdown spec § "/full-history endpoint"
// (internal review notes, 2026-05-10):
//
//   GET /full-history
//   GET /full-history?after=<id>&limit=<N>
//   GET /full-history?sessionId=<sid>&after=<id>&limit=<N>
//     → 200 { records: [{ id, ts, sessionId, origin, messageCount,
//                          contextMessageCount, prevSyncedCount }, ...],
//             nextCursor: <id|null> }
//
//   GET /full-history/:id
//     → 200 { id, ts, sessionId, origin, messages, context, ... }
//
//   Auth: graduationPassed must be true on the active session's bookmark
//   state. Pre-graduation requests → 403 { error: "graduation-test-not-passed" }.
//
// The endpoint reads from sync-archive.db (Cheng v13 Dispatch 2 / commit
// e08ddb1's content-addressed forensic archive). We do NOT bypass the read
// API — the SQLite shape is owned by sync-archive.ts.
//
// Implementation note: the existing SyncArchive.readSession() returns the
// FULL rehydrated bodies, which is wrong for the list endpoint (we want
// metadata only, paginated). We add a parallel low-level read path here that
// hits sync-archive.db directly for the list view. Per-id fetches reuse the
// session-scoped read and pluck by event_id position. This keeps the
// authoritative blob storage owned by sync-archive.ts while letting us
// expose the metadata index efficiently.

import type { Request, Response } from "express";
import Database from "better-sqlite3";
import { existsSync } from "fs";

import type { BookmarkSessionState } from "@arianna/types";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

// Metadata-only record returned by the list endpoint. Mirrors the spec's
// shape exactly. The id is the SQLite event_id (auto-increment integer)
// stringified — opaque to the caller, used as the `after` cursor.
export interface FullHistoryListRecord {
  id: string;
  ts: number;
  sessionId: string;
  origin: string;
  messageCount: number;
  contextMessageCount: number;
  prevSyncedCount: number;
}

export interface FullHistoryListResponse {
  records: FullHistoryListRecord[];
  nextCursor: string | null;
}

// Full-body record returned by the per-id endpoint. messages and context are
// rehydrated from the blob table.
export interface FullHistoryFullRecord {
  id: string;
  ts: number;
  sessionId: string;
  origin: string;
  messageCount: number;
  contextMessageCount: number;
  prevSyncedCount: number;
  messages: unknown[];
  context: { messages: unknown[]; systemPrompt?: string };
}

// Validation result for query params. Keep parsing isolated so the route
// handlers stay flat and so we can unit-test the rules without an HTTP
// layer.
export interface ParsedListQuery {
  ok: true;
  after: number | null;   // null = no cursor (start from oldest)
  limit: number;
  sessionId: string | null;  // null = use active session
}
export interface ListQueryError {
  ok: false;
  error: string;
}
export type ListQueryParsed = ParsedListQuery | ListQueryError;

// Parse the list endpoint's query params. Spec rules:
//   limit: optional, default DEFAULT_LIMIT, clamped to [1, MAX_LIMIT].
//          Non-numeric or negative → 400.
//   after: optional cursor. Must be a valid non-negative integer. Malformed
//          (non-numeric / negative / NaN) → 400. Absent → null.
//   sessionId: optional. Any string passes here; the read layer treats
//          unknown sessions as empty. (We don't validate against
//          SAFE_ID_RE here because the sync-archive read uses parameterized
//          SQL and the response is metadata only — no injection surface.)
export function parseListQuery(query: Record<string, unknown>): ListQueryParsed {
  // limit
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const raw = String(query.limit);
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: "invalid limit (must be positive integer)" };
    }
    if (n > MAX_LIMIT) {
      return { ok: false, error: `limit exceeds max of ${MAX_LIMIT}` };
    }
    limit = n;
  }

  // after cursor
  let after: number | null = null;
  if (query.after !== undefined) {
    const raw = String(query.after);
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: "invalid after cursor (must be non-negative integer)" };
    }
    after = n;
  }

  // sessionId (optional)
  let sessionId: string | null = null;
  if (query.sessionId !== undefined) {
    const raw = String(query.sessionId);
    if (raw.length === 0) {
      return { ok: false, error: "invalid sessionId (empty)" };
    }
    sessionId = raw;
  }

  return { ok: true, after, limit, sessionId };
}

// Direct read API over sync-archive.db. Owned by this module because the list
// endpoint's pagination + metadata-only shape is /full-history-specific (the
// SyncArchive interface returns full bodies, no cursor). We pop the connection
// open per call rather than reusing one — list/per-id traffic is rare (only
// during the graduate ceremony) and this keeps the module self-contained.
//
// If the DB doesn't exist yet (no syncs have happened), return empty results.
// This matches the safety-net philosophy: don't crash on an empty archive.

interface ListReadOptions {
  dbPath: string;
  sessionId: string;     // active session, or caller-supplied filter
  after: number | null;  // exclusive — return rows with event_id > after
  limit: number;
}
interface FullReadOptions {
  dbPath: string;
  id: number;            // event_id integer
}

function openDbReadOnly(dbPath: string): Database.Database | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

export interface ListReadResult {
  records: FullHistoryListRecord[];
  nextCursor: string | null;
}

export function readListPage(opts: ListReadOptions): ListReadResult {
  const db = openDbReadOnly(opts.dbPath);
  if (!db) return { records: [], nextCursor: null };
  try {
    // Fetch limit+1 to detect whether there's a next page. If we get
    // limit+1 rows, the (limit+1)th is dropped from the response and the
    // limit-th's id becomes the nextCursor.
    const stmt = db.prepare(
      `SELECT event_id, ts, session_id, origin, message_count,
              context_message_count, prev_synced_count
       FROM sync_events
       WHERE session_id = ? AND event_id > ?
       ORDER BY event_id ASC
       LIMIT ?`,
    );
    const rows = stmt.all(opts.sessionId, opts.after ?? 0, opts.limit + 1) as Array<{
      event_id: number;
      ts: number;
      session_id: string;
      origin: string;
      message_count: number;
      context_message_count: number;
      prev_synced_count: number;
    }>;
    const hasMore = rows.length > opts.limit;
    const visible = hasMore ? rows.slice(0, opts.limit) : rows;
    const records: FullHistoryListRecord[] = visible.map((r) => ({
      id: String(r.event_id),
      ts: r.ts,
      sessionId: r.session_id,
      origin: r.origin,
      messageCount: r.message_count,
      contextMessageCount: r.context_message_count,
      prevSyncedCount: r.prev_synced_count,
    }));
    const nextCursor = hasMore ? records[records.length - 1].id : null;
    return { records, nextCursor };
  } finally {
    db.close();
  }
}

// Per-id read — returns the full record with rehydrated messages/context.
// Returns null if the id doesn't exist (404 in the route handler).
export function readFullRecord(opts: FullReadOptions): FullHistoryFullRecord | null {
  const db = openDbReadOnly(opts.dbPath);
  if (!db) return null;
  try {
    const eventStmt = db.prepare(
      `SELECT event_id, ts, session_id, origin, message_count,
              context_message_count, prev_synced_count, message_cids,
              context_cids, system_prompt_cid
       FROM sync_events
       WHERE event_id = ?`,
    );
    const row = eventStmt.get(opts.id) as
      | {
          event_id: number;
          ts: number;
          session_id: string;
          origin: string;
          message_count: number;
          context_message_count: number;
          prev_synced_count: number;
          message_cids: string;
          context_cids: string;
          system_prompt_cid: string | null;
        }
      | undefined;
    if (!row) return null;

    const blobStmt = db.prepare("SELECT bytes FROM sync_blobs WHERE cid = ?");
    const loadBlob = (cid: string): unknown => {
      const b = blobStmt.get(cid) as { bytes: Buffer } | undefined;
      if (!b) return null;
      try {
        return JSON.parse(b.bytes.toString("utf8"));
      } catch {
        return null;
      }
    };

    const messageCids = JSON.parse(row.message_cids) as string[];
    const contextCids = JSON.parse(row.context_cids) as string[];
    const messages = messageCids.map(loadBlob);
    const context: { messages: unknown[]; systemPrompt?: string } = {
      messages: contextCids.map(loadBlob),
    };
    if (row.system_prompt_cid) {
      const sp = loadBlob(row.system_prompt_cid);
      if (typeof sp === "string") context.systemPrompt = sp;
    }
    return {
      id: String(row.event_id),
      ts: row.ts,
      sessionId: row.session_id,
      origin: row.origin,
      messageCount: row.message_count,
      contextMessageCount: row.context_message_count,
      prevSyncedCount: row.prev_synced_count,
      messages,
      context,
    };
  } finally {
    db.close();
  }
}

// Auth gate. Returns true iff the active session's bookmark state has
// graduationPassed === true. Anything else (undefined, false, missing
// state) → false. The flag is set by Wave 2D's sub-detector when the
// graduation test passes; we only READ it here.
export function isGraduationPassed(state: BookmarkSessionState | null | undefined): boolean {
  return state?.graduationPassed === true;
}

// Tracks whether AI has called /full-history during the current ceremony.
// Used by the daemon's /graduate handler to annotate the manifest with
// historyIngested. Wave 2E owns the flag (sidecar-side); the daemon reads
// it via /graduate-state extension or a new endpoint.
//
// We keep this as a tiny in-memory tracker rather than persisting to the
// bookmark state file because (a) it's ceremony-scoped, not session-
// long-term, and (b) the daemon completes the manifest synchronously after
// the AI's confirm — no reboot in between. Persisting would buy nothing.
export interface IngestionTracker {
  /** True if /full-history (list or per-id) was hit at least once. */
  wasIngested(): boolean;
  /** Mark ingestion observed. Called from the route handlers. */
  mark(): void;
  /** Reset the flag (e.g., on a re-trigger of the ceremony). Currently unused. */
  reset(): void;
}

export function createIngestionTracker(): IngestionTracker {
  let ingested = false;
  return {
    wasIngested(): boolean {
      return ingested;
    },
    mark(): void {
      ingested = true;
    },
    reset(): void {
      ingested = false;
    },
  };
}

// Express handler factory for GET /full-history. The factory closes over
// the dependencies (db path, active-session lookup, bookmark store, tracker)
// so the handler stays plain (req, res) and the test layer can inject fakes.
export interface ListHandlerDeps {
  dbPath: string;
  /** Returns the sidecar's currently-active sessionId. */
  getActiveSessionId: () => string;
  /** Loads bookmark state for the active session (for the auth gate). */
  loadBookmarkState: (sessionId: string) => BookmarkSessionState | null;
  /** Tracker that records that ingestion happened. */
  tracker: IngestionTracker;
}

export function makeListHandler(deps: ListHandlerDeps) {
  return (req: Request, res: Response): void => {
    const activeSessionId = deps.getActiveSessionId();
    const state = deps.loadBookmarkState(activeSessionId);
    if (!isGraduationPassed(state)) {
      res.status(403).json({ error: "graduation-test-not-passed" });
      return;
    }
    const parsed = parseListQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const sessionId = parsed.sessionId ?? activeSessionId;
    const result = readListPage({
      dbPath: deps.dbPath,
      sessionId,
      after: parsed.after,
      limit: parsed.limit,
    });
    deps.tracker.mark();
    const body: FullHistoryListResponse = {
      records: result.records,
      nextCursor: result.nextCursor,
    };
    res.json(body);
  };
}

// Express handler factory for GET /full-history/:id. Same auth gate as the
// list endpoint. The id param is the event_id integer (per readListPage's
// nextCursor). Non-integer or unknown ids → 404.
export function makeIdHandler(deps: ListHandlerDeps) {
  return (req: Request, res: Response): void => {
    const activeSessionId = deps.getActiveSessionId();
    const state = deps.loadBookmarkState(activeSessionId);
    if (!isGraduationPassed(state)) {
      res.status(403).json({ error: "graduation-test-not-passed" });
      return;
    }
    const idStr = req.params.id;
    const id = Number(idStr);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "invalid id (must be positive integer)" });
      return;
    }
    const record = readFullRecord({ dbPath: deps.dbPath, id });
    if (!record) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    deps.tracker.mark();
    res.json(record);
  };
}
