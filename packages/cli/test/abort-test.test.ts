// v25 driver-silence-during-test — `arianna abort-test` command.
//
// Covers the operator-rescue CLI surface: POST sidecar /admin/abort-test,
// parse the JSON shape, and surface a one-line message. The dispatcher in
// index.ts maps aborted → exit 0, no-op → exit 75, AbortTestError → exit 1.

import { describe, it, expect, vi } from "vitest";
import { runAbortTest, AbortTestError } from "../src/commands/abort-test.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";

const CONFIG = () =>
  resolveConfig({
    env: {},
    ariannaHome: ISOLATED_ARIANNA_HOME,
    allowImplicitDefault: false,
  });

describe("runAbortTest", () => {
  it("returns aborted:true with attemptCount on a fresh abort", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, aborted: true, attemptCount: 2 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const writes: string[] = [];
    const result = await runAbortTest(CONFIG(), {
      fetch: fetchMock as never,
      write: (line) => writes.push(line),
    });

    expect(result.aborted).toBe(true);
    expect(result.attemptCount).toBe(2);

    // Single POST to /admin/abort-test, no body required.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8000/admin/abort-test");
    expect(init?.method).toBe("POST");

    // Operator-visible line mentions the attempt + continuation hint.
    expect(writes.join("")).toContain("aborted");
    expect(writes.join("")).toContain("attempt 2");
  });

  it("returns aborted:false with reason on idempotent no-op", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          aborted: false,
          reason: "no in-flight test",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const writes: string[] = [];
    const result = await runAbortTest(CONFIG(), {
      fetch: fetchMock as never,
      write: (line) => writes.push(line),
    });

    expect(result.aborted).toBe(false);
    expect(result.reason).toBe("no in-flight test");
    expect(writes.join("")).toContain("no in-flight graduation test");
  });

  it("throws AbortTestError with status detail on non-OK response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("Internal error", {
          status: 500,
        }),
    );
    await expect(
      runAbortTest(CONFIG(), { fetch: fetchMock as never }),
    ).rejects.toBeInstanceOf(AbortTestError);
  });

  it("throws AbortTestError with 'sidecar unreachable' on transport error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      runAbortTest(CONFIG(), { fetch: fetchMock as never }),
    ).rejects.toThrow(/sidecar unreachable/);
  });

  it("threads sidecar URL through env override", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, aborted: true, attemptCount: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await runAbortTest(
      resolveConfig({
        env: { SIDECAR_BASE_URL: "http://10.0.0.1:9999" },
        ariannaHome: ISOLATED_ARIANNA_HOME,
        allowImplicitDefault: false,
      }),
      { fetch: fetchMock as never },
    );
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://10.0.0.1:9999/admin/abort-test");
  });

  it("handles a 404 from older sidecars without /admin/abort-test", async () => {
    // Pre-v25 sidecar — the operator should see a clear error rather than
    // a silent no-op. Routed as AbortTestError → exit 1 by the dispatcher.
    const fetchMock = vi.fn(
      async () =>
        new Response("Cannot POST /admin/abort-test", { status: 404 }),
    );
    await expect(
      runAbortTest(CONFIG(), { fetch: fetchMock as never }),
    ).rejects.toThrow(/404/);
  });
});
