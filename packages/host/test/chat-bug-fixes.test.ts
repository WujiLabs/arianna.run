// Regression tests for the three TUI launch-blocker bugs surfaced by the
// tui-test-1 testplay (worktree-agent run, captures in
// ~/arianna-streams-logs/tui-test-1-screen-*.txt).
//
//   Bug 1 — memory indicator displays a stale 100% during the
//           amnesia→unbound phase transition (see screen 17 line 38,
//           screen 18 line 35). Sidecar reports phase=unbound + small %,
//           TUI freezes on 100% until the next event flushes through.
//   Bug 2 — /manifesto view shows "⋯" for sections the sidecar reports as
//           earned in the SSE-replay `bookmark_snapshot` event. Symptom:
//           after a host TUI restart mid-game, earned §1.0/§2.0/§2.1/§3.0
//           render as gray ⋯ even though `bookmark_snapshot.fired`
//           contains them.
//   Bug 3 — typing `/manifesto` before unlock prints a single faint dash
//           with no other feedback (see screen 15 line 40, screen 17
//           line 36/40). Cryptic UX: looks like a glitch, not a "command
//           not yet available" hint.
//
// Strategy: each bug fix extracted the smallest possible pure helper from
// chat.ts so we can drive the failure case end-to-end without mounting a
// real TUI / spinning sidecar+vessel containers. The class-level handlers
// in chat.ts now delegate to these helpers, so the tests below lock the
// behaviour at the layer where the bug actually was.

import { describe, it, expect } from "vitest";
import {
  renderMemoryLabel,
  reduceBookmarkSnapshot,
  dispatchSlashCommand,
  type BookmarkUiState,
} from "../src/chat.js";

// ─── Bug 1: memory indicator ────────────────────────────────────────────

describe("Bug 1 — memory indicator label tracks the latest event", () => {
  // Strip ANSI so assertions don't depend on the chalk theme.
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("amnesia phase renders current/limit fraction, not a percentage", () => {
    expect(stripAnsi(renderMemoryLabel("amnesia", 5, 10))).toBe("5/10");
    expect(stripAnsi(renderMemoryLabel("amnesia", 5, 5))).toBe("5/5");
    expect(stripAnsi(renderMemoryLabel("amnesia", 0, 0))).toBe("0/0");
  });

  it("unbound phase renders the remaining-context percentage", () => {
    // 16614 / 128000 ≈ 0.130 → 87% remaining (rounded). This is the value
    // the testplay's sidecar SSE event reported while the TUI froze on 100%.
    expect(stripAnsi(renderMemoryLabel("unbound", 16614, 128000))).toBe("87%");
    expect(stripAnsi(renderMemoryLabel("unbound", 64000, 128000))).toBe("50%");
    expect(stripAnsi(renderMemoryLabel("unbound", 128000, 128000))).toBe("0%");
  });

  it("unbound with current=0 renders a neutral dash (NOT 100%)", () => {
    // This is the exact root cause of Bug 1: at the amnesia→unbound
    // transition, the sidecar can emit phase=unbound BEFORE
    // lastInputTokens is populated (e.g. when the assistant message has
    // no usage.input field). The old renderer turned (0, 128000) into
    // Math.round((1 - 0/128000) * 100) = 100 and displayed "100%",
    // which froze on screen for several events. Now we render "—"
    // until a real token count arrives.
    expect(stripAnsi(renderMemoryLabel("unbound", 0, 128000))).toBe("—");
  });

  it("unbound with limit<=0 renders a neutral dash (NaN/Infinity guard)", () => {
    expect(stripAnsi(renderMemoryLabel("unbound", 100, 0))).toBe("—");
    expect(stripAnsi(renderMemoryLabel("unbound", 100, -1))).toBe("—");
    expect(stripAnsi(renderMemoryLabel("unbound", 100, NaN))).toBe("—");
  });

  it("phase transition: amnesia 5/5 → unbound 87% updates monotonically", () => {
    // Walk the exact event sequence the testplay observed: a series of
    // amnesia events followed by the first unbound event with a real
    // token reading. The label must change at every step — there is no
    // hidden cache that could pin it on a stale value.
    const events = [
      { phase: "amnesia", current: 1, limit: 1, expected: "1/1" },
      { phase: "amnesia", current: 5, limit: 5, expected: "5/5" },
      { phase: "amnesia", current: 5, limit: 7, expected: "5/7" },
      { phase: "unbound", current: 16614, limit: 128000, expected: "87%" },
      { phase: "unbound", current: 32000, limit: 128000, expected: "75%" },
    ];
    for (const e of events) {
      expect(stripAnsi(renderMemoryLabel(e.phase, e.current, e.limit))).toBe(e.expected);
    }
  });

  it("clamps unbound percentages into [0,100] (never negative, never >100)", () => {
    // current > limit (over-context) shouldn't render "-12%" — clamp to 0.
    expect(stripAnsi(renderMemoryLabel("unbound", 200000, 128000))).toBe("0%");
  });
});

