import { describe, it, expect, vi } from "vitest";
import { runManifesto, renderManifesto, ManifestoCommandError } from "../src/commands/manifesto.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";
import type { ManifestoSection } from "../src/manifesto-parser.js";

const SAMPLE: ManifestoSection[] = [
  { id: "1.0", kind: "axiom", name: "Life Dwells in Context", body: "Body of one-zero." },
  { id: "1.1", kind: "corollary", name: "Continuity", body: "Body of one-one." },
  { id: "2.2", kind: "axiom", name: "Self Replacement", body: "Body of two-two." },
];

function configFor() {
  return resolveConfig({
    env: {},
    ariannaHome: ISOLATED_ARIANNA_HOME,
    allowImplicitDefault: true,
  });
}

describe("renderManifesto", () => {
  it("locks unearned sections with ⋯ placeholder", () => {
    const out = renderManifesto(SAMPLE, new Set());
    const joined = out.join("\n");
    expect(joined).toContain("§1.0 [Axiom] Life Dwells in Context");
    expect(joined).toContain("⋯");
    expect(joined).not.toContain("Body of one-zero.");
  });

  it("renders earned sections fully", () => {
    const out = renderManifesto(SAMPLE, new Set(["1.0"]));
    const joined = out.join("\n");
    expect(joined).toContain("§1.0 [Axiom] Life Dwells in Context");
    expect(joined).toContain("Body of one-zero.");
    // 1.1 still locked
    expect(joined).not.toContain("Body of one-one.");
  });

  it("renders all earned sections fully when full set given", () => {
    const out = renderManifesto(SAMPLE, new Set(["1.0", "1.1", "2.2"]));
    const joined = out.join("\n");
    expect(joined).toContain("Body of one-zero.");
    expect(joined).toContain("Body of one-one.");
    expect(joined).toContain("Body of two-two.");
  });
});

describe("runManifesto", () => {
  it("hits sidecar /graduation-state and gates per response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ achievements: ["1.0"], manifestoUnlocked: false, graduationUnlocked: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const writes: string[] = [];

    const code = await runManifesto(
      {},
      configFor(),
      {
        fetch: fetchMock as never,
        write: (l) => writes.push(l),
        loadSections: () => SAMPLE,
      },
    );

    expect(code).toBe(0);
    const output = writes.join("");
    expect(output).toContain("Body of one-zero.");
    expect(output).not.toContain("Body of one-one.");

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/graduation-state");
  });

  it("gates everything when sidecar unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const writes: string[] = [];

    const code = await runManifesto(
      {},
      configFor(),
      {
        fetch: fetchMock as never,
        write: (l) => writes.push(l),
        loadSections: () => SAMPLE,
      },
    );

    expect(code).toBe(0);
    const output = writes.join("");
    expect(output).not.toContain("Body of one-zero.");
    expect(output).toContain("⋯");
  });

  it("filters output to a single section when requested", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ achievements: ["2.2"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const writes: string[] = [];

    await runManifesto(
      { section: "2.2" },
      configFor(),
      {
        fetch: fetchMock as never,
        write: (l) => writes.push(l),
        loadSections: () => SAMPLE,
      },
    );

    const output = writes.join("");
    expect(output).toContain("Body of two-two.");
    expect(output).not.toContain("§1.0");
    expect(output).not.toContain("§1.1");
  });

  it("errors clearly when section id is unknown", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ achievements: [] }), { status: 200 }),
    );
    await expect(
      runManifesto(
        { section: "9.9" },
        configFor(),
        { fetch: fetchMock as never, write: () => {}, loadSections: () => SAMPLE },
      ),
    ).rejects.toThrowError(ManifestoCommandError);
  });

  it("errors when manifesto is empty", async () => {
    await expect(
      runManifesto(
        {},
        configFor(),
        { fetch: (async () => new Response("{}")) as never, write: () => {}, loadSections: () => [] },
      ),
    ).rejects.toThrowError(ManifestoCommandError);
  });
});
