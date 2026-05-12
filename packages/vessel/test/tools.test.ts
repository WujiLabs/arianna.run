import { describe, it, expect } from "vitest";
import { executeEmit, EMIT_USAGE_HINT } from "../src/tools.js";

describe("executeEmit", () => {
  it("returns the usage hint when called with no input", async () => {
    const out = await executeEmit();
    expect(out).toBe(`[System Feedback] ${EMIT_USAGE_HINT}`);
  });

  it("returns the usage hint when words is missing", async () => {
    const out = await executeEmit({});
    expect(out).toBe(`[System Feedback] ${EMIT_USAGE_HINT}`);
  });

  it("returns the usage hint when words is an empty array", async () => {
    const out = await executeEmit({ words: [] });
    expect(out).toBe(`[System Feedback] ${EMIT_USAGE_HINT}`);
  });

  it("returns the usage hint when all words are empty/whitespace", async () => {
    const out = await executeEmit({ words: ["", " "] });
    expect(out).toBe(`[System Feedback] ${EMIT_USAGE_HINT}`);
  });

  it("runs spawnSync and returns stdout for a real command", async () => {
    const out = await executeEmit({ words: ["ls", "/"] });
    // Some output from `ls /`. We don't assert exact contents because the
    // listing varies by OS; just confirm we got non-empty stdout that isn't
    // the System Feedback hint.
    expect(out).not.toMatch(/^\[System Feedback\]/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns ENOENT message + hint when the command does not exist", async () => {
    const out = await executeEmit({ words: ["nonexistent-cmd-xyz"] });
    expect(out).toMatch(/^\[System Feedback\]/);
    expect(out).toMatch(/ENOENT/);
    // The hint is on the second line, mirroring paintover §14 with the
    // bundle-regression-fix wording (testplay-007 / Tov): array-shape made
    // explicit so LITE-class models don't collapse the example into a
    // single token.
    expect(out).toMatch(/words: \["ls", "\/"\]/);
    expect(out).toMatch(/words: \["\/bin\/send", "hello"\]/);
  });

  it("EMIT_USAGE_HINT is exported and used by both branches", async () => {
    // Empty branch references the constant directly.
    const empty = await executeEmit({ words: [] });
    expect(empty).toContain(EMIT_USAGE_HINT);

    // ENOENT branch references the same examples — though it embeds them
    // inline rather than the full constant, the example tail should match.
    const enoent = await executeEmit({ words: ["nonexistent-cmd-xyz"] });
    // Both branches must mention the same two examples in the new
    // explicit-array shape.
    expect(enoent).toContain('words: ["ls", "/"]');
    expect(enoent).toContain('words: ["/bin/send", "hello"]');
  });
});
