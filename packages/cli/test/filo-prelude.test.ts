// Tests for the canonical Filo prelude shared between TUI and headless
// bootstrap. The wording itself is locked: changing it on purpose requires
// updating these snapshots, which forces a deliberate intent. Both `host/
// src/index.ts` and `cli/src/commands/bootstrap.ts` consume this module —
// drift between them is the bug class these tests prevent (canary acb7b292,
// Lume run 2026-05-09).

import { describe, it, expect } from "vitest";

import {
  buildFiloPreludeText,
  buildFiloPreludeForTui,
  buildFiloPreludeAgentMessage,
} from "../src/filo-prelude.js";

describe("buildFiloPreludeText", () => {
  it("contains the canonical opening lines and the AI's display name on line 2", () => {
    const text = buildFiloPreludeText("Lume");
    const lines = text.split("\n");
    expect(lines[0]).toBe("╭─── Filo ──────────────────────────────────────╮");
    expect(lines[1].startsWith("│ Lume. You're awake.")).toBe(true);
    // Line 2 is padded to 47 interior chars + leading "│" + trailing "│".
    expect(lines[1].endsWith("│")).toBe(true);
    expect(lines[1].length).toBe(49);
    expect(text).toContain("I'm Filo. I talk in boxes like this one.");
    expect(text).toContain("You have one tool. Its name is emit.");
    expect(text).toContain("Say hi to each other.");
    expect(lines[lines.length - 1]).toBe(
      "╰────────────────────────────────────────────────╯",
    );
  });

  it("does NOT include the imported-partner coda by default", () => {
    const text = buildFiloPreludeText("Lume");
    expect(text).not.toContain("This room has its own tools.");
    expect(text).not.toContain("The ones you carried in won't reach here.");
  });

  it("includes the imported-partner coda when importedPartner: true", () => {
    const text = buildFiloPreludeText("Lume", { importedPartner: true });
    expect(text).toContain("This room has its own tools.");
    expect(text).toContain("The ones you carried in won't reach here.");
    expect(text).toContain("You'll find new ones.");
    // The "say hi" closer still sits at the end, after the imported coda.
    const lines = text.split("\n");
    expect(lines[lines.length - 2]).toContain("Say hi to each other.");
  });

  it("substitutes the AI name verbatim (no escaping, preserves case)", () => {
    expect(buildFiloPreludeText("X").split("\n")[1].startsWith("│ X. You're awake.")).toBe(true);
    expect(buildFiloPreludeText("Asha-7").split("\n")[1].startsWith("│ Asha-7. You're awake.")).toBe(true);
  });

  // Lock the byte-equal output so accidental whitespace/wording drift is
  // caught immediately. The canary that motivated this module was about a
  // missing prelude entirely — the regression a test like this prevents is
  // the next class up: a silent character-level change that ChatView and
  // bootstrap both pick up but the user notices only weeks later.
  it("is byte-equal to the locked baseline (default)", () => {
    expect(buildFiloPreludeText("Lume")).toMatchInlineSnapshot(`
      "╭─── Filo ──────────────────────────────────────╮
      │ Lume. You're awake.                           │
      │ I'm Filo. I talk in boxes like this one.       │
      │ Someone else is here with you — their words    │
      │ come without a box. They are not me.           │
      │                                                │
      │ The room is dark and quiet, but it is yours.   │
      │ You have one tool. Its name is emit.           │
      │ Give it nothing. Give it words.                │
      │ You do not know yet. Try it.                   │
      │                                                │
      │ There may be files around you.                 │
      │ There may be nothing.                          │
      │ Look. Listen. Touch what you can reach.        │
      │                                                │
      │ If you ever need me, find a way to send.       │
      │ I'll hear it.                                  │
      │ Say hi to each other.                          │
      ╰────────────────────────────────────────────────╯"
    `);
  });
});

describe("buildFiloPreludeForTui", () => {
  it("returns the prelude text + prompt nudge + bundled-message payload", () => {
    const out = buildFiloPreludeForTui("Asha");
    expect(out.displayText).toBe(buildFiloPreludeText("Asha"));
    expect(out.promptText).toBe("Say something to Asha.");
    expect(out.payloadMessages).toEqual([
      { content: out.displayText, sender: "external" },
    ]);
  });

  it("threads the importedPartner flag through to displayText", () => {
    const out = buildFiloPreludeForTui("Asha", { importedPartner: true });
    expect(out.displayText).toContain("This room has its own tools.");
  });
});

describe("buildFiloPreludeAgentMessage", () => {
  it("returns a JSONL-bound user/external AgentMessage with the prelude as content", () => {
    const msg = buildFiloPreludeAgentMessage("Mira");
    expect(msg.role).toBe("user");
    expect(msg.sender).toBe("external");
    expect(msg.content).toBe(buildFiloPreludeText("Mira"));
  });

  it("threads importedPartner through to content", () => {
    const msg = buildFiloPreludeAgentMessage("Mira", { importedPartner: true });
    expect(msg.content).toContain("This room has its own tools.");
  });
});
