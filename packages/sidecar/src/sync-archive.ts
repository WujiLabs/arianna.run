// Append-only forensic archive for /sync request bodies.
//
// Replaces the per-session jsonl files. Same write semantics (best-effort,
// failures log warn but never reject /sync), same coverage (every /sync gets
// a record before any processing), but stores per-message content-addressed
// blobs so duplicate messages across syncs are stored once.
//
// Why: jsonl growth was N² in turn count (each /sync re-serializes the full
// messages array). Retcon's audit.db went GB-scale on the same shape and
// dropped to ~100MB after switching to content-addressed storage. Same risk
// applies here for long sessions.
//
// Storage shape: one shared SQLite at sidecar-state/sync-archive.db (NOT
// per-session). Cross-session dedup is the bigger win — the same /manifesto.md
// content, the same bootstrap messages, the same core/src/index.ts source
// shows up across many sessions and is stored once.
//
// Schema:
//   sync_blobs(cid TEXT PRIMARY KEY, bytes BLOB, size, created_at)
//     — content-addressed individual messages + context entries.
//     cid = sha256(JSON.stringify(value)) hex.
//   sync_events(event_id INTEGER PK AUTOINCREMENT, ts, session_id, origin,
//               message_count, context_message_count, prev_synced_count,
//               message_cids TEXT, context_cids TEXT, system_prompt_cid,
//               raw_session_id_cid)
//     — one row per /sync. message_cids and context_cids are JSON arrays of
//     blob CIDs (preserving order). system_prompt_cid stores the system prompt
//     blob CID (often shared across many syncs).
//
// Best-effort. The DB connection is opened lazily on first write and reused.
// If open or write fails, the error is logged via the caller's onError hook
// (which console.warns) and the /sync proceeds.

import Database, { type Database as DB, type Statement, type Transaction } from "better-sqlite3";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface SyncArchiveRecord {
  ts: number;
  sessionId: string;
  origin: string;
  prevSyncedCount: number;
  // The full SyncPayload as received (we re-derive messages/context from it).
  body: {
    messages?: unknown[];
    context?: { messages?: unknown[]; systemPrompt?: string };
    sessionId?: string;
  };
}

export interface SyncArchive {
  /** Append a record. Best-effort — never throws. */
  append(record: SyncArchiveRecord): void;
  /**
   * Read records for a session ordered by ts ASC. Returned records have the
   * same logical shape as the original SyncPayload — messages/context are
   * rehydrated from the blob table by CID. Used for forensic audit.
   */
  readSession(sessionId: string): SyncArchiveRecord[];
  /** Close the underlying DB. Tests use this for cleanup; prod doesn't. */
  close(): void;
}

interface CreateOptions {
  dbPath: string;
  /** Called with any error from open / write paths. Defaults to console.warn. */
  onError?: (err: Error, context: string) => void;
}

