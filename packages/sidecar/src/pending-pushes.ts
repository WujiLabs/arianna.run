// v32-hardening: disk persistence for the pendingFiloMessages queue.
//
// Pre-hardening the queue lived only in memory (see packages/sidecar/src/
// index.ts `pendingFiloMessages`). A sidecar restart with in-flight pushes
// dropped them on the floor — exactly the Aril-wedge failure mode Cheng's
// v33 reply called out:
//
//   "pendingFiloMessages in-memory loss: persist to jsonl on sidecar disk.
//    Survive sidecar restart."
//
// This module mirrors the in-memory queue to a JSONL file
// (<stateDir>/pending-filo-messages.jsonl). The queue is bounded at
// MAX_QUEUE_LENGTH so a full-file rewrite per mutation is cheap (<2 KB at
// max). Every mutation triggers an atomic tempfile+rename rewrite —
// POSIX rename(2) on the same filesystem guarantees readers never see a
// torn file. A stale .tmp from a prior crash is cleaned at load time and
// at constructor time.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "fs";

import type { FiloQueueEntry } from "./filo.js";

// Same cap the in-memory queue already enforces. Kept in this module so
// the persistence layer can prune oversized loads (defensive against an
// operator hand-editing the jsonl with extra lines).
export const PENDING_PUSH_MAX_LENGTH = 10;

export interface PendingPushStoreOpts {
  stateDir: string;
  maxLength?: number;
}

export class PendingPushStore {
  private readonly path: string;
  private readonly tmpPath: string;
  readonly maxLength: number;

  constructor(opts: PendingPushStoreOpts) {
    mkdirSync(opts.stateDir, { recursive: true });
    this.path = `${opts.stateDir}/pending-filo-messages.jsonl`;
    this.tmpPath = `${this.path}.tmp`;
    this.maxLength = opts.maxLength ?? PENDING_PUSH_MAX_LENGTH;
    // Drop any stale .tmp from a previous crash so the next rename
    // doesn't see a leftover partial write.
    try {
      if (existsSync(this.tmpPath)) unlinkSync(this.tmpPath);
    } catch {
      // best-effort
    }
  }

  // Read the persisted queue, return [] on miss/error. Never throws —
  // losing one queue replay is preferable to a sidecar boot crash.
  // Malformed lines are skipped silently (typical cause: torn line from a
  // crash mid-rewrite before .tmp+rename was added; with rename atomicity
  // this should not happen, but we stay tolerant).
  load(): FiloQueueEntry[] {
    if (!existsSync(this.path)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch (err) {
      console.warn(
        "[sidecar] PendingPushStore: load read failed, starting empty:",
        err,
      );
      return [];
    }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const out: FiloQueueEntry[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isValidQueueEntry(parsed)) {
        out.push(parsed);
        if (out.length >= this.maxLength) break;
      }
    }
    return out;
  }

  // Atomically rewrite the queue file. Call after every in-memory
  // mutation (push, shift). Truncates to maxLength defensively even
  // though callers should already enforce the cap.
  save(queue: readonly FiloQueueEntry[]): void {
    const trimmed =
      queue.length > this.maxLength ? queue.slice(-this.maxLength) : queue;
    let body: string;
    if (trimmed.length === 0) {
      body = "";
    } else {
      body = trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n";
    }
    try {
      writeFileSync(this.tmpPath, body);
      renameSync(this.tmpPath, this.path);
    } catch (err) {
      console.warn("[sidecar] PendingPushStore: save failed:", err);
      // Cleanup partial tmp so the next save starts clean.
      try {
        if (existsSync(this.tmpPath)) unlinkSync(this.tmpPath);
      } catch {
        // ignore
      }
    }
  }

  // Test/diagnostic helper: nuke the persisted queue file. Not used in
  // production paths.
  clear(): void {
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
      if (existsSync(this.tmpPath)) unlinkSync(this.tmpPath);
    } catch {
      // ignore
    }
  }
}

// Discriminated-union shape guard. Mirrors the FiloQueueEntry definition
// in filo.ts. Kept inline so the persistence layer doesn't drag in an
// extra dependency just for the type guard.
export function isValidQueueEntry(e: unknown): e is FiloQueueEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  if (o.kind === "ai-bin-send") return typeof o.rawMessage === "string";
  if (o.kind === "direct-hint") return typeof o.body === "string";
  return false;
}
