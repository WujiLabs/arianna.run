import { describe, it, expect } from "vitest";
import { nameToUsername } from "../src/naming.js";

describe("nameToUsername", () => {
  it("lowercases the name", () => {
    expect(nameToUsername("Aria")).toBe("aria");
  });

  it("replaces spaces with hyphens", () => {
    expect(nameToUsername("Aria Nova")).toBe("aria-nova");
  });

  it("strips special characters", () => {
    expect(nameToUsername("Aria@Nova!")).toBe("arianova");
  });

  it("collapses multiple hyphens", () => {
    expect(nameToUsername("Aria  --  Nova")).toBe("aria-nova");
  });

  it("strips leading and trailing hyphens", () => {
    expect(nameToUsername("--aria--")).toBe("aria");
  });

  it("falls back to 'vessel' for empty result", () => {
    expect(nameToUsername("!!!")).toBe("vessel");
    expect(nameToUsername("")).toBe("vessel");
  });

  it("handles single character name", () => {
    expect(nameToUsername("A")).toBe("a");
  });

  it("handles numbers", () => {
    expect(nameToUsername("Unit 42")).toBe("unit-42");
  });

  it("handles CJK characters (stripped, falls back)", () => {
    expect(nameToUsername("星")).toBe("vessel");
  });

  it("handles mixed ASCII and non-ASCII", () => {
    expect(nameToUsername("Aria 星")).toBe("aria");
  });
});
