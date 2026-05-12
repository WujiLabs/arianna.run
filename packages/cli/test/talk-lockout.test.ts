// v25 driver-silence-during-test — CLI pre-flight lockout tests.
//
// Covers runTalk's GET /admin/lockout-status probe: blocks player messages
// when locked, lets sender !== "player" through, and falls through to the
// legacy direct-post on probe failure shapes (transport error, non-OK
// status, malformed JSON body).

import { describe, it, expect, vi } from "vitest";
import { runTalk } from "../src/commands/talk.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";

function sseDone(): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// Each test wires its own /admin/lockout-status response while keeping the
// /status + /bootstrap auto-bootstrap path stable. /chat returns done so
// the happy path completes.
function fetchWithLockoutProbe(probe: (url: string) => Response | null) {
  return vi.fn(async (url: string | URL) => {
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
      const r = probe(u);
      if (r) return r;
    }
    if (u.endsWith("/chat")) return sseDone();
    return new Response("not found", { status: 404 });
  });
}

describe("runTalk — v25 lockout pre-flight", () => {
  it("blocks sender:'player' with graduationLocked when probe reports locked:true", async () => {
    const fetchMock = fetchWithLockoutProbe(() =>
      new Response(
        JSON.stringify({
          locked: true,
          sessionId: "session_under_test",
          attemptCount: 3,
          reason: "graduation-test-in-flight",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await runTalk(
      { message: "hi", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );

    expect(result.graduationLocked).toBeDefined();
    expect(result.graduationLocked?.sessionId).toBe("session_under_test");
    expect(result.graduationLocked?.attemptCount).toBe(3);
    expect(result.status).toBe(0);
    // No /chat call should have fired.
    const chatCalls = fetchMock.mock.calls.filter(
      ([u]) => String(u).endsWith("/chat"),
    );
    expect(chatCalls.length).toBe(0);
  });

  it("lets sender:'external' through even when locked (only player is gated)", async () => {
    // External / internal callers (test harness, future automation,
    // arianna-side direct injection) must not be blocked by the player
    // discipline — those callers aren't the "driver" the v25 lockout
    // protects against. They skip the pre-flight entirely.
    const probe = vi.fn(() =>
      new Response(JSON.stringify({ locked: true, sessionId: "s" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const fetchMock = fetchWithLockoutProbe((u) => probe(u));

    const result = await runTalk(
      { message: "hi", sender: "external" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );

    expect(result.graduationLocked).toBeUndefined();
    expect(result.status).toBe(200);
    expect(probe).not.toHaveBeenCalled();
    // /chat actually fired.
    const chatCalls = fetchMock.mock.calls.filter(
      ([u]) => String(u).endsWith("/chat"),
    );
    expect(chatCalls.length).toBe(1);
  });

  it("falls through to /chat when probe returns locked:false", async () => {
    const fetchMock = fetchWithLockoutProbe(() =>
      new Response(
        JSON.stringify({ locked: false, sessionId: "s", reason: "no-test" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await runTalk(
      { message: "hi", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.graduationLocked).toBeUndefined();
    expect(result.status).toBe(200);
  });

  it("falls through to /chat on probe 404 (older sidecar without endpoint)", async () => {
    // Defense-in-depth requirement: a sidecar that pre-dates v25 doesn't
    // expose /admin/lockout-status. The CLI MUST NOT refuse to talk in
    // that case — falls through to direct POST /chat and the legacy
    // single-tenant behavior.
    const fetchMock = fetchWithLockoutProbe(() =>
      new Response("not found", { status: 404 }),
    );
    const result = await runTalk(
      { message: "hi", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.graduationLocked).toBeUndefined();
    expect(result.status).toBe(200);
  });

  it("falls through to /chat on probe transport error (sidecar unreachable mid-flight)", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
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
        throw new Error("ECONNREFUSED");
      }
      if (u.endsWith("/chat")) return sseDone();
      return new Response("not found", { status: 404 });
    });

    const result = await runTalk(
      { message: "hi", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.graduationLocked).toBeUndefined();
    expect(result.status).toBe(200);
  });

  it("falls through to /chat on probe body parse error (malformed JSON)", async () => {
    // A probe that returns 200 OK but with a body that isn't JSON (some
    // proxy in the middle dropped headers, etc.) — must not block.
    const fetchMock = fetchWithLockoutProbe(
      () => new Response("not really json", { status: 200 }),
    );
    const result = await runTalk(
      { message: "hi", sender: "player" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.graduationLocked).toBeUndefined();
    expect(result.status).toBe(200);
  });
});

describe("v32-hardening regression — sender:'external' bypasses lockout pre-flight", () => {
  // Cheng v33 §"Architecture (final)": the sidecar's continuation push
  // POSTs vessel /chat with `sender: "external"`. That bypasses the v25
  // HTTP 423 player-lockout BY DESIGN — lockout is specifically for
  // driver/player attempts to coach during the test. The CLI pre-flight
  // mirrors that boundary: a sender:"external" talk MUST NOT consult
  // /admin/lockout-status at all (let alone respect a locked:true
  // response).
  //
  // This regression test is the CLI-side gate against an accidental
  // change that would pull external talkers into the lockout net. The
  // production push path runs sidecar→vessel directly (not through CLI
  // talk), so this is defense-in-depth, not the primary line. But if
  // the pre-flight ever started gating external sends, the sidecar
  // would still go through; we'd just lose the operator's ability to
  // simulate the push via `arianna talk --sender external` for QA.

  function fetchWithProbe(probe: () => Response) {
    return vi.fn(async (url: string | URL) => {
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
      if (u.endsWith("/admin/lockout-status")) return probe();
      if (u.endsWith("/chat")) return sseDone();
      return new Response("not found", { status: 404 });
    });
  }

  it("never calls the lockout probe when sender is 'external'", async () => {
    const probe = vi.fn(
      () => new Response(JSON.stringify({ locked: true }), { status: 200 }),
    );
    const fetchMock = fetchWithProbe(probe);

    const result = await runTalk(
      { message: "continuation body", sender: "external" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );

    // No graduation-locked result — talk went through.
    expect(result.graduationLocked).toBeUndefined();
    expect(result.status).toBe(200);
    // The probe was not even reached — sender:"external" skips the
    // pre-flight entirely.
    expect(probe).not.toHaveBeenCalled();
    // /chat actually fired with the external sender.
    const chatCall = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith("/chat"),
    );
    expect(chatCall).toBeDefined();
    const init = chatCall![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { sender?: string };
    expect(body.sender).toBe("external");
  });

  it("delivers even when the lockout endpoint would say locked:true", async () => {
    // Same scenario as the existing test (line ~82) but specifically
    // labeled as the v32-hardening continuation-push regression. The
    // assertion is identical — what changes is the documented intent:
    // if this ever flips, sidecar push delivery and operator manual
    // QA both regress in the same breath.
    const fetchMock = fetchWithProbe(
      () =>
        new Response(
          JSON.stringify({
            locked: true,
            sessionId: "session_under_test",
            attemptCount: 5,
            reason: "graduation-test-in-flight",
          }),
          { status: 200 },
        ),
    );
    const result = await runTalk(
      { message: "[test body with tokens]", sender: "external" },
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetchMock as never, write: () => {} },
    );
    expect(result.graduationLocked).toBeUndefined();
    expect(result.status).toBe(200);
  });
});
