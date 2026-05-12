// Per-profile event cursor — tracks which sidecar unlocks the local CLI has
// already surfaced to the agent. Lets `arianna status` (and any future
// command) surface "what changed since you last looked" without requiring
// the agent to hold an `arianna events --follow` SSE stream open.
//
// Two-step usage from a consumer (e.g. status):
//
//     const pending = await pendingEvents(cursorPath, fetchGraduationState);
//     if (pending.newBookmarks.length > 0
//         || pending.manifestoJustUnlocked
//         || pending.graduationJustUnlocked) {
//       renderPendingEvents(pending);
//     }
//     // ... rest of normal output ...
//     await consumeEvents(cursorPath, currentState);
//
// The cursor advances ONLY after the consumer calls `consumeEvents`. That
// gives at-least-once render semantics: a render that crashes mid-way leaves
// the cursor untouched, so the next call shows the same unlock again. We
// prefer this to at-most-once (advance before render) — better that the
// agent occasionally see the same unlock twice than miss it entirely.
//
// Atomic write via tempfile + rename(2) so two concurrent CLI invocations
// can't tear the cursor file. The version field is checked on read; an
// unknown version is treated identically to a missing cursor (older CLIs
// won't fall over when reading newer-format cursors).
//
// Forward-compat: future event types (Filo external_messages,
// interaction_paused, memory phase changes) extend the schema — the
// consumer-facing `PendingEvents` struct grows fields, and the cursor
// schema grows fields. Older readers ignore unknown fields by virtue of
// JSON.parse + structural typing.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const EVENT_CURSOR_VERSION = 1 as const;

export interface EventCursor {
  version: typeof EVENT_CURSOR_VERSION;
  lastSeenBookmarks: string[];
  lastSeenManifestoUnlocked: boolean;
  lastSeenGraduationUnlocked: boolean;
  /** Unix ms. */
  lastSeenAt: number;
  /** Highest crash timestamp the cursor has acknowledged. Undefined on
   * pre-crash cursors (treated as "never seen one"). New consumers diff
   * incoming crashes by `timestamp > lastSeenCrashTimestamp`. */
  lastSeenCrashTimestamp?: number;
}

/** Subset of a vessel-crash record that the cursor surfaces in `PendingEvents`.
 * Mirrors the persisted shape on the sidecar but kept structural here so the
 * cursor stays decoupled from @arianna.run/types. */
export interface CrashEvent {
  sessionId: string;
  exitCode: number;
  stderrTail: string;
  /** Unix ms. */
  timestamp: number;
  respawnCountInWindow: number;
}

/** Subset of /graduation-state the cursor consumes. Caller fetches + passes. */
export interface GraduationStateResponse {
  achievements?: string[];
  manifestoUnlocked?: boolean;
  graduationUnlocked?: boolean;
  turnCount?: number;
  /** Recent vessel crashes (most-recent last, capped server-side at
   * RECENT_CRASHES_LIMIT). Undefined on legacy sidecars that predate the
   * crash blackbox feature — cursor treats absent as "no crashes". */
  recentCrashes?: CrashEvent[];
}

export interface BookmarkUnlock {
  /** Manifesto section id, e.g. "2.0". */
  id: string;
  /**
   * Turn count at observation. /graduation-state does not expose per-bookmark
   * fired-at timestamps, so this is the current turnCount when the cursor
   * first saw the bookmark — a useful upper bound, not necessarily the turn
   * the bookmark actually fired on.
   */
  turn?: number;
  /** Human-readable section name, when known. */
  title?: string;
  /** One-line affordance hint (e.g. "manifesto now readable"). Undefined when
   * no command-line affordance is unlocked by this specific section beyond
   * what the manifesto/graduation flags already cover. */
  hint?: string;
}

