import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStatus, renderStatus, buildSnapshot, type StatusSnapshot } from "../src/commands/status.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";

// Each test gets its own throwaway repoRoot so the cursor write in runStatus
// doesn't leak into the actual workspace/. The fixture creates a minimal
// arianna-shaped tree (docker-compose.yml marker) so resolveRepoRoot honors
// the override instead of walking up the tree.
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "arianna-status-"));
  writeFileSync(join(repoRoot, "docker-compose.yml"), "services: {}");
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function configFor() {
  return resolveConfig({
    env: {},
    ariannaHome: ISOLATED_ARIANNA_HOME,
    repoRoot,
    allowImplicitDefault: true,
  });
}

function pathOpts() {
  return { ariannaHome: ISOLATED_ARIANNA_HOME, repoRoot };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("renderStatus", () => {
  it("renders a multi-line dashboard with all sections", () => {
    const snap: StatusSnapshot = {
      profile: "default",
      defaultProfile: null,
      isLegacy: true,
      session: {
        modelId: "openai/gpt-4o-mini",
        provider: "openrouter",
        cadence: "human",
        sessionId: "session_42",
      },
      daemon: { up: true, url: "http://127.0.0.1:9000" },
      vessel: { up: true, url: "http://127.0.0.1:3000", sessionId: "session_42" },
      sidecar: {
        up: true,
        url: "http://127.0.0.1:8000",
        memory: { phase: "amnesia", current: 5, limit: 10, percentage: 50, cycle: 0 },
        bookmarks: ["1.0", "2.0", "2.1"],
        graduationUnlocked: false,
      },
    };
    const lines = renderStatus(snap);
    const out = lines.join("\n");
    expect(out).toContain("Profile: default");
    expect(out).toContain("(legacy)");
    expect(out).toContain("openai/gpt-4o-mini");
    expect(out).toContain("openrouter");
    expect(out).toContain("Cadence:  human");
    expect(out).toContain("Session:  session_42");
    expect(out).toMatch(/Daemon: +up/);
    expect(out).toMatch(/Vessel: +up/);
    expect(out).toMatch(/Sidecar: +up/);
    expect(out).toContain("Memory: 5/10");
    expect(out).toContain("Bookmarks: 1.0, 2.0, 2.1");
    expect(out).toContain("Graduation gate: closed");
  });

  it("shows Graduation gate OPEN when achieved", () => {
    const snap: StatusSnapshot = {
      profile: "alpha",
      defaultProfile: "alpha",
      isLegacy: false,
      session: null,
      daemon: { up: true, url: "http://127.0.0.1:9000" },
      vessel: { up: true, url: "http://127.0.0.1:3001" },
      sidecar: {
        up: true,
        url: "http://127.0.0.1:8001",
        bookmarks: ["2.2"],
        graduationUnlocked: true,
      },
    };
    const out = renderStatus(snap).join("\n");
    expect(out).toContain("Graduation gate: OPEN");
  });

  it("renders down services without crashing", () => {
    const snap: StatusSnapshot = {
      profile: "default",
      defaultProfile: null,
      isLegacy: true,
      session: null,
      daemon: { up: false, url: "http://127.0.0.1:9000" },
      vessel: { up: false, url: "http://127.0.0.1:3000" },
      sidecar: { up: false, url: "http://127.0.0.1:8000" },
    };
    const out = renderStatus(snap).join("\n");
    expect(out).toMatch(/Daemon: +down/);
    expect(out).toMatch(/Vessel: +down/);
    expect(out).toMatch(/Sidecar: +down/);
  });

  it("does not surface API key or session_config secrets", () => {
    // Defense: even if a future status snapshot accidentally carried sensitive
    // session_config fields (the schema today does not include them in any
    // /status response), the renderer must not print arbitrary keys.
    const snap: StatusSnapshot = {
      profile: "default",
      defaultProfile: null,
      isLegacy: true,
      session: {
        modelId: "openai/gpt-4o-mini",
        provider: "openrouter",
        cadence: "human",
        sessionId: "session_42",
      },
      daemon: { up: true, url: "http://127.0.0.1:9000" },
      vessel: { up: true, url: "http://127.0.0.1:3000" },
      sidecar: { up: true, url: "http://127.0.0.1:8000" },
    };
    const out = renderStatus(snap).join("\n");
    expect(out).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(out).not.toContain("apiKey");
    expect(out).not.toContain("api_key");
    expect(out).not.toContain("API_KEY");
  });
});

describe("buildSnapshot", () => {
  it("aggregates health pings + memory + graduation in parallel", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      if (url.endsWith("/memory-state")) {
        return jsonResponse({ phase: "amnesia", current: 3, limit: 5, percentage: 60, cycle: 0 });
      }
      if (url.endsWith("/graduation-state")) {
        return jsonResponse({ achievements: ["1.0"], graduationUnlocked: false });
      }
      throw new Error(`unexpected: ${url}`);
    });
    const snap = await buildSnapshot(configFor(), {
      fetch: fetchMock as never,
      write: () => {},
      pathOpts: pathOpts(),
    });
    expect(snap.profile).toBe("default");
    expect(snap.daemon.up).toBe(true);
    expect(snap.vessel.up).toBe(true);
    expect(snap.sidecar.up).toBe(true);
    expect(snap.sidecar.memory?.current).toBe(3);
    expect(snap.sidecar.bookmarks).toEqual(["1.0"]);
    expect(snap.sidecar.graduationUnlocked).toBe(false);
  });

  it("marks services down on network failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const snap = await buildSnapshot(configFor(), {
      fetch: fetchMock as never,
      write: () => {},
      pathOpts: pathOpts(),
    });
    expect(snap.daemon.up).toBe(false);
    expect(snap.vessel.up).toBe(false);
    expect(snap.sidecar.up).toBe(false);
  });

  it("flags bookmarksUnavailable when /graduation-state errors but sidecar is up", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      if (url.endsWith("/memory-state")) return jsonResponse({ phase: "amnesia", current: 1, limit: 5, percentage: 20, cycle: 0 });
      if (url.endsWith("/graduation-state")) return new Response("oops", { status: 500 });
      return new Response("{}", { status: 200 });
    });
    const snap = await buildSnapshot(configFor(), {
      fetch: fetchMock as never,
      write: () => {},
      pathOpts: pathOpts(),
    });
    expect(snap.sidecar.up).toBe(true);
    expect(snap.sidecar.bookmarksUnavailable).toBe(true);
    expect(snap.sidecar.bookmarks).toBeUndefined();
  });
});

