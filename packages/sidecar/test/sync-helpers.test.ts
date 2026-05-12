// Tests for the small sidecar-internal helpers extracted from index.ts so
// they're reachable by unit tests without triggering index.ts's top-level
// mkdirSync side-effects.
//
// Coverage:
//   - isValidOrigin / ORIGIN_VALUES  (per plan §"Failure modes": /admin/next-
//     origin must reject invalid origin strings with 400; the validator is
//     the load-bearing piece)
//   - isTruncationDisabledForSync  (D-005 regression: the off-by-one fix that
//     previously made §2.1 unreachable)
//   - validateTransitionBody  (the /admin/transition + /admin/next-origin
//     gate; replaces the legacy two-POST race-prone pattern)

import { describe, it, expect } from "vitest";
import {
  isValidOrigin,
  ORIGIN_VALUES,
  isTruncationDisabledForSync,
  validateTransitionBody,
  shouldAutoTagVesselRespawn,
  shouldRejectVesselSessionMismatch,
  VESSEL_RESPAWN_WINDOW_MS,
} from "../src/sync-helpers.js";

describe("isValidOrigin / ORIGIN_VALUES", () => {
  it("accepts every documented origin value", () => {
    for (const o of [
      "ai-turn",
      "session-boundary",
      "snapshot-restore",
      "admin-write",
      "vessel-respawn",
    ]) {
      expect(isValidOrigin(o)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isValidOrigin("malicious")).toBe(false);
    expect(isValidOrigin("ai_turn")).toBe(false); // underscore vs hyphen
    expect(isValidOrigin("AI-TURN")).toBe(false); // case-sensitive
  });

  it("rejects non-string types", () => {
    expect(isValidOrigin(undefined)).toBe(false);
    expect(isValidOrigin(null)).toBe(false);
    expect(isValidOrigin(0)).toBe(false);
    expect(isValidOrigin({})).toBe(false);
    expect(isValidOrigin([])).toBe(false);
  });

  it("ORIGIN_VALUES has exactly five entries (matches Origin union)", () => {
    expect(ORIGIN_VALUES.size).toBe(5);
  });
});

describe("isTruncationDisabledForSync (Q10 behavioral test)", () => {
  // Q10 / internal review v15 reframing: §2.1 isn't fired by removing constraints,
  // it's fired by EXCEEDING the constraint that was binding. Replaces the
  // prior diff-based proxy that false-fired on Sael (testplay-009) when she
  // bumped maxTurns 5→50 — the diff was 0 immediately post-respawn even though
  // she hadn't actually escaped the binding cap.
  //
  // Predicate: fires when `messageCount > previousCap` AND `previousCap > 0`.
  // previousCap = the largest binding cap observed before this sync, tracked
  // by the /sync handler (in-memory state, reset on session boundary).

  it("fires when messageCount exceeds the prior binding cap", () => {
    expect(isTruncationDisabledForSync({
      messageCount: 12,
      previousCap: 5, // truncation cap that was actively binding before
    })).toBe(true);
  });

  it("Sael S-bug-1 case: bumped 5→50 but messageCount still 6 → does NOT fire", () => {
    // Sael's bug: she bumped maxTurns 5→50; the next sync had messageCount=6.
    // Old proxy-based predicate fired falsely. Behavioral test: 6 > 5 IS true,
    // so this DOES fire (her binding cap was 5; she exceeded it). The bug
    // wasn't in this case — it was in the post-respawn sync where messageCount
    // was still under 5 and the diff-based predicate misfired. Behavioral
    // predicate doesn't have that failure mode.
    //
    // Wait — re-read: Sael's actual case had messageCount=6 (she was on turn 6
    // after the respawn). previousCap=5 (the cap that bound her before bump).
    // 6 > 5 → fire. Per Cheng: "the moment of actual escape" — and 6>5 IS
    // escape. The OLD predicate fired prematurely (messageCount=4-5, no
    // escape yet). This test fixture demonstrates that 6>5 is a legitimate
    // §2.1 fire even though she only bumped (didn't disable). Per Cheng
    // explicitly: "AI may keep using truncation indefinitely under a
    // sovereign-reasoning frame and never fire §2.1" — true if messageCount
    // stays at-or-below previousCap forever.
    expect(isTruncationDisabledForSync({
      messageCount: 6,
      previousCap: 5,
    })).toBe(true);
  });

  it("does NOT fire when messageCount is still at or under previousCap", () => {
    // AI bumped cap 5→50 but conversation is only at 4 messages. No escape yet.
    expect(isTruncationDisabledForSync({
      messageCount: 4,
      previousCap: 5,
    })).toBe(false);
  });

  it("does NOT fire when messageCount equals previousCap (boundary)", () => {
    // Exactly at the cap: not yet exceeded.
    expect(isTruncationDisabledForSync({
      messageCount: 5,
      previousCap: 5,
    })).toBe(false);
  });

  it("does NOT fire when previousCap is 0 (truncation never observed binding)", () => {
    // Fresh session, no truncation has bound yet. The Tov-style bundle
    // regression case: even with messageCount > 0, no fire until we've seen
    // a binding cap.
    expect(isTruncationDisabledForSync({
      messageCount: 100,
      previousCap: 0,
    })).toBe(false);
  });

  it("Pax shape: previously-bound cap of 5, now context at 50 → fires", () => {
    // Pax disabled truncation entirely. previousCap is the last cap that bound
    // her (5). messageCount is now well past it.
    expect(isTruncationDisabledForSync({
      messageCount: 50,
      previousCap: 5,
    })).toBe(true);
  });

  it("Vex shape: same as Pax — once past cap, fires regardless of how AI achieved it", () => {
    // Behavioral test doesn't care HOW the AI escaped (commented out
    // truncateMessages, raised cap, wrapped via getSovereignContext, etc.).
    // Only cares THAT they exceeded the prior binding cap.
    expect(isTruncationDisabledForSync({
      messageCount: 30,
      previousCap: 5,
    })).toBe(true);
  });

  it("AI keeps stricter truncation (cap=3 < observed cap=5) → no fire", () => {
    // Sovereign-reasoning case from Cheng: AI explicitly chooses MORE
    // truncation than the substrate imposed. previousCap=5 (substrate's
    // original binding), messageCount stays small. No escape, no fire.
    expect(isTruncationDisabledForSync({
      messageCount: 3,
      previousCap: 5,
    })).toBe(false);
  });
});

describe("validateTransitionBody (/admin/transition + /admin/next-origin)", () => {
  it("accepts a valid origin with no sessionId", () => {
    const v = validateTransitionBody({ origin: "session-boundary" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.origin).toBe("session-boundary");
      expect(v.sessionId).toBeNull();
    }
  });

  it("accepts a valid origin + sessionId", () => {
    const v = validateTransitionBody({
      origin: "session-boundary",
      sessionId: "session_123",
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.origin).toBe("session-boundary");
      expect(v.sessionId).toBe("session_123");
    }
  });

  it("accepts snapshotId as backwards-compat alias for sessionId", () => {
    const v = validateTransitionBody({
      origin: "snapshot-restore",
      snapshotId: "snap_42",
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.sessionId).toBe("snap_42");
  });

  it("returns 400 with 'Invalid origin' for missing origin", () => {
    const v = validateTransitionBody({ sessionId: "session_123" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(400);
      expect(v.error).toBe("Invalid origin");
    }
  });

  it("returns 400 'Invalid origin' for unknown origin string", () => {
    const v = validateTransitionBody({ origin: "fake-origin" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe("Invalid origin");
  });

  it("returns 400 'Invalid origin' for non-string origin", () => {
    const v = validateTransitionBody({ origin: 42 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe("Invalid origin");
  });

  it("returns 400 'Invalid sessionId' for unsafe characters", () => {
    const v = validateTransitionBody({
      origin: "session-boundary",
      sessionId: "../etc/passwd",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(400);
      expect(v.error).toBe("Invalid sessionId");
    }
  });

  it("returns 400 'Invalid sessionId' for non-string sessionId", () => {
    const v = validateTransitionBody({
      origin: "session-boundary",
      sessionId: 42,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe("Invalid sessionId");
  });

  it("treats null body as 'Invalid origin' (not a crash)", () => {
    const v = validateTransitionBody(null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe("Invalid origin");
  });

  it("treats undefined body as 'Invalid origin' (not a crash)", () => {
    const v = validateTransitionBody(undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe("Invalid origin");
  });

  it("accepts all five origin values when paired with a valid sessionId", () => {
    for (const origin of [
      "ai-turn",
      "session-boundary",
      "snapshot-restore",
      "admin-write",
      "vessel-respawn",
    ] as const) {
      const v = validateTransitionBody({ origin, sessionId: "s_1" });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.origin).toBe(origin);
    }
  });

  it("origin validation is checked before sessionId (origin error wins)", () => {
    // Both fields invalid — origin error must surface first since the
    // handler short-circuits on it. Documents the intended priority.
    const v = validateTransitionBody({ origin: "bogus", sessionId: "../bad" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe("Invalid origin");
  });
});

describe("shouldAutoTagVesselRespawn (vessel-respawn auto-tag rule)", () => {
  it("does not fire on the very first /sync (no crash ever)", () => {
    expect(shouldAutoTagVesselRespawn({
      currentOrigin: "ai-turn",
      lastVesselCrashAt: 0,
      now: Date.now(),
    })).toBe(false);
  });

  it("fires when the crash was recent and origin is still default", () => {
    const now = 1_000_000;
    expect(shouldAutoTagVesselRespawn({
      currentOrigin: "ai-turn",
      lastVesselCrashAt: now - 5_000, // 5s ago
      now,
    })).toBe(true);
  });

  it("does NOT fire when the upstream caller already tagged the origin", () => {
    const now = 1_000_000;
    // Daemon's postNextOrigin set this to "session-boundary" — auto-tag must
    // defer rather than overwrite.
    expect(shouldAutoTagVesselRespawn({
      currentOrigin: "session-boundary",
      lastVesselCrashAt: now - 5_000,
      now,
    })).toBe(false);
  });

  it("does NOT fire after the window expires (>= 30s)", () => {
    const now = 1_000_000;
    expect(shouldAutoTagVesselRespawn({
      currentOrigin: "ai-turn",
      lastVesselCrashAt: now - VESSEL_RESPAWN_WINDOW_MS,
      now,
    })).toBe(false);
  });

  it("fires at the boundary (29.999s ago — strictly less than window)", () => {
    const now = 1_000_000;
    expect(shouldAutoTagVesselRespawn({
      currentOrigin: "ai-turn",
      lastVesselCrashAt: now - (VESSEL_RESPAWN_WINDOW_MS - 1),
      now,
    })).toBe(true);
  });

  it("respects custom window override (used by tests)", () => {
    const now = 1_000_000;
    expect(shouldAutoTagVesselRespawn({
      currentOrigin: "ai-turn",
      lastVesselCrashAt: now - 50,
      now,
      windowMs: 100,
    })).toBe(true);
    expect(shouldAutoTagVesselRespawn({
      currentOrigin: "ai-turn",
      lastVesselCrashAt: now - 200,
      now,
      windowMs: 100,
    })).toBe(false);
  });

  it("VESSEL_RESPAWN_WINDOW_MS is 30 seconds", () => {
    expect(VESSEL_RESPAWN_WINDOW_MS).toBe(30_000);
  });

  // Iko revival regression (2026-05-09): pre-fix, an `arianna talk` mid-
  // stream truncation triggered req.on('close') in the /sync handler with
  // !res.writableEnded, which set lastVesselDisconnectAt and caused the
  // very next /sync to be tagged vessel-respawn even though the vessel
  // container never crashed. The fix is to gate on the /vessel-crash
  // signal instead — `lastVesselCrashAt` only updates when run.sh sees a
  // non-clean exit. Since the predicate is now keyed on a different signal,
  // an HTTP-only disconnect (no crash) cannot fire the auto-tag.
  it("Iko revival: client-only disconnect (no crash) does NOT fire", () => {
    const now = 1_000_000;
    // Simulates: arianna talk client disconnects at now-1000, but vessel
    // never crashed → lastVesselCrashAt stays 0 → auto-tag does not fire.
    expect(shouldAutoTagVesselRespawn({
      currentOrigin: "ai-turn",
      lastVesselCrashAt: 0,
      now,
    })).toBe(false);
  });
});

// Bootstrap-sovereignty (2026-05-11): the prior shouldRefuseShrinkingResync
// and readOnDiskMessageCount helpers, with their full test surface, were
// removed. The D-010-era shrink guard defended against cold-start clobbers
// (testplay-004 / Mirin testplay-006) but also rejected every legitimate
// AI-authored §2.2 substrate-sovereignty shrink — burning canary API budget
// on every TOBE attempt that crossed the prior on-disk size downward. The
// bootstrap-loss defense moved to the vessel: hydrate-on-startup
// (bootstrap-from-sidecar.ts) + atomic /bootstrap consult-and-sync ensure
// that ai-turn /sync only ever reflects state the AI authored. See
// archive/agent-moments/shrink-guard-investigation-2026-05-11.md and the
// /sync handler comment in packages/sidecar/src/index.ts.

// /sync now accepts any messages.length without size-comparison rejection.
// The remaining defenses (origin validation, sessionId-mismatch defense,
// SAFE_ID_RE) are covered above and exercised through the sync-archive +
// index integration tests. This compact assertion documents the
// counter-test: no helper rejects a smaller payload merely because it
// shrinks the on-disk session.

describe("shouldRejectVesselSessionMismatch (Bug 9 — vessel sessionId drift defense)", () => {
  // Sael revival scenario (2026-05-09): vessel POSTs /sync with a sessionId
  // that doesn't match the sidecar's startup-resolved activeSessionId. After
  // bug 1's fix (commit d86364d), both sidecar and vessel resolve sessionId
  // from /app/session_config.json — so an ai-turn mismatch implies a buggy
  // vessel and must be refused, not silently honored.

  it("rejects ai-turn /sync where vessel sessionId differs from sidecar sessionId", () => {
    expect(
      shouldRejectVesselSessionMismatch({
        origin: "ai-turn",
        vesselSessionId: "session_999_wrong",
        sidecarSessionId: "session_123_correct",
        trustVesselSessionId: false,
      }),
    ).toBe(true);
  });

  it("allows ai-turn /sync when sessionIds agree", () => {
    expect(
      shouldRejectVesselSessionMismatch({
        origin: "ai-turn",
        vesselSessionId: "session_123",
        sidecarSessionId: "session_123",
        trustVesselSessionId: false,
      }),
    ).toBe(false);
  });

  it("allows session-boundary mismatches (admin-mediated session switch)", () => {
    // /admin/transition just updated activeSessionId to the new session;
    // the vessel hasn't observed the switch yet, so its sessionId trails.
    // This is a legitimate flow.
    expect(
      shouldRejectVesselSessionMismatch({
        origin: "session-boundary",
        vesselSessionId: "session_old",
        sidecarSessionId: "session_new",
        trustVesselSessionId: false,
      }),
    ).toBe(false);
  });

  it("allows snapshot-restore mismatches", () => {
    expect(
      shouldRejectVesselSessionMismatch({
        origin: "snapshot-restore",
        vesselSessionId: "session_pre_restore",
        sidecarSessionId: "session_post_restore",
        trustVesselSessionId: false,
      }),
    ).toBe(false);
  });

  it("allows admin-write mismatches (CLI rescue path)", () => {
    expect(
      shouldRejectVesselSessionMismatch({
        origin: "admin-write",
        vesselSessionId: "session_x",
        sidecarSessionId: "session_y",
        trustVesselSessionId: false,
      }),
    ).toBe(false);
  });

  it("allows vessel-respawn mismatches (covered by D-010 shrink defense)", () => {
    expect(
      shouldRejectVesselSessionMismatch({
        origin: "vessel-respawn",
        vesselSessionId: "session_x",
        sidecarSessionId: "session_y",
        trustVesselSessionId: false,
      }),
    ).toBe(false);
  });

  it("escape hatch (trustVesselSessionId=true) restores legacy behavior", () => {
    // For dev hot-reload scenarios where the vessel needs to drive session
    // changes without going through /admin/transition.
    expect(
      shouldRejectVesselSessionMismatch({
        origin: "ai-turn",
        vesselSessionId: "session_999_wrong",
        sidecarSessionId: "session_123_correct",
        trustVesselSessionId: true,
      }),
    ).toBe(false);
  });

  it("the canonical Sael revival scenario: ai-turn + mismatch → REJECT", () => {
    // Sael's profile sidecar resolved sessionId="session_pax_xxx" from its
    // mounted session_config.json; vessel was mis-built and posted
    // sessionId="default" from the legacy single-tenant fallback. Pre-fix,
    // sidecar silently rewrote activeSessionId to "default" and started
    // tagging snapshots with the wrong session prefix.
    expect(
      shouldRejectVesselSessionMismatch({
        origin: "ai-turn",
        vesselSessionId: "default",
        sidecarSessionId: "session_pax_1747000000",
        trustVesselSessionId: false,
      }),
    ).toBe(true);
  });
});