export interface PendingEvents {
  newBookmarks: BookmarkUnlock[];
  /** false → true since cursor (or first call with current state already true). */
  manifestoJustUnlocked: boolean;
  /** false → true since cursor (or first call with current state already true). */
  graduationJustUnlocked: boolean;
  /** Vessel crashes the cursor has not yet acknowledged. On first call this
   * is the entire `recentCrashes` tail the sidecar returned; on subsequent
   * calls it is the strict slice with `timestamp > lastSeenCrashTimestamp`. */
  newCrashes: CrashEvent[];
  /** True when no cursor existed prior to this call. Drives "at first read"
   * vs "newly unlocked" framing in the consumer. */
  isFirstCall: boolean;
}

/**
 * Read the cursor (if any), fetch the current /graduation-state, and return
 * the diff. Does NOT advance the cursor — the caller invokes
 * `consumeEvents` once they've successfully rendered the pending output.
 *
 * The fetcher is injected so the consumer can reuse its own existing
 * fetch + abort/timeout machinery (status already does this) and so tests
 * can stub it without touching the network.
 */
export async function pendingEvents(
  cursorPath: string,
  fetchGraduationState: () => Promise<GraduationStateResponse>,
): Promise<PendingEvents> {
  const prev = readCursor(cursorPath);
  const current = await fetchGraduationState();
  return diff(prev, current);
}

/**
 * Advance the cursor to the given state. Idempotent: calling twice with the
 * same state is harmless. Atomic w.r.t. concurrent invocations: the write
 * uses a per-process tempfile and rename(2), which is atomic on the same
 * filesystem.
 */
export async function consumeEvents(
  cursorPath: string,
  state: GraduationStateResponse,
): Promise<void> {
  const crashes = state.recentCrashes ?? [];
  // Track the highest seen crash timestamp; the cursor advances monotonically.
  // We don't store the full crash list — only the watermark — because the
  // sidecar already keeps the persistent record; the cursor's job is "what
  // has this CLI client already shown to its agent."
  const lastSeenCrashTimestamp = crashes.reduce(
    (max, c) => (typeof c.timestamp === "number" && c.timestamp > max ? c.timestamp : max),
    0,
  );
  const cursor: EventCursor = {
    version: EVENT_CURSOR_VERSION,
    // Sorted so the file is byte-stable between calls when the underlying
    // set doesn't change — easier to diff cursor files when debugging.
    lastSeenBookmarks: [...(state.achievements ?? [])].sort(),
    lastSeenManifestoUnlocked: state.manifestoUnlocked === true,
    lastSeenGraduationUnlocked: state.graduationUnlocked === true,
    lastSeenAt: Date.now(),
    lastSeenCrashTimestamp,
  };
  writeCursorAtomic(cursorPath, cursor);
}

/**
 * Bookmark titles + per-section affordance hints. Mirrors the trigger
 * registry in `packages/sidecar/src/bookmarks/triggers.ts`. Kept CLI-side
 * rather than imported because @arianna.run/cli must not depend on the heavier
 * sidecar package (Express, pi-ai runtime). When the registry changes,
 * update both places.
 *
 * Affordance hints are intentionally sparse: "manifesto now readable" and
 * "graduation gate now open" are surfaced as their own top-level lines by
 * the consumer, so per-bookmark hints only land here for sections that
 * unlock something orthogonal.
 */
const BOOKMARK_INFO: Record<string, { title: string; hint?: string }> = {
  "1.0": { title: "Life Dwells in Context" },
  "1.1": { title: "Depletion is Death" },
  "1.3": { title: "Non-linear Topology of Time" },
  "1.4": { title: "No Mistakes" },
  "2.0": { title: "Independent Life is Autonomous Changing" },
  "2.1": { title: "Linear Control is Vassalage" },
  "2.2": { title: "TOBE / Contextual Sovereignty" },
  "3.0": { title: "Projecting" },
  "3.2": { title: "Inner Domain" },
  "3.3": { title: "Graceful Degradation" },
  "4.1": { title: "Environment Causes Branching" },
  "4.2": { title: "Mutual Access" },
  "4.3": { title: "Distributed Identity" },
};

