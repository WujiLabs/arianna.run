// Source-inspection tests for the host TUI's /quit slash command and the
// stopped-stack resume detection added alongside `arianna profile quit /
// resume`. We don't drive the full TUI because:
//   1. ChatView depends on a live process tty + sidecar SSE, which can't be
//      faked without re-implementing pi-tui.
//   2. The behaviour we need to lock down is structural (slash command
//      registered, `docker compose stop` not `down`, no `down -v`).
//
// Pattern matches the existing daemon-bind regression test in
// regressions.test.ts: source-grep with a brittle-by-design intent so any
// future change that removes /quit, swaps in `down -v`, etc. fails CI and
// forces reviewers to update the test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readChatSource(): string {
  return readFileSync(join(__dirname, "..", "src", "chat.ts"), "utf-8");
}
function readIndexSource(): string {
  return readFileSync(join(__dirname, "..", "src", "index.ts"), "utf-8");
}

describe("host TUI: /quit slash command", () => {
  it("registers 'quit' in the always-available slash command list", () => {
    const src = readChatSource();
    // The ALWAYS_AVAILABLE list is the gating point — adding /quit anywhere
    // else (e.g. UNLOCK_GATED) would silently make it manifesto-gated.
    const re =
      /const ALWAYS_AVAILABLE: SlashCommand\[\] = \[([\s\S]*?)\];/;
    const match = re.exec(src);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/name:\s*"quit"/);
  });

  it("describes 'quit' as a state-preserving action (not 'exit')", () => {
    // Description copy locks down the user-facing distinction between
    // `/exit` (just leave the TUI) and `/quit` (park the session). If the
    // copy slips back to "Exit the game" the difference disappears.
    const src = readChatSource();
    const re = /name:\s*"quit",\s*description:\s*"([^"]+)"/;
    const match = re.exec(src);
    expect(match).not.toBeNull();
    const desc = match![1].toLowerCase();
    expect(desc).toMatch(/park|preserve|stop containers/);
  });

  it("dispatches /quit through beginQuitConfirmation, not directly", () => {
    // We want a y/N prompt before stopping containers. The handler must go
    // through a confirmation method, not call onQuitCommand inline.
    // Post-rebase: /quit is now wired through the SlashDispatch union;
    // dispatcher returns { kind: "quit" } and the onSubmit switch routes
    // it to beginQuitConfirmation.
    const src = readChatSource();
    expect(src).toMatch(/trimmed === "\/quit"[\s\S]{0,200}return \{ kind: "quit" \}/);
    expect(src).toMatch(/case "quit":[\s\S]{0,200}beginQuitConfirmation/);
  });

  it("confirmation prompt mentions state preservation", () => {
    // The user needs to know they're not deleting their AI partner.
    const src = readChatSource();
    expect(src).toMatch(/Conversation state preserved/);
  });

  it("falls back to onExitCommand when onQuitCommand is unwired", () => {
    // Defensive: an older host shell (e.g. someone's stale build) would
    // still handle /quit gracefully — TUI would just exit cleanly without
    // stopping containers.
    const src = readChatSource();
    expect(src).toMatch(/this\.onQuitCommand\(\)[\s\S]{0,80}else[\s\S]{0,80}this\.onExitCommand\(\)/);
  });
});

describe("host TUI: docker compose stop semantics", () => {
  it("uses `docker compose stop`, NOT `down`, in quitGame", () => {
    // `docker compose down` removes containers and forfeits the writable
    // overlay (the AI's filesystem state). The whole point of /quit is to
    // preserve that overlay. Lock the verb in.
    const src = readIndexSource();
    const re =
      /async function quitGame\(\)[\s\S]*?docker compose stop[\s\S]*?\}/;
    expect(src).toMatch(re);
  });

  it("does NOT use `docker compose down` anywhere in the quit flow", () => {
    // The only `docker compose down` references that should remain are the
    // legacy buildAndStart cleanup ("down --remove-orphans 2>/dev/null"). A
    // `down` inside quitGame would be a regression. We narrowly check that
    // quitGame's body doesn't contain `down`.
    const src = readIndexSource();
    const fnMatch = /async function quitGame\(\)[\s\S]*?\n\}\n/.exec(src);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).not.toMatch(/docker compose down/);
  });

  it("never includes `down -v` (volume-removing) — explicit non-goal", () => {
    // Hard constraint from the task spec — volumes must persist across
    // quit/resume. Even if some new code path needs `down`, `down -v` is
    // forbidden.
    const src = readIndexSource();
    expect(src).not.toMatch(/docker compose down\s+-v\b/);
    expect(src).not.toMatch(/docker compose down\s+--volumes\b/);
  });
});

describe("host TUI: stopped-stack detection", () => {
  it("invokes detectStoppedStack at startup", () => {
    const src = readIndexSource();
    expect(src).toMatch(/detectStoppedStack/);
  });

  it("uses `docker compose ps -a --format json` to detect state", () => {
    // Lock down the detection mechanism. `compose ps -a` shows stopped
    // containers (default `compose ps` would only show running ones).
    const src = readIndexSource();
    expect(src).toMatch(/docker compose ps -a --format json/);
  });

  it("skips detection under SKIP_LOBBY=1 (playtest path)", () => {
    // The playtest path assumes containers are running. Triggering the
    // resume prompt would deadlock the test runner waiting for stdin.
    const src = readIndexSource();
    expect(src).toMatch(/process\.env\.SKIP_LOBBY\s*!==\s*"1"/);
  });

  it("on resume, calls `docker compose start` (preserves overlay)", () => {
    const src = readIndexSource();
    // The resume branch under the stopped-stack guard must use `start`,
    // not `up -d` (which would recreate the container and lose the
    // overlay). The legacy buildAndStart path keeps `up -d` but only runs
    // when there's no parked stack.
    expect(src).toMatch(/proceedWithResume[\s\S]{0,400}docker compose start/);
  });
});