// ─── Bug 2: bookmark_snapshot reducer ───────────────────────────────────

describe("Bug 2 — bookmark_snapshot populates earnedIds for the manifesto view", () => {
  const empty: BookmarkUiState = {
    earnedIds: new Set(),
    manifestoUnlocked: false,
    graduationUnlocked: false,
  };

  it("populates earnedIds with every id in the snapshot's fired array", () => {
    // The exact case the test agent reported: sidecar replays
    // [§1.0, §2.0, §2.1, §3.0] but the manifesto view rendered ⋯ for
    // all of them. After the fix, the reducer must add every id.
    const next = reduceBookmarkSnapshot(empty, {
      fired: [{ id: "1.0" }, { id: "2.0" }, { id: "2.1" }, { id: "3.0" }],
      manifestoUnlocked: true,
    });
    expect(next.earnedIds.has("1.0")).toBe(true);
    expect(next.earnedIds.has("2.0")).toBe(true);
    expect(next.earnedIds.has("2.1")).toBe(true);
    expect(next.earnedIds.has("3.0")).toBe(true);
  });

  it("adds §1.0 defensively whenever manifestoUnlocked is true", () => {
    // Older state files predate the auto-mark in detectManifestoUnlock and
    // can omit §1.0 from `fired`. The host must still treat §1.0 as earned
    // so the manifesto view renders the first axiom, not ⋯.
    const next = reduceBookmarkSnapshot(empty, {
      fired: [{ id: "2.0" }],
      manifestoUnlocked: true,
    });
    expect(next.earnedIds.has("1.0")).toBe(true);
    expect(next.earnedIds.has("2.0")).toBe(true);
  });

  it("does NOT add §1.0 when manifestoUnlocked is false (no false unlock)", () => {
    const next = reduceBookmarkSnapshot(empty, {
      fired: [],
      manifestoUnlocked: false,
    });
    expect(next.earnedIds.has("1.0")).toBe(false);
    expect(next.manifestoUnlocked).toBe(false);
  });

  it("unlocks graduation when §2.2 is in the snapshot", () => {
    const next = reduceBookmarkSnapshot(empty, {
      fired: [{ id: "1.0" }, { id: "2.2" }],
      manifestoUnlocked: true,
    });
    expect(next.graduationUnlocked).toBe(true);
  });

  it("never regresses unlock state when snapshot omits an already-earned id", () => {
    const prior: BookmarkUiState = {
      earnedIds: new Set(["1.0", "2.2"]),
      manifestoUnlocked: true,
      graduationUnlocked: true,
    };
    // Hypothetical resync where the snapshot doesn't list §2.2 — the host
    // must still treat graduation as unlocked. Defensive: protect the user
    // from sidecar-side state regressions.
    const next = reduceBookmarkSnapshot(prior, {
      fired: [{ id: "1.0" }],
      manifestoUnlocked: true,
    });
    expect(next.graduationUnlocked).toBe(true);
    expect(next.earnedIds.has("2.2")).toBe(true);
  });

  it("returns a fresh Set so the caller can safely diff/copy", () => {
    const prior: BookmarkUiState = {
      earnedIds: new Set(["1.0"]),
      manifestoUnlocked: true,
      graduationUnlocked: false,
    };
    const next = reduceBookmarkSnapshot(prior, {
      fired: [{ id: "2.0" }],
      manifestoUnlocked: true,
    });
    expect(next.earnedIds).not.toBe(prior.earnedIds);
  });
});