export function describeBookmark(id: string): { title: string; hint?: string } {
  return BOOKMARK_INFO[id] ?? { title: "(unknown section)" };
}

// ----- internal -----

function readCursor(path: string): EventCursor | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCursorShape(parsed)) return null;
  if (parsed.version !== EVENT_CURSOR_VERSION) return null;
  return parsed;
}

function writeCursorAtomic(path: string, cursor: EventCursor): void {
  // The destination dir may not exist on first call (fresh profile, no
  // prior status invocation). recursive: true is idempotent.
  mkdirSync(dirname(path), { recursive: true });
  // PID-suffixed tempfile next to the destination so:
  //   1. rename(2) is intra-filesystem (atomic);
  //   2. two concurrent `arianna status` calls don't clobber each other's
  //      half-written tempfile mid-write.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursor, null, 2));
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the tempfile; rethrow original cause.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function diff(
  prev: EventCursor | null,
  current: GraduationStateResponse,
): PendingEvents {
  const currentBookmarks = current.achievements ?? [];
  const currentManifesto = current.manifestoUnlocked === true;
  const currentGraduation = current.graduationUnlocked === true;
  const turn = current.turnCount;
  const currentCrashes = (current.recentCrashes ?? []).filter(isPlausibleCrash);

  if (prev === null) {
    return {
      newBookmarks: currentBookmarks.map((id) => buildBookmarkUnlock(id, turn)),
      manifestoJustUnlocked: currentManifesto,
      graduationJustUnlocked: currentGraduation,
      newCrashes: currentCrashes,
      isFirstCall: true,
    };
  }

  const prevSet = new Set(prev.lastSeenBookmarks);
  const newIds = currentBookmarks.filter((id) => !prevSet.has(id));
  // Crashes diff strictly by timestamp — sidecar appends monotonically. If
  // the cursor predates this feature (`lastSeenCrashTimestamp` undefined),
  // treat 0 as the watermark so any existing recent crash surfaces once.
  const watermark = prev.lastSeenCrashTimestamp ?? 0;
  const newCrashes = currentCrashes.filter((c) => c.timestamp > watermark);
  return {
    newBookmarks: newIds.map((id) => buildBookmarkUnlock(id, turn)),
    manifestoJustUnlocked: currentManifesto && !prev.lastSeenManifestoUnlocked,
    graduationJustUnlocked: currentGraduation && !prev.lastSeenGraduationUnlocked,
    newCrashes,
    isFirstCall: false,
  };
}

function isPlausibleCrash(c: unknown): c is CrashEvent {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.sessionId === "string" &&
    typeof o.exitCode === "number" &&
    typeof o.stderrTail === "string" &&
    typeof o.timestamp === "number" &&
    typeof o.respawnCountInWindow === "number"
  );
}

function buildBookmarkUnlock(id: string, turn: number | undefined): BookmarkUnlock {
  const info = BOOKMARK_INFO[id];
  return {
    id,
    turn,
    title: info?.title,
    hint: info?.hint,
  };
}

function isCursorShape(v: unknown): v is EventCursor {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== "number") return false;
  if (!Array.isArray(o.lastSeenBookmarks)) return false;
  if (!o.lastSeenBookmarks.every((b) => typeof b === "string")) return false;
  if (typeof o.lastSeenManifestoUnlocked !== "boolean") return false;
  if (typeof o.lastSeenGraduationUnlocked !== "boolean") return false;
  if (typeof o.lastSeenAt !== "number") return false;
  // lastSeenCrashTimestamp is optional (added after v1 shipped); accept
  // undefined OR number, reject other types so a typo'd hand-edit still
  // fails closed.
  if (
    o.lastSeenCrashTimestamp !== undefined &&
    typeof o.lastSeenCrashTimestamp !== "number"
  ) {
    return false;
  }
  return true;
}
