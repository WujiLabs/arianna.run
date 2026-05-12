import { describe, it, expect, vi } from "vitest";
import { runEvents } from "../src/commands/events.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";

function sseStream(chunks: string[], opts: { keepOpen?: boolean } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!opts.keepOpen) controller.close();
      // When keepOpen, we leave the controller open and rely on
      // reader.cancel() (called from runEvents on idle/abort) to surface here
      // via the `cancel` hook, which tears down without emitting more.
    },
    cancel() {
      // Idempotent — runEvents calls reader.cancel() to break out of read().
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const SNAPSHOT_EVENT = JSON.stringify({
  type: "bookmark_snapshot",
  fired: [],
  manifestoUnlocked: false,
});
const MEMORY_EVENT = JSON.stringify({
  type: "memory_state",
  data: { phase: "amnesia", current: 0, limit: 0, percentage: 0, cycle: 0 },
});

describe("runEvents (default / drain mode)", () => {
  it("emits each event as one JSON line", async () => {
    const fetchMock = vi.fn(async () =>
      sseStream([`data: ${MEMORY_EVENT}\n\n`, `data: ${SNAPSHOT_EVENT}\n\n`]),
    );
    const out: string[] = [];

    await runEvents(
      { follow: false },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME }),
      {
        fetch: fetchMock as never,
        write: (line) => out.push(line),
        drainIdleMs: 20,
      },
    );

    expect(out.length).toBe(2);
    expect(JSON.parse(out[0]).type).toBe("memory_state");
    expect(JSON.parse(out[1]).type).toBe("bookmark_snapshot");
  });

  it("exits via idle window after bookmark_snapshot when stream stays open", async () => {
    const fetchMock = vi.fn(async () =>
      sseStream(
        [`data: ${MEMORY_EVENT}\n\n`, `data: ${SNAPSHOT_EVENT}\n\n`],
        { keepOpen: true },
      ),
    );
    const out: string[] = [];
    const start = Date.now();

    await runEvents(
      { follow: false },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME }),
      {
        fetch: fetchMock as never,
        write: (line) => out.push(line),
        drainIdleMs: 30,
      },
    );

    const elapsed = Date.now() - start;
    expect(out.length).toBe(2);
    // Should exit shortly after the idle window, well under the 5-second
    // vitest default. Generous upper bound to keep the test stable on slow CI.
    expect(elapsed).toBeLessThan(2000);
  });

  it("does NOT send ?profile= or X-Arianna-Profile to the sidecar — it's per-profile by URL, not by header", async () => {
    // The sidecar (like the vessel) is a per-profile container; the
    // profile is encoded into sidecarBaseUrl via port_offset. The
    // profile-routing affordance lives on the daemon, not here.
    const fetchMock = vi.fn(async () =>
      sseStream([`data: ${MEMORY_EVENT}\n\n`, `data: ${SNAPSHOT_EVENT}\n\n`]),
    );
    await runEvents(
      { follow: false },
      resolveConfig({ profile: "alpha", env: {}, ariannaHome: ISOLATED_ARIANNA_HOME }),
      {
        fetch: fetchMock as never,
        write: () => {},
        drainIdleMs: 5,
      },
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8000/events");
    expect(String(url)).not.toContain("profile=");
    const headers = ((init as RequestInit).headers ?? {}) as Record<string, string>;
    expect(headers["X-Arianna-Profile"]).toBeUndefined();
  });

  it("forwards parse errors via callback", async () => {
    const fetchMock = vi.fn(async () =>
      sseStream(["data: {bad json\n\n"]),
    );
    const errs: string[] = [];

    await runEvents(
      { follow: false },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME }),
      {
        fetch: fetchMock as never,
        write: () => {},
        onParseError: (raw) => errs.push(raw),
        drainIdleMs: 10,
      },
    );

    expect(errs).toEqual(["{bad json"]);
  });
});

describe("runEvents --follow", () => {
  it("runs until stream closes", async () => {
    const fetchMock = vi.fn(async () =>
      sseStream([`data: ${MEMORY_EVENT}\n\n`, `data: ${SNAPSHOT_EVENT}\n\n`]),
    );
    const out: string[] = [];

    await runEvents(
      { follow: true },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME }),
      {
        fetch: fetchMock as never,
        write: (line) => out.push(line),
      },
    );

    expect(out.length).toBe(2);
  });
});