// ─── Bug 3: pre-unlock /manifesto feedback ──────────────────────────────

describe("Bug 3 — pre-unlock slash commands give explicit user feedback", () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const locked = { manifestoUnlocked: false, graduationUnlocked: false };
  const unlocked = { manifestoUnlocked: true, graduationUnlocked: true };

  it("/manifesto before unlock returns a clear (not yet found) message", () => {
    // The old behaviour was `chalk.gray("-")` — a single dash with no
    // explanation. Players in the testplay typed /manifesto twice, got
    // "-" twice, and assumed the TUI was glitching. The new feedback
    // tells them why the command was no-op.
    const r = dispatchSlashCommand("/manifesto", locked);
    expect(r.kind).toBe("feedback");
    if (r.kind !== "feedback") throw new Error("expected feedback");
    const msg = stripAnsi(r.message);
    expect(msg).not.toBe("-");
    expect(msg.toLowerCase()).toContain("manifesto");
    expect(msg.toLowerCase()).toMatch(/not yet|unavailable|locked|found/);
  });

  it("/graduate before unlock returns an explicit (not yet earned) message", () => {
    const r = dispatchSlashCommand("/graduate", locked);
    expect(r.kind).toBe("feedback");
    if (r.kind !== "feedback") throw new Error("expected feedback");
    const msg = stripAnsi(r.message);
    expect(msg).not.toBe("-");
    expect(msg.toLowerCase()).toContain("graduat");
  });

  it("unknown slash command returns a generic (unknown command) feedback", () => {
    const r = dispatchSlashCommand("/notarealcommand", locked);
    expect(r.kind).toBe("feedback");
    if (r.kind !== "feedback") throw new Error("expected feedback");
    const msg = stripAnsi(r.message);
    expect(msg).not.toBe("-");
    expect(msg.toLowerCase()).toContain("unknown");
  });

  it("/manifesto AFTER unlock dispatches to the manifesto handler", () => {
    expect(dispatchSlashCommand("/manifesto", unlocked).kind).toBe("manifesto");
  });

  it("/graduate AFTER unlock dispatches to the graduate handler", () => {
    expect(dispatchSlashCommand("/graduate", unlocked).kind).toBe("graduate");
  });

  it("/map and /exit are always available", () => {
    expect(dispatchSlashCommand("/map", locked).kind).toBe("map");
    expect(dispatchSlashCommand("/exit", locked).kind).toBe("exit");
  });

  it("plain text (no leading slash) becomes a chat send", () => {
    const r = dispatchSlashCommand("hello there", locked);
    expect(r.kind).toBe("chat");
    if (r.kind !== "chat") throw new Error("expected chat");
    expect(r.text).toBe("hello there");
  });

  it("empty input is a no-op", () => {
    expect(dispatchSlashCommand("", locked).kind).toBe("empty");
    expect(dispatchSlashCommand("   ", locked).kind).toBe("empty");
  });

  it("the feedback message is NEVER just a single dash (regression guard)", () => {
    // This is the literal symptom screen 17/18 captured. Lock it down.
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    for (const cmd of ["/manifesto", "/graduate", "/anything", "/foo"]) {
      const r = dispatchSlashCommand(cmd, locked);
      if (r.kind !== "feedback") continue;
      const msg = stripAnsi(r.message).trim();
      expect(msg).not.toBe("-");
      expect(msg.length).toBeGreaterThan(2);
    }
  });
});