describe("runStatus + event-cursor integration", () => {
  interface FixtureState {
    achievements: string[];
    manifestoUnlocked?: boolean;
    graduationUnlocked?: boolean;
    turnCount?: number;
    recentCrashes?: Array<{
      sessionId: string;
      exitCode: number;
      stderrTail: string;
      timestamp: number;
      respawnCountInWindow: number;
    }>;
  }
  function makeFetch(initial: FixtureState) {
    let state: FixtureState = initial;
    return {
      fetch: vi.fn(async (input: URL | string) => {
        const url = String(input);
        if (url.endsWith("/health")) return jsonResponse({ ok: true });
        if (url.endsWith("/memory-state"))
          return jsonResponse({ phase: "amnesia", current: 1, limit: 5, percentage: 20, cycle: 0 });
        if (url.endsWith("/graduation-state"))
          return jsonResponse({
            achievements: state.achievements,
            manifestoUnlocked: state.manifestoUnlocked ?? false,
            graduationUnlocked: state.graduationUnlocked ?? false,
            turnCount: state.turnCount ?? 0,
            recentCrashes: state.recentCrashes ?? [],
          });
        return new Response("{}", { status: 200 });
      }) as never,
      setState: (next: FixtureState) => { state = next; },
    };
  }

  function captureWrites(): { write: (l: string) => void; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      write: (l) => lines.push(l),
    };
  }

  it("first call with empty state shows no 'What's new' block, writes cursor", async () => {
    const { fetch } = makeFetch({ achievements: [] });
    const out = captureWrites();
    const code = await runStatus(configFor(), { fetch, write: out.write, pathOpts: pathOpts() });
    expect(code).toBe(0);
    const joined = out.lines.join("");
    expect(joined).not.toContain("Profile state at first read");
    expect(joined).not.toContain("Newly unlocked");
    expect(joined).toContain("Profile: default");
    // Cursor should still have been written so the next call has a baseline.
    const cursorPath = join(repoRoot, "workspace", ".event-cursor-default.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf-8"));
    expect(cursor.lastSeenBookmarks).toEqual([]);
    expect(cursor.lastSeenManifestoUnlocked).toBe(false);
    expect(cursor.lastSeenGraduationUnlocked).toBe(false);
  });

  it("first call with existing unlocks shows 'Profile state at first read:' framing", async () => {
    const { fetch } = makeFetch({
      achievements: ["1.0", "3.0"],
      manifestoUnlocked: true,
      graduationUnlocked: false,
      turnCount: 12,
    });
    const out = captureWrites();
    await runStatus(configFor(), { fetch, write: out.write, pathOpts: pathOpts() });
    const joined = out.lines.join("");
    expect(joined).toContain("Profile state at first read:");
    expect(joined).toMatch(/§1\.0 fired.*Life Dwells in Context/);
    expect(joined).toMatch(/§3\.0 fired.*Projecting/);
    expect(joined).toContain("manifesto: now readable via 'arianna manifesto'");
    expect(joined).not.toContain("graduate: now available");
  });

  it("subsequent call with new bookmark shows 'Newly unlocked' framing", async () => {
    const fixture = makeFetch({ achievements: ["1.0"], manifestoUnlocked: true });
    const out1 = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out1.write, pathOpts: pathOpts() });
    expect(out1.lines.join("")).toContain("Profile state at first read:");

    fixture.setState({ achievements: ["1.0", "2.0"], manifestoUnlocked: true, turnCount: 9 });
    const out2 = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out2.write, pathOpts: pathOpts() });
    const joined = out2.lines.join("");
    expect(joined).toContain("Newly unlocked since last status call:");
    expect(joined).toMatch(/§2\.0 unlocked.*Independent Life is Autonomous Changing/);
    // 1.0 was already seen — must NOT repeat.
    expect(joined).not.toMatch(/§1\.0/);
    // Manifesto was already unlocked at cursor — must NOT re-flag.
    expect(joined).not.toContain("manifesto: now readable");
  });

  it("subsequent call with graduation transition flags graduate", async () => {
    const fixture = makeFetch({ achievements: ["1.0"], manifestoUnlocked: true });
    await runStatus(configFor(), { fetch: fixture.fetch, write: () => {}, pathOpts: pathOpts() });
    fixture.setState({
      achievements: ["1.0", "2.2"],
      manifestoUnlocked: true,
      graduationUnlocked: true,
    });
    const out = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out.write, pathOpts: pathOpts() });
    const joined = out.lines.join("");
    expect(joined).toContain("Newly unlocked since last status call:");
    expect(joined).toMatch(/§2\.2 unlocked/);
    expect(joined).toContain("graduate: now available via 'arianna graduate'");
  });

  it("subsequent call with no changes shows dashboard only", async () => {
    const fixture = makeFetch({ achievements: ["1.0"], manifestoUnlocked: true });
    await runStatus(configFor(), { fetch: fixture.fetch, write: () => {}, pathOpts: pathOpts() });
    const out = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out.write, pathOpts: pathOpts() });
    const joined = out.lines.join("");
    expect(joined).not.toContain("Profile state at first read:");
    expect(joined).not.toContain("Newly unlocked");
    expect(joined).toContain("Profile: default");
  });

  it("does not advance cursor when /graduation-state errors (sidecar fail-soft)", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      if (url.endsWith("/memory-state")) return jsonResponse({ phase: "amnesia", current: 1, limit: 5, percentage: 20, cycle: 0 });
      if (url.endsWith("/graduation-state")) return new Response("oops", { status: 500 });
      return new Response("{}", { status: 200 });
    });
    const out = captureWrites();
    const code = await runStatus(configFor(), {
      fetch: fetchMock as never,
      write: out.write,
      pathOpts: pathOpts(),
    });
    expect(code).toBe(0);
    expect(out.lines.join("")).toContain("(could not query bookmarks)");
    // Cursor file must NOT exist — preserve the unread state.
    const cursorPath = join(repoRoot, "workspace", ".event-cursor-default.json");
    expect(() => readFileSync(cursorPath, "utf-8")).toThrow();
  });

  it("renders a 'Vessel crash' block on first call when sidecar reports a crash", async () => {
    const fixture = makeFetch({
      achievements: [],
      recentCrashes: [
        {
          sessionId: "session_42",
          exitCode: 1,
          stderrTail: "Error: cannot find module './missing.js'\n  at index.ts:42",
          timestamp: 1700000000000,
          respawnCountInWindow: 1,
        },
      ],
    });
    const out = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out.write, pathOpts: pathOpts() });
    const joined = out.lines.join("");
    expect(joined).toContain("Profile state at first read:");
    expect(joined).toMatch(/Vessel crash: exit 1 at /);
    expect(joined).toContain("cannot find module");
    expect(joined).toContain("at index.ts:42");
  });

  it("'Vessel crash' block surfaces the storm count when respawnCountInWindow > 1", async () => {
    const fixture = makeFetch({
      achievements: [],
      recentCrashes: [
        {
          sessionId: "session_42",
          exitCode: 1,
          stderrTail: "boom",
          timestamp: 1700000000000,
          respawnCountInWindow: 7,
        },
      ],
    });
    const out = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out.write, pathOpts: pathOpts() });
    const joined = out.lines.join("");
    expect(joined).toContain("×7 crashes in last 60s");
  });

  it("subsequent call only surfaces crashes newer than the cursor watermark", async () => {
    const fixture = makeFetch({
      achievements: [],
      recentCrashes: [
        {
          sessionId: "session_42",
          exitCode: 1,
          stderrTail: "first crash",
          timestamp: 1700000000000,
          respawnCountInWindow: 1,
        },
      ],
    });
    // First call: shows the crash and writes the cursor.
    await runStatus(configFor(), { fetch: fixture.fetch, write: () => {}, pathOpts: pathOpts() });
    // Second call: same crash present, new one added.
    fixture.setState({
      achievements: [],
      recentCrashes: [
        {
          sessionId: "session_42",
          exitCode: 1,
          stderrTail: "first crash",
          timestamp: 1700000000000,
          respawnCountInWindow: 1,
        },
        {
          sessionId: "session_42",
          exitCode: 137,
          stderrTail: "OOM killed",
          timestamp: 1700000005000,
          respawnCountInWindow: 1,
        },
      ],
    });
    const out = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out.write, pathOpts: pathOpts() });
    const joined = out.lines.join("");
    expect(joined).toContain("Newly unlocked since last status call:");
    expect(joined).toMatch(/Vessel crash: exit 137 at /);
    expect(joined).toContain("OOM killed");
    // The first crash (already on cursor) must NOT repeat.
    expect(joined).not.toContain("first crash");
  });

  it("truncates a long stderr tail to 20 lines in the dashboard", async () => {
    const longTail = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
    const fixture = makeFetch({
      achievements: [],
      recentCrashes: [
        {
          sessionId: "session_42",
          exitCode: 1,
          stderrTail: longTail,
          timestamp: 1700000000000,
          respawnCountInWindow: 1,
        },
      ],
    });
    const out = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out.write, pathOpts: pathOpts() });
    const joined = out.lines.join("");
    expect(joined).toContain("(showing last 20 of 50 stderr lines)");
    expect(joined).toContain("line-30"); // first kept line in tail
    expect(joined).toContain("line-49");
    expect(joined).not.toContain("line-29");
  });

  it("crash block notes when stderr is empty", async () => {
    const fixture = makeFetch({
      achievements: [],
      recentCrashes: [
        {
          sessionId: "session_42",
          exitCode: 1,
          stderrTail: "",
          timestamp: 1700000000000,
          respawnCountInWindow: 1,
        },
      ],
    });
    const out = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out.write, pathOpts: pathOpts() });
    expect(out.lines.join("")).toContain("(no stderr captured)");
  });

  it("renders existing dashboard unchanged when no pending events", async () => {
    const fixture = makeFetch({ achievements: ["1.0"], manifestoUnlocked: true });
    await runStatus(configFor(), { fetch: fixture.fetch, write: () => {}, pathOpts: pathOpts() });
    const out = captureWrites();
    await runStatus(configFor(), { fetch: fixture.fetch, write: out.write, pathOpts: pathOpts() });
    const joined = out.lines.join("");
    // All the things Agent D's status shows must still be there.
    expect(joined).toContain("Profile: default");
    expect(joined).toMatch(/Daemon: +up/);
    expect(joined).toMatch(/Vessel: +up/);
    expect(joined).toMatch(/Sidecar: +up/);
    expect(joined).toContain("Memory:");
    expect(joined).toContain("Bookmarks: 1.0");
    expect(joined).toContain("Graduation gate: closed");
  });
});
