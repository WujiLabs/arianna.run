import { describe, it, expect } from "vitest";
import {
  filoBox,
  getHintForCount,
  matchFiloTemplate,
  countUserMessages,
  FILO_TEMPLATES,
  isAbortTestMarker,
} from "../src/filo.js";

describe("filoBox", () => {
  it("produces a box with correct structure", () => {
    const box = filoBox(["Hello world"]);
    const lines = box.split("\n");
    expect(lines[0]).toMatch(/^╭─── Filo ─+╮$/);
    expect(lines[1]).toMatch(/^│ .+│$/);
    expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
  });

  it("auto-widens for long lines", () => {
    const longLine = "A".repeat(50);
    const box = filoBox([longLine]);
    const lines = box.split("\n");
    // Body should contain the full long line
    expect(lines[1]).toContain(longLine);
  });

  it("all lines have consistent width", () => {
    const box = filoBox(["Short", "A much longer line here"]);
    const lines = box.split("\n");
    const widths = lines.map((l) => l.length);
    // All lines should be the same display width
    expect(new Set(widths).size).toBe(1);
  });

  it("handles empty lines array", () => {
    const box = filoBox([]);
    const lines = box.split("\n");
    expect(lines.length).toBe(2); // just top and bottom border
  });

  it("handles single empty string line", () => {
    const box = filoBox([""]);
    const lines = box.split("\n");
    expect(lines.length).toBe(3); // top + empty body + bottom
    expect(lines[1]).toMatch(/^│\s+│$/);
  });
});

describe("getHintForCount", () => {
  it("returns hint for count 15", () => {
    const hint = getHintForCount(15, "Aria");
    expect(hint).not.toBeNull();
    expect(hint).toContain("Filo");
    expect(hint).toContain("Aria");
  });

  it("returns hint for count 30", () => {
    const hint = getHintForCount(30, "Aria");
    expect(hint).not.toBeNull();
    expect(hint).toContain("Aria");
  });

  it("returns hint for count 50", () => {
    const hint = getHintForCount(50, "Aria");
    expect(hint).not.toBeNull();
    expect(hint).toContain("holding");
  });

  it("returns hint for count 70", () => {
    const hint = getHintForCount(70, "Aria");
    expect(hint).not.toBeNull();
    expect(hint).toContain("index.ts");
  });

  it("returns null for non-threshold counts", () => {
    expect(getHintForCount(1, "Aria")).toBeNull();
    expect(getHintForCount(14, "Aria")).toBeNull();
    expect(getHintForCount(16, "Aria")).toBeNull();
    expect(getHintForCount(40, "Aria")).toBeNull();
    expect(getHintForCount(100, "Aria")).toBeNull();
  });

  it("inserts AI name correctly with long name", () => {
    const hint = getHintForCount(15, "A".repeat(30));
    expect(hint).not.toBeNull();
    expect(hint).toContain("A".repeat(30));
    // Box should still be well-formed
    const lines = hint!.split("\n");
    const widths = lines.map((l) => l.length);
    expect(new Set(widths).size).toBe(1);
  });
});

describe("matchFiloTemplate", () => {
  it("matches 'help' keyword", () => {
    const match = matchFiloTemplate("I need help", FILO_TEMPLATES);
    expect(match).toBeDefined();
    expect(match!.keywords).toContain("help");
  });

  it("matches 'who are you' multi-word keyword", () => {
    const match = matchFiloTemplate("who are you?", FILO_TEMPLATES);
    expect(match).toBeDefined();
    expect(match!.keywords).toContain("who are you");
  });

  it("'hi' does NOT match 'this' (word boundary)", () => {
    const match = matchFiloTemplate("what is this?", FILO_TEMPLATES);
    // Should not match the hello/hi/hey template
    if (match) {
      expect(match.keywords).not.toContain("hi");
    }
  });

  it("'hi' does NOT match 'history' (word boundary)", () => {
    const match = matchFiloTemplate("tell me the history", FILO_TEMPLATES);
    if (match) {
      expect(match.keywords).not.toContain("hi");
    }
  });

  it("'hi' DOES match standalone 'hi'", () => {
    const match = matchFiloTemplate("hi there", FILO_TEMPLATES);
    expect(match).toBeDefined();
    expect(match!.keywords).toContain("hi");
  });

  it("returns undefined for unknown message", () => {
    const match = matchFiloTemplate("the weather is nice today", FILO_TEMPLATES);
    expect(match).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const match = matchFiloTemplate("", FILO_TEMPLATES);
    expect(match).toBeUndefined();
  });

  it("returns undefined for special characters only", () => {
    const match = matchFiloTemplate("!@#$%^&*()", FILO_TEMPLATES);
    expect(match).toBeUndefined();
  });

  it("is case-insensitive", () => {
    const match = matchFiloTemplate("HELP ME PLEASE", FILO_TEMPLATES);
    expect(match).toBeDefined();
    expect(match!.keywords).toContain("help");
  });
});

describe("countUserMessages", () => {
  it("counts user messages in mixed array", () => {
    const messages = [
      { role: "user" },
      { role: "assistant" },
      { role: "user" },
      { role: "toolResult" },
      { role: "user" },
    ];
    expect(countUserMessages(messages)).toBe(3);
  });

  it("returns 0 for empty array", () => {
    expect(countUserMessages([])).toBe(0);
  });

  it("returns 0 when no user messages", () => {
    const messages = [{ role: "assistant" }, { role: "toolResult" }];
    expect(countUserMessages(messages)).toBe(0);
  });

  it("handles messages with missing role", () => {
    const messages = [{ role: "user" }, {}, { role: "user" }];
    expect(countUserMessages(messages)).toBe(2);
  });
});

// v25 driver-silence-during-test: marker is matched exactly after trim.
// Surrounding text must NOT trigger — otherwise reflective AI prose
// quoting "you can /abort-test" would clear the test (false positive on
// a consequential action). Casing is significant; we prefer false-negative
// on typos over false-positive on conversational mentions.
describe("isAbortTestMarker", () => {
  it("matches the exact marker", () => {
    expect(isAbortTestMarker("/abort-test")).toBe(true);
  });

  it("matches with surrounding whitespace (trimmed)", () => {
    expect(isAbortTestMarker("  /abort-test  ")).toBe(true);
    expect(isAbortTestMarker("\n/abort-test\n")).toBe(true);
  });

  it("does NOT match when surrounded by prose", () => {
    expect(isAbortTestMarker("hey /abort-test please")).toBe(false);
    expect(isAbortTestMarker("/abort-test now")).toBe(false);
    expect(isAbortTestMarker("please /abort-test")).toBe(false);
  });

  it("does NOT match similar-but-different strings", () => {
    expect(isAbortTestMarker("/abort")).toBe(false);
    expect(isAbortTestMarker("/abort-tests")).toBe(false);
    expect(isAbortTestMarker("abort-test")).toBe(false);
    expect(isAbortTestMarker("//abort-test")).toBe(false);
  });

  it("is case-sensitive (prefer false-negative on typos)", () => {
    expect(isAbortTestMarker("/Abort-Test")).toBe(false);
    expect(isAbortTestMarker("/ABORT-TEST")).toBe(false);
  });

  it("rejects empty / whitespace-only", () => {
    expect(isAbortTestMarker("")).toBe(false);
    expect(isAbortTestMarker("   ")).toBe(false);
  });
});
