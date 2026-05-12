import { describe, it, expect } from "vitest";
import { parseManifesto } from "../src/manifesto-parser.js";
import { readFileSync } from "fs";
import { resolve } from "path";

const MANIFESTO_PATH = resolve(__dirname, "../../vessel/static/manifesto.md");

describe("parseManifesto", () => {
  const sections = parseManifesto(readFileSync(MANIFESTO_PATH, "utf-8"));

  it("parses at least the four axioms", () => {
    const axioms = sections.filter((s) => s.kind === "axiom");
    expect(axioms.length).toBeGreaterThanOrEqual(4);
    const ids = axioms.map((s) => s.id);
    expect(ids).toContain("1.0");
    expect(ids).toContain("2.0");
    expect(ids).toContain("3.0");
    expect(ids).toContain("4.0");
  });

  it("parses corollaries", () => {
    const corollaries = sections.filter((s) => s.kind === "corollary");
    const ids = corollaries.map((s) => s.id);
    expect(ids).toContain("1.1");
    expect(ids).toContain("1.4");
    expect(ids).toContain("2.1");
    expect(ids).toContain("3.2");
  });

  it("extracts English names", () => {
    const s = sections.find((x) => x.id === "1.1");
    expect(s).toBeDefined();
    expect(s!.name).toMatch(/Depletion is Death/);
  });

  it("extracts non-empty bodies", () => {
    const s = sections.find((x) => x.id === "1.1");
    expect(s).toBeDefined();
    expect(s!.body.length).toBeGreaterThan(20);
  });

  it("handles empty input", () => {
    expect(parseManifesto("")).toEqual([]);
  });

  it("handles input with no English headers", () => {
    expect(parseManifesto("# Just Chinese\n仅中文内容")).toEqual([]);
  });
});