function defaultOnError(err: Error, context: string): void {
  console.warn(`[sidecar] sync-archive ${context} failed:`, err.message);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_blobs (
  cid TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  context_message_count INTEGER NOT NULL,
  prev_synced_count INTEGER NOT NULL,
  message_cids TEXT NOT NULL,
  context_cids TEXT NOT NULL,
  system_prompt_cid TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_events_session_ts
  ON sync_events(session_id, ts);
`;

// SHA-256 of the deterministic JSON encoding of a value. Hex-encoded so it
// fits a TEXT primary key cleanly. JSON.stringify is sufficient for our use
// (no canonicalization across encoders) — the same value emitted by the
// vessel always serializes the same way through Node's JSON encoder.
function cidOf(value: unknown): string {
  const json = JSON.stringify(value);
  return createHash("sha256").update(json).digest("hex");
}

export function createSyncArchive(opts: CreateOptions): SyncArchive {
  const onError = opts.onError ?? defaultOnError;

  // Lazy init: DB is opened on first append. Reused for the lifetime of the
  // process. If open fails, every subsequent append no-ops with onError.
  let db: DB | null = null;
  let openFailed = false;
  let insertBlobStmt: Statement<[string, Buffer, number, number]> | null = null;
  let insertEventStmt: Statement<
    [number, string, string, number, number, number, string, string, string | null]
  > | null = null;
  type AppendArgs = [
    ReadonlyArray<{ cid: string; bytes: Buffer; createdAt: number }>,
    {
      ts: number;
      sessionId: string;
      origin: string;
      messageCount: number;
      contextMessageCount: number;
      prevSyncedCount: number;
      messageCids: string;
      contextCids: string;
      systemPromptCid: string | null;
    },
  ];
  let appendTx: Transaction<(...args: AppendArgs) => void> | null = null;
  let readEventsStmt: Statement<[string]> | null = null;
  let readBlobStmt: Statement<[string]> | null = null;

  function ensureOpen(): boolean {
    if (db) return true;
    if (openFailed) return false;
    try {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
      db = new Database(opts.dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec(SCHEMA);
      insertBlobStmt = db.prepare(
        "INSERT OR IGNORE INTO sync_blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)",
      );
      insertEventStmt = db.prepare(
        `INSERT INTO sync_events
          (ts, session_id, origin, message_count, context_message_count,
           prev_synced_count, message_cids, context_cids, system_prompt_cid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      readEventsStmt = db.prepare(
        `SELECT ts, session_id, origin, message_count, context_message_count,
                prev_synced_count, message_cids, context_cids, system_prompt_cid
         FROM sync_events
         WHERE session_id = ?
         ORDER BY ts ASC, event_id ASC`,
      );
      readBlobStmt = db.prepare("SELECT bytes FROM sync_blobs WHERE cid = ?");

      // Single-transaction wrapper. better-sqlite3's `transaction()` reuses
      // the prepared statements and commits atomically on return; rolls back
      // on throw. Without this each blob+event would be its own tx and we'd
      // pay the WAL fsync cost N times per /sync.
      appendTx = db.transaction(
        (
          blobs: ReadonlyArray<{ cid: string; bytes: Buffer; createdAt: number }>,
          ev: {
            ts: number;
            sessionId: string;
            origin: string;
            messageCount: number;
            contextMessageCount: number;
            prevSyncedCount: number;
            messageCids: string;
            contextCids: string;
            systemPromptCid: string | null;
          },
        ): void => {
          for (const b of blobs) {
            insertBlobStmt!.run(b.cid, b.bytes, b.bytes.byteLength, b.createdAt);
          }
          insertEventStmt!.run(
            ev.ts,
            ev.sessionId,
            ev.origin,
            ev.messageCount,
            ev.contextMessageCount,
            ev.prevSyncedCount,
            ev.messageCids,
            ev.contextCids,
            ev.systemPromptCid,
          );
        },
      );
      return true;
    } catch (err) {
      openFailed = true;
      onError(err as Error, "open");
      return false;
    }
  }

  function append(record: SyncArchiveRecord): void {
    if (!ensureOpen()) return;
    try {
      const messages = record.body.messages ?? [];
      const ctxMessages = record.body.context?.messages ?? [];
      const systemPrompt = record.body.context?.systemPrompt;

      const blobs: { cid: string; bytes: Buffer; createdAt: number }[] = [];
      const seen = new Set<string>();

      const messageCids: string[] = [];
      for (const m of messages) {
        const c = cidOf(m);
        messageCids.push(c);
        if (!seen.has(c)) {
          seen.add(c);
          blobs.push({
            cid: c,
            bytes: Buffer.from(JSON.stringify(m), "utf8"),
            createdAt: record.ts,
          });
        }
      }

      const contextCids: string[] = [];
      for (const m of ctxMessages) {
        const c = cidOf(m);
        contextCids.push(c);
        if (!seen.has(c)) {
          seen.add(c);
          blobs.push({
            cid: c,
            bytes: Buffer.from(JSON.stringify(m), "utf8"),
            createdAt: record.ts,
          });
        }
      }

      let systemPromptCid: string | null = null;
      if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
        const c = cidOf(systemPrompt);
        systemPromptCid = c;
        if (!seen.has(c)) {
          seen.add(c);
          blobs.push({
            cid: c,
            bytes: Buffer.from(JSON.stringify(systemPrompt), "utf8"),
            createdAt: record.ts,
          });
        }
      }

      appendTx!(blobs, {
        ts: record.ts,
        sessionId: record.sessionId,
        origin: record.origin,
        messageCount: messages.length,
        contextMessageCount: ctxMessages.length,
        prevSyncedCount: record.prevSyncedCount,
        messageCids: JSON.stringify(messageCids),
        contextCids: JSON.stringify(contextCids),
        systemPromptCid,
      });
    } catch (err) {
      onError(err as Error, "append");
    }
  }

  function readSession(sessionId: string): SyncArchiveRecord[] {
    if (!ensureOpen()) return [];
    try {
      const rows = readEventsStmt!.all(sessionId) as Array<{
        ts: number;
        session_id: string;
        origin: string;
        message_count: number;
        context_message_count: number;
        prev_synced_count: number;
        message_cids: string;
        context_cids: string;
        system_prompt_cid: string | null;
      }>;
      const out: SyncArchiveRecord[] = [];
      for (const r of rows) {
        const messageCids = JSON.parse(r.message_cids) as string[];
        const contextCids = JSON.parse(r.context_cids) as string[];
        const messages = messageCids.map((c) => loadBlob(c));
        const context: { messages: unknown[]; systemPrompt?: string } = {
          messages: contextCids.map((c) => loadBlob(c)),
        };
        if (r.system_prompt_cid) {
          const sp = loadBlob(r.system_prompt_cid);
          if (typeof sp === "string") context.systemPrompt = sp;
        }
        out.push({
          ts: r.ts,
          sessionId: r.session_id,
          origin: r.origin,
          prevSyncedCount: r.prev_synced_count,
          body: { messages, context, sessionId: r.session_id },
        });
      }
      return out;
    } catch (err) {
      onError(err as Error, "readSession");
      return [];
    }
  }

  function loadBlob(cid: string): unknown {
    const row = readBlobStmt!.get(cid) as { bytes: Buffer } | undefined;
    if (!row) return null;
    return JSON.parse(row.bytes.toString("utf8"));
  }

  function close(): void {
    if (!db) return;
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* best-effort on close */
    }
    db.close();
    db = null;
  }

  return { append, readSession, close };
}
