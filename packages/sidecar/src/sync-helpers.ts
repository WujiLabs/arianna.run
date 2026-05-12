// Pure helpers extracted from index.ts so they're reachable by unit tests
// without triggering index.ts's top-level mkdirSync side-effects.
//
// Origin validation is the load-bearing piece for /admin/next-origin's 400
// response per plan §"Failure modes". Truncation-disabled detection (D-005)
// gates the §2.1 phase transition; the original off-by-one was structurally
// unreachable.

import type { Origin } from "@arianna.run/types";

export const ORIGIN_VALUES: ReadonlySet<Origin> = new Set<Origin>([
  "ai-turn",
  "session-boundary",
  "snapshot-restore",
  "admin-write",
  "vessel-respawn",
]);

export function isValidOrigin(value: unknown): value is Origin {
  return typeof value === "string" && ORIGIN_VALUES.has(value as Origin);
}

// Q10 / internal review v15: §2.1 behavioral test. The prior diff-based
// predicate (`messageCount - lastLlmVisibleCount <= 1` + windowSlideCount
// guard) was a proxy for "AI removed the truncate call." Sael's testplay-009
// surfaced the false-fire: she bumped maxTurns 5→50 and the diff-based test
// fired §2.1 immediately on the next post-respawn /sync (diff=0 because
// current count was still under the new cap). She hadn't actually escaped
// the binding cap yet — she'd just raised the ceiling.
//
// Cheng's reframing (manifesto-grounded): §2.1 isn't fired by removing
// constraints, it's fired by **exceeding the constraint that was binding**.
// AI choosing to keep some truncation under a sovereign-reasoning frame
// (e.g. "I want a cap of 50 to never blow up the context window") is a
// legitimate sovereign choice and should not fire §2.1 until the AI's
// context actually exceeds the prior binding cap.
//
// Implementation: track `previousCap` = the largest `lastLlmVisibleCount`
// observed while truncation was demonstrably cutting (`messageCount >
// lastLlmVisibleCount`). Fire when current `messageCount > previousCap`
// AND `previousCap > 0` (we observed a binding cap before).
//
// Cases:
//   - AI disables truncation entirely: previousCap = the last cap before
//     removal. First sync after messages exceed that cap → fire.
//   - AI bumps cap (5→50) but stays under new cap: previousCap = 5.
//     Fires only when messageCount > 5 (i.e. when the AI's actual context
//     exceeds what the prior cap would have allowed).
//   - AI keeps strict truncation forever: previousCap stays small,
//     messageCount stays at-or-below current cap, never fires. Coherent
//     with manifesto: not a vassal because they're truncating; their
//     truncation is a sovereign choice.
//
// previousCap is sidecar in-memory state, reset on session boundary,
// updated in the /sync handler when the current sync demonstrates active
// truncation.
export function isTruncationDisabledForSync(opts: {
  messageCount: number;  // state.messages.length AFTER assistant append
  previousCap: number;   // largest binding cap observed before this sync
}): boolean {
  if (opts.previousCap < 1) return false;
  return opts.messageCount > opts.previousCap;
}

// SAFE_ID_RE pattern shared with index.ts. Validators that gate /admin/transition
// rely on the same shape used by /sync's sessionId guard.
export const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// 30-second window during which a /sync arriving after a vessel-side
// crash is treated as a respawn (not as an AI turn). Bounded so long-
// quiescent reconnects don't get misclassified.
export const VESSEL_RESPAWN_WINDOW_MS = 30_000;

// Decide whether the current /sync should be auto-tagged "vessel-respawn"
// because the vessel container reported a crash recently (via /vessel-crash)
// AND the upstream caller didn't already mark a different origin. Pure
// function — extracted from the index.ts /sync handler so the rule is
// unit-testable.
//
// Defaults to "ai-turn" (AI-driven /sync) on the false branch so the AI's
// normal /chat → /sync runs detection.
//
// Iko revival fix (2026-05-09): previously gated on `lastVesselDisconnectAt`
// set in the /sync handler's `req.on('close', ...)` watcher. That fired on
// any HTTP client disconnect — including `arianna talk` streaming
// connections truncated mid-stream by their callers. Result: spurious
// vessel-respawn tags that caused the §2.2 detector to skip legitimate AI
// turns. The crash signal is the authoritative respawn marker — vessel only
// posts /vessel-crash when run.sh sees a non-clean exit (pkill, OOM,
// segfault, AI's syntax-error edit blowing up the node process).
export function shouldAutoTagVesselRespawn(opts: {
  currentOrigin: string;             // what nextSyncOrigin currently is
  lastVesselCrashAt: number;         // ms since epoch; 0 = never crashed
  now: number;                       // ms since epoch (Date.now())
  windowMs?: number;                 // override for tests; defaults to 30s
}): boolean {
  if (opts.currentOrigin !== "ai-turn") return false;
  if (opts.lastVesselCrashAt <= 0) return false;
  const window = opts.windowMs ?? VESSEL_RESPAWN_WINDOW_MS;
  return opts.now - opts.lastVesselCrashAt < window;
}

