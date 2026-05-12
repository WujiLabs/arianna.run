import { Readable } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import { runTalk } from "../src/commands/talk.js";
import {
  classifyStdin,
  readStdinCapped,
  type StdinFdStats,
} from "../src/index.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";

function fakeStat(kind: "char" | "block" | "fifo" | "file" | "socket"): StdinFdStats {
  return {
    isCharacterDevice: () => kind === "char",
    isBlockDevice: () => kind === "block",
    isFIFO: () => kind === "fifo",
    isFile: () => kind === "file",
    isSocket: () => kind === "socket",
  };
}

function sseResponse(events: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// runTalk now does auto-bootstrap (GET /status, POST /bootstrap if needed)
// AND a v25 lockout pre-flight (GET /admin/lockout-status) before the /chat
// request. Wrap the original fetchMock to short-circuit each so the test's
// fetchMock only sees the /chat call — the call most existing tests assert
// on. The lockout probe returns `locked: false` here so the gate is a
// no-op; tests that need the locked path build their own fetch mock.
function withAutoBootstrapShim(
  chatFetch: ReturnType<typeof vi.fn>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/status")) {
      return new Response(
        JSON.stringify({ ok: true, bootstrapped: true, aiName: "tester" }),
        { status: 200 },
      );
    }
    if (u.endsWith("/bootstrap")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.endsWith("/admin/lockout-status")) {
      return new Response(
        JSON.stringify({ locked: false, sessionId: "s", reason: "no-test" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return chatFetch(url, init);
  });
}

describe("runTalk", () => {
  it("posts to /chat with the message and streams text deltas", async () => {
    const chatFetch = vi.fn(async () =>
      sseResponse([
        'data: {"type":"text_delta","delta":"hel"}\n\n',
        'data: {"type":"text_delta","delta":"lo"}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
    );
    const fetchMock = withAutoBootstrapShim(chatFetch);
    const writes: string[] = [];

    const result = await runTalk(
      { message: "ping", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: (c) => writes.push(c) },
    );

    expect(result.responseText).toBe("hello");
    expect(result.status).toBe(200);
    expect(writes).toEqual(["hel", "lo"]);

    expect(chatFetch).toHaveBeenCalledTimes(1);
    const [url, init] = chatFetch.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:3000/chat");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ message: "ping", sender: "player" });
  });

  it("does NOT send ?profile= or X-Arianna-Profile to the vessel — it's per-profile by URL, not by header", async () => {
    // The vessel is a per-profile container reached via its own host port
    // (vesselBaseUrl already encodes the profile via port_offset). Sending
    // a profile query or header would imply a routing capability the
    // vessel doesn't have. Lock down the omission so a future change
    // doesn't accidentally re-introduce the misleading behaviour.
    const chatFetch = vi.fn(async () =>
      sseResponse(['data: {"type":"done"}\n\n']),
    );
    const fetchMock = withAutoBootstrapShim(chatFetch);
    await runTalk(
      { message: "x", sender: "player" },
      resolveConfig({ profile: "alpha", env: {}, ariannaHome: ISOLATED_ARIANNA_HOME }),
      { fetch: fetchMock as never, write: () => {} },
    );

    const [url, init] = chatFetch.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:3000/chat");
    expect(String(url)).not.toContain("profile=");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Arianna-Profile"]).toBeUndefined();
  });

  it("honors VESSEL_BASE_URL env override", async () => {
    const chatFetch = vi.fn(async () =>
      sseResponse(['data: {"type":"done"}\n\n']),
    );
    const fetchMock = withAutoBootstrapShim(chatFetch);
    await runTalk(
      { message: "x", sender: "player" },
      resolveConfig({
        env: { VESSEL_BASE_URL: "http://10.0.0.1:9999" },
        ariannaHome: ISOLATED_ARIANNA_HOME,
        allowImplicitDefault: false,
      }),
      { fetch: fetchMock as never, write: () => {} },
    );
    const [url] = chatFetch.mock.calls[0];
    expect(String(url)).toBe("http://10.0.0.1:9999/chat");
  });

  it("returns status 409 without throwing on busy", async () => {
    const chatFetch = vi.fn(async () => new Response("busy", { status: 409 }));
    const fetchMock = withAutoBootstrapShim(chatFetch);
    const result = await runTalk(
      { message: "x", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.status).toBe(409);
    expect(result.responseText).toBe("");
    // Legacy raw-string body has no pausedBy field — stays undefined so the
    // CLI surface falls back to "vessel busy — try again". Backward compat
    // with older vessels that don't emit the disambiguator.
    expect(result.pausedBy).toBeUndefined();
  });

  it("surfaces pausedBy:'filo' from a 409 JSON body (testplay-003 finding #2)", async () => {
    // Vessel emits {error:"Chat busy", pausedBy:"filo"} when the in-flight
    // chat is Filo's external_message stream. runTalk decodes and exposes
    // this so the CLI surface message can be "vessel paused — Filo is
    // composing" instead of the misleading "vessel busy — try again".
    const chatFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Chat busy", pausedBy: "filo" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const fetchMock = withAutoBootstrapShim(chatFetch);
    const result = await runTalk(
      { message: "x", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.status).toBe(409);
    expect(result.pausedBy).toBe("filo");
  });

  it("surfaces pausedBy:'player' from a 409 JSON body (real player work in flight)", async () => {
    const chatFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "Chat busy", pausedBy: "player" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    const fetchMock = withAutoBootstrapShim(chatFetch);
    const result = await runTalk(
      { message: "x", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.pausedBy).toBe("player");
  });

  it("ignores an unknown pausedBy value in the 409 body (defensive)", async () => {
    // Forward-compat / typo defense: only the documented two values are
    // surfaced. Anything else (e.g., a future "system" value, or junk)
    // collapses to undefined → legacy "vessel busy" message.
    const chatFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "Chat busy", pausedBy: "system" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    const fetchMock = withAutoBootstrapShim(chatFetch);
    const result = await runTalk(
      { message: "x", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.pausedBy).toBeUndefined();
  });

  it("propagates non-OK non-409 errors", async () => {
    const chatFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    const fetchMock = withAutoBootstrapShim(chatFetch);
    await expect(
      runTalk(
        { message: "x", sender: "player" },
        resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrow(/500/);
  });

  it("propagates explicit error events from the stream", async () => {
    const chatFetch = vi.fn(async () =>
      sseResponse(['data: {"type":"error","message":"boom"}\n\n']),
    );
    const fetchMock = withAutoBootstrapShim(chatFetch);
    await expect(
      runTalk(
        { message: "x", sender: "player" },
        resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrow(/boom/);
  });

  it("forwards stdin-resolved message to /chat (the day-1 `arianna map | arianna talk` flow)", async () => {
    // Integration of the stdin path with runTalk: index.ts resolves stdin via
    // resolveTalkMessage, then hands the resolved string to runTalk. This test
    // simulates that handoff and locks in that runTalk sees the trimmed message.
    const chatFetch = vi.fn(async () =>
      sseResponse(['data: {"type":"done"}\n\n']),
    );
    const fetchMock = withAutoBootstrapShim(chatFetch);

    await runTalk(
      { message: "snapshot history feed", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );

    const [, init] = chatFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.message).toBe("snapshot history feed");
  });

  it("auto-bootstraps when /status reports bootstrapped:false (POSTs /bootstrap before /chat)", async () => {
    // The bootstrap-failure-silent fix: when an LLM agent runs `arianna talk`
    // for the first time after `arianna profile create`, vessel will 503 unless
    // we POST /bootstrap first. Verify the auto-bootstrap path runs and that
    // /chat is only attempted *after* /bootstrap succeeds.
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push(u);
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "tester" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return sseResponse(['data: {"type":"done"}\n\n']);
    });

    const warnings: string[] = [];
    await runTalk(
      { message: "hi", sender: "player" },
      resolveConfig({
        env: {},
        ariannaHome: ISOLATED_ARIANNA_HOME,
        allowImplicitDefault: false,
      }),
      {
        fetch: fetchMock as never,
        write: () => {},
        warn: (line) => warnings.push(line),
      },
    );

    // Order matters: /status, then /bootstrap, then /chat.
    const statusIdx = calls.findIndex((u) => u.endsWith("/status"));
    const bootIdx = calls.findIndex((u) => u.endsWith("/bootstrap"));
    const chatIdx = calls.findIndex((u) => u.endsWith("/chat"));
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(bootIdx).toBeGreaterThan(statusIdx);
    expect(chatIdx).toBeGreaterThan(bootIdx);
    expect(warnings.some((w) => w.includes("auto-bootstrap"))).toBe(true);
  });
});

describe("readStdinCapped", () => {
  it("reads piped chunks into a single utf-8 string", async () => {
    const stream = Readable.from([Buffer.from("hello "), Buffer.from("world")]);
    const out = await readStdinCapped(stream, 1024);
    expect(out).toBe("hello world");
  });

  it("decodes multi-byte utf-8 even when chunks split codepoints", async () => {
    // A 2-byte codepoint (é = 0xC3 0xA9) split across two chunks must still
    // decode correctly — Buffer.concat-then-toString handles this; per-chunk
    // toString would corrupt it.
    const stream = Readable.from([Buffer.from([0xc3]), Buffer.from([0xa9])]);
    const out = await readStdinCapped(stream, 1024);
    expect(out).toBe("é");
  });

  it("rejects piped input that exceeds the byte cap", async () => {
    const stream = Readable.from([Buffer.alloc(64), Buffer.alloc(64)]);
    await expect(readStdinCapped(stream, 100)).rejects.toThrow(
      /exceeds 100-byte cap/,
    );
  });

  it("returns empty string for an empty stream (caller is responsible for the empty-message error)", async () => {
    const stream = Readable.from([] as Buffer[]);
    const out = await readStdinCapped(stream, 1024);
    expect(out).toBe("");
  });
});

describe("classifyStdin", () => {
  // The stdin classifier is the heart of the talk-stdin gap fix. The behaviour
  // we lock in here is *exactly* what production sees: TTY fast-path, then
  // fstat-driven branching across the fd kinds POSIX (macOS + Linux) exposes.

  it("returns false for an interactive TTY (no fstat needed)", () => {
    let fstatCalled = false;
    const result = classifyStdin({
      isTTY: true,
      fstat: () => {
        fstatCalled = true;
        return fakeStat("fifo");
      },
    });
    expect(result).toBe(false);
    // Hot-path sanity: TTY means we never even consult fstat.
    expect(fstatCalled).toBe(false);
  });

  it("returns false when stdin is /dev/null or any other character device", () => {
    // The bug case: `arianna talk \"hi\" < /dev/null`. /dev/null is a
    // character device, not a pipe — must classify as no-content so the
    // positional flows through.
    expect(
      classifyStdin({ isTTY: undefined, fstat: () => fakeStat("char") }),
    ).toBe(false);
  });

  it("returns false for a block device on stdin (defensive — unusual but possible)", () => {
    expect(
      classifyStdin({ isTTY: undefined, fstat: () => fakeStat("block") }),
    ).toBe(false);
  });

  it("returns true for a FIFO (real pipe — `echo X | arianna talk`)", () => {
    expect(
      classifyStdin({ isTTY: undefined, fstat: () => fakeStat("fifo") }),
    ).toBe(true);
  });

  it("returns true for a regular file (`arianna talk < message.txt`)", () => {
    expect(
      classifyStdin({ isTTY: undefined, fstat: () => fakeStat("file") }),
    ).toBe(true);
  });

  it("returns true for a socket (rare but legal stdin shape)", () => {
    expect(
      classifyStdin({ isTTY: undefined, fstat: () => fakeStat("socket") }),
    ).toBe(true);
  });

  it("returns false when fstat fails (sandbox / closed fd) — conservative bias", () => {
    // We'd rather mistakenly say \"no piped content\" (let the positional
    // through) than mistakenly say \"piped\" (resurrect the false-conflict bug).
    expect(classifyStdin({ isTTY: undefined, fstat: () => null })).toBe(false);
  });

  it("treats isTTY=undefined as non-TTY (Node default for non-terminal stdins)", () => {
    // process.stdin.isTTY is `undefined` (not `false`) in non-TTY contexts,
    // so the classifier must NOT short-circuit on that — it has to defer
    // to fstat to decide.
    expect(
      classifyStdin({ isTTY: undefined, fstat: () => fakeStat("fifo") }),
    ).toBe(true);
    expect(
      classifyStdin({ isTTY: undefined, fstat: () => fakeStat("char") }),
    ).toBe(false);
  });
});
