import { describe, it, expect } from "vitest";
import {
  PROFILE_NAME_RE,
  assertValidProfileName,
  isValidProfileName,
  InvalidProfileNameError,
} from "../src/profile.js";

describe("profile name regex (eng-review-locked)", () => {
  it("matches the locked pattern", () => {
    // Sanity check the source so reviews catch accidental edits.
    expect(PROFILE_NAME_RE.source).toBe("^[a-z][a-z0-9-]{0,30}$");
  });

  describe("accepts", () => {
    const valid = [
      "a",
      "default",
      "alpha-1",
      "long-but-okay-with-30-chars-h",
      "abcdefghijklmnopqrstuvwxyz1234", // 30 chars total (1 + 29)
      "abc123",
      "a-b-c",
    ];
    for (const name of valid) {
      it(name, () => expect(isValidProfileName(name)).toBe(true));
    }
  });

  describe("rejects", () => {
    const invalid: [string, string][] = [
      ["", "empty"],
      ["1abc", "leading digit"],
      ["-abc", "leading hyphen"],
      ["Abc", "uppercase"],
      ["abc_def", "underscore"],
      ["abc.def", "dot"],
      ["abc def", "space"],
      ["a".repeat(32), "32 chars (max is 31)"],
      ["abc/", "slash"],
      ["..", "dots only"],
    ];
    for (const [name, label] of invalid) {
      it(label, () => expect(isValidProfileName(name)).toBe(false));
    }
  });

  it("assertValidProfileName throws InvalidProfileNameError on bad input", () => {
    expect(() => assertValidProfileName("Bad-Name")).toThrowError(
      InvalidProfileNameError,
    );
  });

  it("assertValidProfileName returns the value on success", () => {
    expect(assertValidProfileName("default")).toBe("default");
  });
});