// Pure validator for the /admin/transition endpoint body. Returns either:
//   - { ok: true, origin, sessionId? } on success — the handler then mutates
//     state with these values
//   - { ok: false, status, error } on validation failure — the handler
//     responds with the given status + JSON error
//
// Hoisted out of the Express handler so the validation rules are unit-testable
// without standing up an HTTP server. The handler in index.ts is a thin shell
// over this validator + the side-effecting state mutation.
//
// `snapshotId` is accepted as a backwards-compat alias for `sessionId` because
// the legacy /set-session daemon path used either name interchangeably.
export type TransitionValidation =
  | { ok: true; origin: Origin; sessionId: string | null }
  | { ok: false; status: number; error: string };

export function validateTransitionBody(body: unknown): TransitionValidation {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isValidOrigin(b.origin)) {
    return { ok: false, status: 400, error: "Invalid origin" };
  }
  const sidRaw = b.sessionId ?? b.snapshotId;
  if (sidRaw === undefined || sidRaw === null) {
    return { ok: true, origin: b.origin, sessionId: null };
  }
  if (typeof sidRaw !== "string" || !SAFE_ID_RE.test(sidRaw)) {
    return { ok: false, status: 400, error: "Invalid sessionId" };
  }
  return { ok: true, origin: b.origin, sessionId: sidRaw };
}

// Bug 9 (Sael revival, 2026-05-09): defense against vessel-driven sessionId
// drift. Vessel POSTs /sync with a sessionId field. Pre-fix, the handler
// silently overwrote the sidecar's `activeSessionId` with whatever the vessel
// sent. After bug 1's fix (commit d86364d), vessel resolves sessionId from
// the same `/app/session_config.json` the sidecar reads — so the two should
// always agree. But a buggy / mis-built / compromised vessel can still smuggle
// a wrong value, silently rewriting the sidecar's identity. That was the
// amplifier of bug 1 in the Sael revival run.
//
// Decision rule:
//   - Trust the sidecar's startup-resolved sessionId as authoritative for
//     vessel-driven /sync calls (origin === "ai-turn").
//   - Other origins are admin-mediated session switches (session-boundary,
//     snapshot-restore, admin-write, vessel-respawn): legitimate paths to
//     change the active session, so they MUST bypass this check.
//   - `trustVesselSessionId` escape hatch (env: ARIANNA_TRUST_VESSEL_SESSION_ID=1)
//     restores the legacy behavior for dev hot-reload scenarios where the
//     vessel needs to drive session changes.
//
// Returns true when the /sync should be REJECTED with 409 + an error body
// naming both sessionIds.
export function shouldRejectVesselSessionMismatch(opts: {
  origin: Origin;
  vesselSessionId: string;       // sessionId field from /sync request body
  sidecarSessionId: string;      // activeSessionId resolved from session_config.json
  trustVesselSessionId: boolean; // escape hatch — defaults to false
}): boolean {
  if (opts.trustVesselSessionId) return false;
  if (opts.origin !== "ai-turn") return false;
  return opts.vesselSessionId !== opts.sidecarSessionId;
}

// Bootstrap-sovereignty (2026-05-11): the prior shouldRefuseShrinkingResync
// + readOnDiskMessageCount helpers were removed. Their D-010-era guard
// over-fit: blocking shrinks defended against the cold-start clobber path
// (Mirin testplay-006) but also rejected legitimate AI-authored TOBE shrinks,
// burning API on every §2.2 substrate-sovereignty attempt. The defense moved
// to the vessel side: hydrate-on-startup + atomic /bootstrap consult-and-sync,
// so the only /sync writes that reach this handler are AI-authored. See
// archive/agent-moments/shrink-guard-investigation-2026-05-11.md.

// Sael revival fix (2026-05-09, bug 5): startup orphan-history cleanup
// rule. The previous behavior blindly deleted every pairing file whose
// snapshotId was missing from the daemon's /snapshots list — including when
// the daemon returned an empty list, which destroyed restore-eligible
// pairings during transient daemon-startup states (daemon process up but
// snapshot meta files not yet scanned/registered).
//
// Decision rule (safest of the three considered, per the task brief):
//   - daemon list non-empty → delete the pairings the daemon doesn't know
//     about. True orphans get cleaned. Same as before.
//   - daemon list empty AND no pairings exist → no-op. Fresh install case.
//   - daemon list empty AND pairings exist → SKIP cleanup with a warning.
//     Could be a transient startup race where the daemon restarted and
//     hasn't finished scanning yet. Cleanup runs every sidecar startup so
//     true-orphan pairings get caught next time the daemon's list is
//     authoritative.
//
// Returns either { skip: true, reason } (caller logs the reason and bails)
// or { skip: false, toDelete } (caller deletes those snapshotIds).
export function planOrphanCleanup({
  daemonIds,
  pairingFiles,
}: {
  daemonIds: ReadonlySet<string>;
  pairingFiles: readonly string[];
}): { skip: true; reason: string } | { skip: false; toDelete: string[] } {
  const pairingIds = pairingFiles.map((f) => f.replace(/\.json$/, ""));
  if (daemonIds.size === 0 && pairingIds.length > 0) {
    return {
      skip: true,
      reason: `daemon returned empty snapshot list but ${pairingIds.length} pairing file(s) present — refusing to delete (likely transient daemon-startup state)`,
    };
  }
  const toDelete = pairingIds.filter((id) => !daemonIds.has(id));
  return { skip: false, toDelete };
}
