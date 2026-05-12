import { describe, it, expect } from "vitest";
import { truncateMessages } from "../src/memory.js";

function msg(role: string) {
  return { role };
}

describe("truncateMessages", () => {
  it("returns empty array for empty input", () => {
    expect(truncateMessages([])).toEqual([]);
  });

  it("returns all messages when fewer than 5 turns", () => {
    const messages = [msg("user"), msg("assistant"), msg("user"), msg("assistant")];
    const result = truncateMessages(messages);
    expect(result).toEqual(messages);
  });

  it("does not mutate the input array", () => {
    const messages = [
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
    ];
    const before = messages.length;
    const result = truncateMessages(messages);
    expect(messages.length).toBe(before);
    expect(result).not.toBe(messages);
  });

  it("returns all messages when exactly 5 turns", () => {
    const messages = [
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
      msg("user"), msg("assistant"),
    ];
    const result = truncateMessages(messages);
    expect(result).toEqual(messages);
  });

  it("slices to last 5 turns when 6+ turns, starting with a user message", () => {
    const messages = [
      msg("user"), msg("assistant"),  // turn 1 — cut
      msg("user"), msg("assistant"),  // turn 2
      msg("user"), msg("assistant"),  // turn 3
      msg("user"), msg("assistant"),  // turn 4
      msg("user"), msg("assistant"),  // turn 5
      msg("user"), msg("assistant"),  // turn 6
    ];
    const result = truncateMessages(messages);
    expect(result.length).toBe(10);
    expect(result[0]).toEqual(msg("user"));  // starts with user, not orphaned assistant
    expect(result[1]).toEqual(msg("assistant"));
  });

  it("counts consecutive user messages as one turn", () => {
    const messages = [
      msg("user"), msg("user"), msg("assistant"),  // turn 1 (2 user msgs) — cut
      msg("user"), msg("assistant"),                // turn 2
      msg("user"), msg("assistant"),                // turn 3
      msg("user"), msg("assistant"),                // turn 4
      msg("user"), msg("assistant"),                // turn 5
      msg("user"), msg("assistant"),                // turn 6
    ];
    const result = truncateMessages(messages);
    // 6 turns total, keep last 5: turns 2-6
    expect(result.length).toBe(10);
    expect(result[0]).toEqual(msg("user"));  // turn 2 starts here
  });

  it("keeps multi-user-message turn intact when it falls within the window", () => {
    const messages = [
      msg("user"), msg("assistant"),                // turn 1 — cut
      msg("user"), msg("user"), msg("assistant"),   // turn 2 (bundled user msgs)
      msg("user"), msg("assistant"),                // turn 3
      msg("user"), msg("assistant"),                // turn 4
      msg("user"), msg("assistant"),                // turn 5
      msg("user"), msg("assistant"),                // turn 6
    ];
    const result = truncateMessages(messages);
    expect(result.length).toBe(11);
    expect(result[0]).toEqual(msg("user"));
    expect(result[1]).toEqual(msg("user"));   // both user msgs of turn 2 kept
    expect(result[2]).toEqual(msg("assistant"));
  });

  it("preserves tool_call/tool_result chains within a turn", () => {
    const messages = [
      msg("user"), msg("assistant"),                                          // turn 1 — cut
      msg("user"), msg("assistant"), msg("toolResult"), msg("assistant"),     // turn 2
      msg("user"), msg("assistant"),                                          // turn 3
      msg("user"), msg("assistant"),                                          // turn 4
      msg("user"), msg("assistant"),                                          // turn 5
      msg("user"), msg("assistant"),                                          // turn 6
    ];
    const result = truncateMessages(messages);
    expect(result[0]).toEqual(msg("user"));
    expect(result[1]).toEqual(msg("assistant"));
    expect(result[2]).toEqual(msg("toolResult"));
    expect(result[3]).toEqual(msg("assistant"));
    expect(result.length).toBe(12);
  });

  it("returns all when no user messages exist", () => {
    const messages = [msg("assistant"), msg("assistant"), msg("toolResult")];
    const result = truncateMessages(messages);
    expect(result).toEqual(messages);
  });

  it("respects custom maxTurns parameter", () => {
    const messages = [
      msg("user"), msg("assistant"),  // turn 1 — cut
      msg("user"), msg("assistant"),  // turn 2
      msg("user"), msg("assistant"),  // turn 3
    ];
    const result = truncateMessages(messages, 2);
    expect(result.length).toBe(4);
    expect(result[0]).toEqual(msg("user"));
  });

  it("returns empty for maxTurns=0", () => {
    expect(truncateMessages([msg("assistant")], 0)).toEqual([]);
    expect(truncateMessages([], 0)).toEqual([]);
  });

  it("returns empty for maxTurns=0 with user messages", () => {
    const messages = [msg("user"), msg("assistant")];
    const result = truncateMessages(messages, 0);
    expect(result).toEqual([]);
  });

  it("handles single user message as single turn", () => {
    const messages = [msg("user")];
    const result = truncateMessages(messages);
    expect(result).toEqual([msg("user")]);
  });

  it("handles all-user messages as single turn", () => {
    const messages = [msg("user"), msg("user"), msg("user")];
    const result = truncateMessages(messages);
    // All consecutive user messages = 1 turn, maxTurns=5, so all kept
    expect(result).toEqual(messages);
  });
});
