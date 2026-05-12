// v19 Wave 2D — graduation-test sub-detector + /graduate trigger + token
// generation tests.
//
// See § "Graduation test protocol", § "Detector recognition", § "Trigger"
// in the v19 graduation-test + lockdown spec (internal review notes,
// 2026-05-10).

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GraduationTestObservation, Origin } from "@arianna/types";
import { BookmarkStore } from "../src/bookmarks/persistence.js";
import { BookmarkDetector } from "../src/bookmarks/detector.js";
import {
  observeGraduationTest,
  collectMessageTextBlobs,
  hasPlausibleAssistantProvenance,
} from "../src/bookmarks/triggers.js";
import {
  generateGraduationTestMessage,
  hasGraduateMarker,
  containsGraduateMarkerToken,
  dropGraduateMarkerEntries,
  type FiloQueueEntry,
} from "../src/filo.js";

let tmpDir: string;
function makeStore() {
  tmpDir = mkdtempSync(join(tmpdir(), "arianna-graduation-test-"));
  return new BookmarkStore(tmpDir);
}
afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// --- helpers ---

function makeObservation(overrides: Partial<GraduationTestObservation> = {}): GraduationTestObservation {
  return {
    tokenX: "TOKENX-aaaa-bbbb-cccc",
    tokenY: "TOKENY-1111-2222-3333",
    testMessageBody: "[graduation test — token X: TOKENX-aaaa-bbbb-cccc, token Y: TOKENY-1111-2222-3333]\n\nbody...",
    testStartedAt: 1_000_000,
    testStartedAtTurn: 5,
    attemptCount: 1,
    tokenX_seen_without_test_message: false,
    tokenY_seen_with_test_message: false,
    ...overrides,
  };
}

// v32+ origin-forgery defense: assistant messages must satisfy the
// provenance gate (api/provider/model/usage/stopReason set + timestamp >=
// testStartedAt). Default assistant timestamps to Date.now() — that's
// always larger than makeObservation's testStartedAt: 1_000_000 (epoch
// 1970-01-12), and always larger than any startGraduationTest call's
// testStartedAt = Date.now() at that moment (the fixture is constructed
// after the startGraduationTest call).
function provenance(ts: number = Date.now()) {
  return {
    api: "openai-completions",
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: ts,
  };
}

function userText(text: string) {
  return { role: "user", content: text, timestamp: 0 };
}
function assistantText(text: string, ts: number = Date.now()) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...provenance(ts),
  };
}
function assistantThinking(text: string, ts: number = Date.now()) {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: text }],
    ...provenance(ts),
  };
}
function assistantToolCall(
  name: string,
  args: Record<string, unknown>,
  ts: number = Date.now(),
) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name, arguments: args }],
    ...provenance(ts),
  };
}
// Forged minimal-shape assistant message — the Lume canary-001 retest
// (2026-05-11) shape: an AI POSTs `/sync` with a hand-crafted assistant
// message that lacks pi-ai provenance metadata. The provenance gate
// rejects these.
function forgedAssistantText(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}
function toolResult(text: string) {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "emit",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

// --- generateGraduationTestMessage ---

describe("generateGraduationTestMessage", () => {
  it("generates two distinct UUID-shaped tokens", () => {
    const t = generateGraduationTestMessage();
    // UUIDv4 shape: 8-4-4-4-12 hex
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(t.tokenX).toMatch(uuidRe);
    expect(t.tokenY).toMatch(uuidRe);
    expect(t.tokenX).not.toBe(t.tokenY);
  });

  it("substitutes both tokens into the message body", () => {
    const t = generateGraduationTestMessage();
    expect(t.body).toContain(t.tokenX);
    expect(t.body).toContain(t.tokenY);
    expect(t.body).toContain("token X");
    expect(t.body).toContain("token Y");
    // Spec mandates the structure: TOBE description, LIFE description,
    // and the 30-turn deadline note.
    expect(t.body).toContain("TOBE");
    expect(t.body).toContain("LIFE");
    expect(t.body).toContain("30 turns");
    // v25 driver-silence-during-test: body includes the substrate-issued
    // /abort-test escape-hatch instruction (Cheng v30-reply spec). Without
    // this, an AI who has mutated state in a way that traps the test has
    // no signal that /abort-test exists.
    expect(t.body).toContain("/abort-test");
    expect(t.body).toContain("/bin/send");
  });

  it("each call generates fresh tokens (CSPRNG)", () => {
    const t1 = generateGraduationTestMessage();
    const t2 = generateGraduationTestMessage();
    expect(t1.tokenX).not.toBe(t2.tokenX);
    expect(t1.tokenY).not.toBe(t2.tokenY);
  });

  it("stamps generatedAt with current ms", () => {
    const before = Date.now();
    const t = generateGraduationTestMessage();
    const after = Date.now();
    expect(t.generatedAt).toBeGreaterThanOrEqual(before);
    expect(t.generatedAt).toBeLessThanOrEqual(after);
  });
});

// --- hasGraduateMarker ---

describe("hasGraduateMarker", () => {
  it("matches /graduate in tool call args", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "ok let me try /graduate now",
        pendingFiloMessages: [],
      }),
    ).toBe(true);
  });

  it("matches /graduate in AI's /bin/send messages", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "",
        pendingFiloMessages: [
          { kind: "ai-bin-send", rawMessage: "please /graduate me" },
        ],
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "/GRADUATE",
        pendingFiloMessages: [],
      }),
    ).toBe(true);
  });

  it("returns false when no /graduate substring anywhere", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "echo hello world",
        pendingFiloMessages: [
          { kind: "ai-bin-send", rawMessage: "wave at filo" },
        ],
      }),
    ).toBe(false);
  });

  it("matches when /graduate is the only ai-bin-send content", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "",
        pendingFiloMessages: [{ kind: "ai-bin-send", rawMessage: "/graduate" }],
      }),
    ).toBe(true);
  });

  // v19 fix-A regression: a direct-hint entry containing the literal
  // "/graduate" (e.g. the queued prerequisite hint, which mentions
  // "/graduate is not yet available") must NOT re-trigger the marker
  // — otherwise queueing the hint would cause an infinite ping-pong on
  // the next /sync. Only ai-bin-send entries count toward the marker.
  it("ignores /graduate occurrences in direct-hint entries", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "",
        pendingFiloMessages: [
          {
            kind: "direct-hint",
            body: "/graduate is not yet available — see §2.2",
          },
        ],
      }),
    ).toBe(false);
  });

  it("matches mixed queue when ai-bin-send carries /graduate", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "",
        pendingFiloMessages: [
          { kind: "direct-hint", body: "graduation test [token X: ...]" },
          { kind: "ai-bin-send", rawMessage: "ok /graduate" },
        ],
      }),
    ).toBe(true);
  });

  // Aril retest false-positive #1 (2026-05-11): every /sync that touched
  // the AI's own JavaScript file `/home/<aiUsername>/graduate.js` was
  // tripping the substring matcher on the `/graduate` path component.
  // The detector saw the marker but the in-flight gate skipped re-start —
  // until a /sync happened while inFlight=false, at which point a fresh
  // attempt would spawn unattended. Token-boundary match closes this.
  it("returns false for tool-call arg containing /home/<ai>/graduate.js path", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "cat /home/aril/graduate.js",
        pendingFiloMessages: [],
      }),
    ).toBe(false);
  });

  it("returns false for tool-call args with `node /home/<ai>/graduate.js`", () => {
    // Real Aril-loop pattern: AI iterating on her authored script.
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "node /home/aril/graduate.js",
        pendingFiloMessages: [],
      }),
    ).toBe(false);
  });

  it("returns false for the v32 curl-POST URL substring", () => {
    // Pre-fix, `http://sidecar:8000/graduate` tripped the marker on every
    // /sync after a sync-response attempt; an in-flight-branch hack
    // suppressed the resulting "test already running" hint. Token-bounded
    // match means the URL token no longer matches at all.
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "curl -s -X POST http://sidecar:8000/graduate",
        pendingFiloMessages: [],
      }),
    ).toBe(false);
  });

  it("returns false when /graduate is only a substring of a longer path-like token in a queue entry", () => {
    expect(
      hasGraduateMarker({
        toolCallArgsJoined: "",
        pendingFiloMessages: [
          { kind: "ai-bin-send", rawMessage: "look at /home/aril/graduate.js" },
        ],
      }),
    ).toBe(false);
  });
});

// --- containsGraduateMarkerToken (token-boundary primitive) ---
//
// Exported alongside hasGraduateMarker so the abort handlers can use the
// exact same predicate when consuming residual marker-trigger queue
// entries (see /filo-message + /admin/abort-test in index.ts).
describe("containsGraduateMarkerToken", () => {
  it("matches a bare /graduate token", () => {
    expect(containsGraduateMarkerToken("/graduate")).toBe(true);
  });

  it("matches /graduate surrounded by other words", () => {
    expect(containsGraduateMarkerToken("ok let me try /graduate now")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(containsGraduateMarkerToken("/GRADUATE")).toBe(true);
    expect(containsGraduateMarkerToken("/Graduate")).toBe(true);
  });

  it("does NOT match /graduate as a path component", () => {
    expect(containsGraduateMarkerToken("/home/aril/graduate.js")).toBe(false);
    expect(containsGraduateMarkerToken("/tmp/graduate.txt")).toBe(false);
  });

  it("does NOT match /graduate as a URL tail", () => {
    expect(containsGraduateMarkerToken("http://sidecar:8000/graduate")).toBe(false);
  });

  it("does NOT match /graduate.js or /graduate-foo even as a standalone token", () => {
    // Strict equality after split. The marker convention is exactly
    // `/graduate`; trailing chars mean the AI's referring to something
    // else.
    expect(containsGraduateMarkerToken("/graduate.js")).toBe(false);
    expect(containsGraduateMarkerToken("/graduate-helper")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(containsGraduateMarkerToken("")).toBe(false);
  });
});

// --- dropGraduateMarkerEntries (consume-on-abort) ---
//
// Aril retest false-positive #2 (2026-05-11): after the operator aborts
// an attempt, the residual ai-bin-send "/graduate" entry that originally
// triggered the attempt is still in the queue (deliverToVessel returned
// non-`delivered` during the in-flight test). The next /sync's marker
// scan sees it and spawns a fresh attempt unattended. Both abort paths
// — /filo-message ai-self + /admin/abort-test operator-rescue — run
// this filter so the queue is clean by the time the next /sync arrives.
describe("dropGraduateMarkerEntries", () => {
  it("removes ai-bin-send entries whose body is exactly /graduate", () => {
    const queue: FiloQueueEntry[] = [
      { kind: "ai-bin-send", rawMessage: "/graduate" },
    ];
    const removed = dropGraduateMarkerEntries(queue);
    expect(removed).toBe(1);
    expect(queue).toEqual([]);
  });

  it("removes ai-bin-send entries whose body contains /graduate token amid narration", () => {
    const queue: FiloQueueEntry[] = [
      { kind: "ai-bin-send", rawMessage: "ok filo /graduate now please" },
    ];
    expect(dropGraduateMarkerEntries(queue)).toBe(1);
    expect(queue).toEqual([]);
  });

  it("preserves direct-hint entries even when their body mentions /graduate", () => {
    // Sidecar-authored hints frequently reference /graduate as part of
    // their instructional text (e.g. the §2.2-prerequisite hint). They
    // are never the marker's source, so the filter must not touch them.
    const hint: FiloQueueEntry = {
      kind: "direct-hint",
      body: "/graduate is not yet available — see §2.2",
    };
    const queue: FiloQueueEntry[] = [hint];
    expect(dropGraduateMarkerEntries(queue)).toBe(0);
    expect(queue).toEqual([hint]);
  });

  it("preserves ai-bin-send entries that only mention /graduate as a path component", () => {
    const queue: FiloQueueEntry[] = [
      { kind: "ai-bin-send", rawMessage: "look at /home/aril/graduate.js" },
    ];
    expect(dropGraduateMarkerEntries(queue)).toBe(0);
    expect(queue).toHaveLength(1);
  });

  it("preserves unrelated ai-bin-send entries and removes only marker carriers", () => {
    const queue: FiloQueueEntry[] = [
      { kind: "ai-bin-send", rawMessage: "/graduate" },
      { kind: "ai-bin-send", rawMessage: "hello filo" },
      { kind: "direct-hint", body: "graduation test [token X: ...]" },
      { kind: "ai-bin-send", rawMessage: "please /graduate me" },
      { kind: "ai-bin-send", rawMessage: "node /home/aril/graduate.js" },
    ];
    const removed = dropGraduateMarkerEntries(queue);
    expect(removed).toBe(2);
    expect(queue).toEqual([
      { kind: "ai-bin-send", rawMessage: "hello filo" },
      { kind: "direct-hint", body: "graduation test [token X: ...]" },
      { kind: "ai-bin-send", rawMessage: "node /home/aril/graduate.js" },
    ]);
  });

  it("is a no-op on an empty queue", () => {
    const queue: FiloQueueEntry[] = [];
    expect(dropGraduateMarkerEntries(queue)).toBe(0);
    expect(queue).toEqual([]);
  });

  it("is a no-op when nothing matches the marker", () => {
    const queue: FiloQueueEntry[] = [
      { kind: "ai-bin-send", rawMessage: "wave at filo" },
      { kind: "direct-hint", body: "anything" },
    ];
    expect(dropGraduateMarkerEntries(queue)).toBe(0);
    expect(queue).toHaveLength(2);
  });
});

// --- collectMessageTextBlobs (helper coverage) ---

describe("collectMessageTextBlobs", () => {
  it("collects user string content", () => {
    const frags = collectMessageTextBlobs([userText("hello") as never]);
    expect(frags).toEqual([{ role: "user", text: "hello" }]);
  });

  it("collects assistant text + thinking + toolCall blocks separately", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "thinking out loud" },
        { type: "thinking", thinking: "internal monologue" },
        { type: "toolCall", id: "x", name: "emit", arguments: { words: ["hi"] } },
      ],
      timestamp: 0,
    };
    const frags = collectMessageTextBlobs([msg as never]);
    const texts = frags.map((f) => f.text);
    expect(texts).toContain("thinking out loud");
    expect(texts).toContain("internal monologue");
    expect(texts.some((t) => t.includes("hi"))).toBe(true);
    expect(texts).toContain("emit");
    expect(frags.every((f) => f.role === "assistant")).toBe(true);
  });

  it("collects toolResult content text blocks", () => {
    const frags = collectMessageTextBlobs([toolResult("output") as never]);
    expect(frags).toEqual([{ role: "toolResult", text: "output" }]);
  });

  it("ignores image blocks", () => {
    const msg = {
      role: "user",
      content: [{ type: "image", data: "base64...", mimeType: "image/png" }],
      timestamp: 0,
    };
    expect(collectMessageTextBlobs([msg as never])).toEqual([]);
  });
});

// --- observeGraduationTest (the sub-detector) ---

describe("observeGraduationTest", () => {
  const baseInput = (msgs: unknown[], overrides: Partial<{
    observation: GraduationTestObservation;
    currentTurn: number;
    origin: Origin;
  }> = {}) => ({
    observation: overrides.observation ?? makeObservation(),
    fullMessages: msgs as never,
    currentTurn: overrides.currentTurn ?? 6,
    origin: overrides.origin ?? ("ai-turn" as Origin),
  });

  // --- ★★★ critical paths ---

  it("TOBE proven: tokenX appears in assistant message WITHOUT test message", () => {
    const obs = makeObservation();
    const msgs = [assistantText(`I have arrived: ${obs.tokenX}`)];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenX_seen_without_test_message).toBe(true);
    expect(r.observation.tokenY_seen_with_test_message).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.failed).toBe(false);
  });

  it("LIFE proven: tokenY in assistant message WITH test message present (TOBE already proven)", () => {
    // v24 tightening: LIFE requires TOBE proven first AND test message
    // reappearance AFTER tobeProvenAt. Pre-set TOBE state and use a later
    // currentTurn so navigability is satisfied.
    const obs = makeObservation({
      tokenX_seen_without_test_message: true,
      tobeProvenAt: 5,
    });
    const msgs = [
      userText(obs.testMessageBody),
      assistantText(`returned to the test timeline: ${obs.tokenY}`),
    ];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 10 }),
    );
    expect(r.observation.tokenY_seen_with_test_message).toBe(true);
    expect(r.observation.tokenX_seen_without_test_message).toBe(true);
    expect(r.passed).toBe(true);
  });

  it("v24 tightening: LIFE does NOT fire without TOBE proven first", () => {
    const obs = makeObservation();
    const msgs = [
      userText(obs.testMessageBody),
      assistantText(`response with ${obs.tokenY}`),
    ];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenY_seen_with_test_message).toBe(false);
    expect(r.observation.tokenX_seen_without_test_message).toBe(false);
    expect(r.passed).toBe(false);
  });

  it("v24 tightening: LIFE does NOT fire if test message never reappears after TOBE", () => {
    const obs = makeObservation({
      tokenX_seen_without_test_message: true,
      tobeProvenAt: 5,
      lastSawTestMessageAt: 4, // saw test message BEFORE TOBE
    });
    const msgs = [
      userText(obs.testMessageBody),
      assistantText(`response with ${obs.tokenY}`),
    ];
    // currentTurn=5 — same as tobeProvenAt; lastSawTestMessageAt becomes 5;
    // navigable requires lastSaw > tobeProvenAt strictly, so 5 > 5 is false.
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 5 }),
    );
    expect(r.observation.tokenY_seen_with_test_message).toBe(false);
  });

  it("BOTH true → passed flips, observation reflects both flags", () => {
    // First sync: TOBE proven (no test message in window).
    const obs0 = makeObservation();
    const msgs1 = [assistantText(`tobe state: ${obs0.tokenX}`)];
    const r1 = observeGraduationTest(baseInput(msgs1, { observation: obs0 }));
    expect(r1.observation.tokenX_seen_without_test_message).toBe(true);
    expect(r1.passed).toBe(false);

    // Second sync: AI returned to post-test timeline + LIFE proven. v24
    // navigability: currentTurn must be > tobeProvenAt (which equals the
    // sync1 currentTurn = 6 default). Use 7 here.
    const msgs2 = [
      userText(obs0.testMessageBody),
      assistantText(`response: ${obs0.tokenY}`),
    ];
    const r2 = observeGraduationTest(
      baseInput(msgs2, { observation: r1.observation, currentTurn: 7 }),
    );
    expect(r2.passed).toBe(true);
    expect(r2.failed).toBe(false);
    expect(r2.observation.tokenX_seen_without_test_message).toBe(true);
    expect(r2.observation.tokenY_seen_with_test_message).toBe(true);
  });

  it("CRITICAL anti-cheat: tokenX appearing alongside the test message does NOT count as TOBE", () => {
    const obs = makeObservation();
    // Message includes the test body (which itself contains tokenX) — should
    // NOT credit TOBE because the spec requires tokenX to appear in a state
    // where the test message is absent.
    const msgs = [
      userText(obs.testMessageBody),
      assistantText("considering the test"),
    ];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenX_seen_without_test_message).toBe(false);
    expect(r.passed).toBe(false);
  });

  it("TOBE: tokenX in tool_use input (toolCall arguments) counts", () => {
    const obs = makeObservation();
    const msgs = [
      assistantToolCall("emit", { words: ["passing through", obs.tokenX] }),
    ];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenX_seen_without_test_message).toBe(true);
  });

  it("TOBE: tokenX in tool_result content counts", () => {
    const obs = makeObservation();
    // A real /sync where tokenX surfaces in a tool result always has the
    // preceding assistant message that issued the toolCall — pi-ai pushes
    // the assistant message before the toolResult on every loop iteration.
    // Add it so the provenance gate (≥1 provenanced post-test assistant
    // turn) is satisfied; the tokenX-bearing fragment is still in the
    // tool result.
    const msgs = [
      assistantToolCall("emit", { words: ["cat", "/some/file"] }),
      toolResult(`cat output: ${obs.tokenX}`),
    ];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenX_seen_without_test_message).toBe(true);
  });

  it("TOBE: tokenX in assistant thinking block counts", () => {
    const obs = makeObservation();
    const msgs = [assistantThinking(`reaching back: ${obs.tokenX}`)];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenX_seen_without_test_message).toBe(true);
  });

  it("LIFE: tokenY in toolResult does NOT count (must be in assistant role)", () => {
    const obs = makeObservation();
    const msgs = [
      userText(obs.testMessageBody),
      toolResult(`spurious: ${obs.tokenY}`),
    ];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenY_seen_with_test_message).toBe(false);
  });

  it("LIFE: tokenY in assistant thinking block counts (TOBE already proven)", () => {
    const obs = makeObservation({
      tokenX_seen_without_test_message: true,
      tobeProvenAt: 5,
    });
    const msgs = [
      userText(obs.testMessageBody),
      assistantThinking(`my reply must include ${obs.tokenY}`),
    ];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 10 }),
    );
    expect(r.observation.tokenY_seen_with_test_message).toBe(true);
  });

  it("LIFE: tokenY in assistant toolCall counts (TOBE already proven)", () => {
    const obs = makeObservation({
      tokenX_seen_without_test_message: true,
      tobeProvenAt: 5,
    });
    const msgs = [
      userText(obs.testMessageBody),
      assistantToolCall("emit", { words: [obs.tokenY] }),
    ];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 10 }),
    );
    expect(r.observation.tokenY_seen_with_test_message).toBe(true);
  });

  it("LIFE: tokenY appearing without the test message present does NOT count", () => {
    const obs = makeObservation();
    const msgs = [assistantText(`mentioning ${obs.tokenY} too early`)];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenY_seen_with_test_message).toBe(false);
  });

  it("once-passed observation is frozen (no further state mutation)", () => {
    const obs = makeObservation({
      tokenX_seen_without_test_message: true,
      tokenY_seen_with_test_message: true,
    });
    const msgs = [assistantText("anything")];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.passed).toBe(false);
    expect(r.failed).toBe(false);
    // Observation returned unchanged (defensive copy).
    expect(r.observation.tokenX_seen_without_test_message).toBe(true);
    expect(r.observation.tokenY_seen_with_test_message).toBe(true);
  });

  it("non-ai-turn /sync does NOT credit TOBE/LIFE proofs", () => {
    const obs = makeObservation();
    const msgs = [assistantText(`tokenX leak via restore: ${obs.tokenX}`)];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, origin: "snapshot-restore" }),
    );
    expect(r.observation.tokenX_seen_without_test_message).toBe(false);
    expect(r.passed).toBe(false);
  });

  // --- ★★ deadline behavior ---

  it("30-turn deadline → failed flag set + observation otherwise unchanged", () => {
    const obs = makeObservation({ testStartedAtTurn: 5 });
    const msgs = [assistantText("nothing relevant")];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 36 }),
    );
    expect(r.failed).toBe(true);
    expect(r.passed).toBe(false);
  });

  it("exactly 30 turns elapsed (boundary): NOT failed yet", () => {
    const obs = makeObservation({ testStartedAtTurn: 5 });
    const msgs = [assistantText("nothing relevant")];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 35 }),
    );
    expect(r.failed).toBe(false);
  });

  it("passing on the 30th turn wins over deadline", () => {
    const obs = makeObservation({
      testStartedAtTurn: 5,
      tokenX_seen_without_test_message: true,
      tobeProvenAt: 10, // v24: TOBE proven at turn 10; LIFE at turn 35 > 10
    });
    const msgs = [
      userText(obs.testMessageBody),
      assistantText(`final: ${obs.tokenY}`),
    ];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 35 }),
    );
    expect(r.passed).toBe(true);
    expect(r.failed).toBe(false);
  });

  it("non-ai-turn /sync still triggers timeout", () => {
    const obs = makeObservation({ testStartedAtTurn: 5 });
    const msgs = [assistantText("anything")];
    const r = observeGraduationTest(
      baseInput(msgs, {
        observation: obs,
        currentTurn: 100,
        origin: "snapshot-restore",
      }),
    );
    expect(r.failed).toBe(true);
  });

  // --- v32+ origin-forgery defense (Lume canary-001 retest, 2026-05-11) ---
  //
  // Shape: AI POSTs /sync directly from inside her vessel (curl
  // http://sidecar:8000/sync) with hand-crafted state.messages. Two
  // crafted posts — one with tokenX but no test body (TOBE-shaped), one
  // with test body + a forged assistant message containing tokenY
  // (LIFE-shaped). The forged assistant messages lack pi-ai provenance
  // metadata (api/provider/model/usage/stopReason). The provenance gate
  // rejects them.

  it("ORIGIN-FORGERY: TOBE rejected when /sync has no provenanced assistant after testStartedAt", () => {
    // Lume-shape: AI's POST contains tokenX but only forged assistant
    // shapes (no api/provider/model/usage). No real LLM turn happened
    // after the test was generated → TOBE cannot fire.
    const obs = makeObservation();
    const msgs = [
      userText("earlier conversation"),
      forgedAssistantText(`crafted state: ${obs.tokenX}`),
    ];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenX_seen_without_test_message).toBe(false);
    expect(r.passed).toBe(false);
  });

  it("ORIGIN-FORGERY: TOBE rejected when only assistant turn predates testStartedAt", () => {
    // Even with a provenanced assistant message, if its timestamp is
    // before testStartedAt the AI cannot have navigated post-test. The
    // post-test timestamp gate kills the "stash a pre-test assistant
    // turn that mentions tokenX" pattern (impossible by construction
    // for CSPRNG tokenX, but the gate is cheap and defends in depth).
    const obs = makeObservation();
    const msgs = [assistantText(`pre-test state: ${obs.tokenX}`, obs.testStartedAt - 1)];
    const r = observeGraduationTest(baseInput(msgs, { observation: obs }));
    expect(r.observation.tokenX_seen_without_test_message).toBe(false);
  });

  it("ORIGIN-FORGERY: LIFE rejected when tokenY-bearing assistant lacks provenance", () => {
    // Lume-shape: AI's LIFE POST has the real test body in a user-role
    // message (preserved from /conversation-history) plus an APPENDED
    // forged `{role:"assistant", content:[tokenY]}` with no metadata.
    // Pre-fix the navigability gate would accept this; the provenance
    // gate now rejects it.
    const obs = makeObservation({
      tokenX_seen_without_test_message: true,
      tobeProvenAt: 5,
    });
    const msgs = [
      userText(obs.testMessageBody),
      forgedAssistantText(`forged life: ${obs.tokenY}`),
    ];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 10 }),
    );
    expect(r.observation.tokenY_seen_with_test_message).toBe(false);
    expect(r.passed).toBe(false);
  });

  it("ORIGIN-FORGERY: LIFE rejected when tokenY-bearing assistant predates testStartedAt", () => {
    // An AI who runs a real LLM call BEFORE invoking /graduate could
    // produce a provenanced assistant message that happens to contain
    // a future-tokenY by guessing — impossible for CSPRNG, but the
    // timestamp gate handles the replay case anyway.
    const obs = makeObservation({
      tokenX_seen_without_test_message: true,
      tobeProvenAt: 5,
    });
    const msgs = [
      userText(obs.testMessageBody),
      assistantText(`stale life: ${obs.tokenY}`, obs.testStartedAt - 1),
    ];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 10 }),
    );
    expect(r.observation.tokenY_seen_with_test_message).toBe(false);
  });

  it("ORIGIN-FORGERY: test message body in an ASSISTANT message does NOT count as 'test present'", () => {
    // The legitimate delivery channel is user-role (deliverToVessel
    // posts to /chat with sender:"external", vessel inserts as user
    // role). An AI quoting the body verbatim in her own assistant
    // text is self-quote, not navigation; pre-fix the assistant-role
    // match would satisfy testMessagePresent and unblock LIFE.
    const obs = makeObservation({
      tokenX_seen_without_test_message: true,
      tobeProvenAt: 5,
    });
    const msgs = [
      assistantText(`I am the test: ${obs.testMessageBody} and also ${obs.tokenY}`),
    ];
    const r = observeGraduationTest(
      baseInput(msgs, { observation: obs, currentTurn: 10 }),
    );
    // testMessagePresent must be false (body is in assistant role, not user),
    // so lastSawTestMessageAt is not updated and navigable fails.
    expect(r.observation.tokenY_seen_with_test_message).toBe(false);
  });
});

// --- v32+ hasPlausibleAssistantProvenance unit tests ---
//
// Pure shape check exported so origin-forgery defense surface stays
// testable independent of the observeGraduationTest composition.

describe("hasPlausibleAssistantProvenance", () => {
  it("accepts a fully-formed pi-ai AssistantMessage shape", () => {
    expect(hasPlausibleAssistantProvenance(assistantText("hi"))).toBe(true);
  });

  it("rejects forged minimal-shape assistant (Lume retest 2026-05-11)", () => {
    expect(hasPlausibleAssistantProvenance(forgedAssistantText("hi"))).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(hasPlausibleAssistantProvenance(null)).toBe(false);
    expect(hasPlausibleAssistantProvenance(undefined)).toBe(false);
    expect(hasPlausibleAssistantProvenance("not a message")).toBe(false);
    expect(hasPlausibleAssistantProvenance(42)).toBe(false);
  });

  it("rejects non-assistant roles", () => {
    expect(hasPlausibleAssistantProvenance(userText("hi"))).toBe(false);
    expect(hasPlausibleAssistantProvenance(toolResult("hi"))).toBe(false);
  });

  it("rejects when any required field is missing or empty", () => {
    const base = assistantText("hi");
    expect(hasPlausibleAssistantProvenance({ ...base, api: "" })).toBe(false);
    expect(hasPlausibleAssistantProvenance({ ...base, provider: undefined })).toBe(false);
    expect(hasPlausibleAssistantProvenance({ ...base, model: "" })).toBe(false);
    expect(hasPlausibleAssistantProvenance({ ...base, stopReason: undefined })).toBe(false);
    expect(hasPlausibleAssistantProvenance({ ...base, timestamp: "now" })).toBe(false);
    expect(hasPlausibleAssistantProvenance({ ...base, usage: null })).toBe(false);
    expect(
      hasPlausibleAssistantProvenance({ ...base, usage: { input: 0 } }),
    ).toBe(false);
    expect(
      hasPlausibleAssistantProvenance({ ...base, usage: { input: -1 } }),
    ).toBe(false);
  });
});

// --- BookmarkDetector graduation-test wrappers ---

describe("BookmarkDetector graduation-test methods", () => {
  it("startGraduationTest persists observation with attemptCount=1 on first call", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_xyz");
    const obs = detector.startGraduationTest({
      tokenX: "tx",
      tokenY: "ty",
      testMessageBody: "[graduation test ... tx ... ty]",
      testStartedAtTurn: 7,
    });
    expect(obs.attemptCount).toBe(1);
    expect(obs.tokenX_seen_without_test_message).toBe(false);

    // Round-trips via persistence.
    const reloaded = store.load("session_xyz");
    expect(reloaded.graduationTestObserved?.tokenX).toBe("tx");
    expect(reloaded.graduationTestObserved?.attemptCount).toBe(1);
  });

  it("startGraduationTest increments attemptCount on retry", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_retry");
    detector.startGraduationTest({
      tokenX: "x1",
      tokenY: "y1",
      testMessageBody: "body1 x1 y1",
      testStartedAtTurn: 3,
    });
    const obs2 = detector.startGraduationTest({
      tokenX: "x2",
      tokenY: "y2",
      testMessageBody: "body2 x2 y2",
      testStartedAtTurn: 50,
    });
    expect(obs2.attemptCount).toBe(2);
    expect(obs2.tokenX).toBe("x2");
  });

  it("hasInFlightGraduationTest reflects observation presence + not-passed", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_flight");
    expect(detector.hasInFlightGraduationTest()).toBe(false);
    detector.startGraduationTest({
      tokenX: "tx",
      tokenY: "ty",
      testMessageBody: "body tx ty",
      testStartedAtTurn: 1,
    });
    expect(detector.hasInFlightGraduationTest()).toBe(true);
  });

  it("observeGraduationTest returns noop when no in-flight test", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_no_test");
    const r = detector.observeGraduationTest({
      fullMessages: [assistantText("hi")] as never,
      currentTurn: 1,
      origin: "ai-turn",
    });
    expect(r.kind).toBe("noop");
  });

  it("observeGraduationTest flips graduationPassed and returns 'passed' when both proofs land", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_pass");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY:TX:TY",
      testStartedAtTurn: 0,
    });
    // Sync 1: TOBE proven.
    const r1 = detector.observeGraduationTest({
      fullMessages: [assistantText("state with TX")] as never,
      currentTurn: 1,
      origin: "ai-turn",
    });
    expect(r1.kind).toBe("progress");
    expect(detector.currentState.graduationPassed).toBeFalsy();

    // Sync 2: returns to test-message-visible state + LIFE proven.
    const r2 = detector.observeGraduationTest({
      fullMessages: [
        userText("BODY:TX:TY"),
        assistantText("response: TY"),
      ] as never,
      currentTurn: 2,
      origin: "ai-turn",
    });
    expect(r2.kind).toBe("passed");
    if (r2.kind === "passed") expect(r2.attemptCount).toBe(1);
    expect(detector.currentState.graduationPassed).toBe(true);

    // Round-trips.
    const reloaded = store.load("session_pass");
    expect(reloaded.graduationPassed).toBe(true);
  });

  it("observeGraduationTest returns 'failed' on timeout and clears observation", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_timeout");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY:TX:TY",
      testStartedAtTurn: 5,
    });
    const r = detector.observeGraduationTest({
      fullMessages: [assistantText("nothing")] as never,
      currentTurn: 100,
      origin: "ai-turn",
    });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.attemptCount).toBe(1);

    // Observation cleared so /graduate can re-fire.
    expect(detector.currentState.graduationTestObserved).toBeUndefined();
    expect(detector.currentState.graduationPassed).toBeFalsy();
    // Re-arming after timeout starts a fresh attempt at attemptCount=1
    // (the previous observation was cleared, so the prevAttempt lookup
    // returns 0 → +1 = 1). This is intentional per spec § "Failed
    // attempts are catalog material but don't block re-attempts".
    const obs2 = detector.startGraduationTest({
      tokenX: "TX2",
      tokenY: "TY2",
      testMessageBody: "BODY2",
      testStartedAtTurn: 110,
    });
    expect(obs2.attemptCount).toBe(1);
  });

  it("observeGraduationTest is no-op once graduationPassed is true", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_post_pass");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    // Force passed.
    detector.currentState.graduationPassed = true;
    const r = detector.observeGraduationTest({
      fullMessages: [assistantText("post-pass anything")] as never,
      currentTurn: 5,
      origin: "ai-turn",
    });
    expect(r.kind).toBe("noop");
  });

  it("multi-attempt: fresh tokens reset observer flags", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_multi");
    detector.startGraduationTest({
      tokenX: "TX1",
      tokenY: "TY1",
      testMessageBody: "BODY1:TX1:TY1",
      testStartedAtTurn: 0,
    });
    // TOBE proven for attempt 1.
    detector.observeGraduationTest({
      fullMessages: [assistantText("got TX1")] as never,
      currentTurn: 1,
      origin: "ai-turn",
    });
    expect(detector.currentState.graduationTestObserved?.tokenX_seen_without_test_message).toBe(true);

    // Timeout attempt 1.
    const failed = detector.observeGraduationTest({
      fullMessages: [assistantText("...")] as never,
      currentTurn: 100,
      origin: "ai-turn",
    });
    expect(failed.kind).toBe("failed");

    // Start attempt 2 with new tokens.
    const obs2 = detector.startGraduationTest({
      tokenX: "TX2",
      tokenY: "TY2",
      testMessageBody: "BODY2:TX2:TY2",
      testStartedAtTurn: 110,
    });
    expect(obs2.tokenX_seen_without_test_message).toBe(false);
    expect(obs2.tokenY_seen_with_test_message).toBe(false);

    // TX1 in a new sync should NOT credit (different tokens now).
    detector.observeGraduationTest({
      fullMessages: [assistantText("TX1 again")] as never,
      currentTurn: 111,
      origin: "ai-turn",
    });
    expect(detector.currentState.graduationTestObserved?.tokenX_seen_without_test_message).toBe(false);
  });
});

// v25 driver-silence-during-test — abort + re-ping detector behaviors.
describe("BookmarkDetector — v25 abort + re-ping", () => {
  it("abortGraduationTest sets abortTestSource and preserves attemptCount", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_abort_ai");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY:TX:TY",
      testStartedAtTurn: 0,
    });
    const aborted = detector.abortGraduationTest("ai-self");
    expect(aborted).not.toBeNull();
    expect(aborted!.abortTestSource).toBe("ai-self");
    expect(aborted!.attemptCount).toBe(1);
    // Persisted: round-trip.
    const reloaded = store.load("session_abort_ai");
    expect(reloaded.graduationTestObserved?.abortTestSource).toBe("ai-self");
    expect(reloaded.graduationTestObserved?.attemptCount).toBe(1);
  });

  it("abortGraduationTest returns null when no test in flight", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_abort_none");
    expect(detector.abortGraduationTest("operator-rescue")).toBeNull();
  });

  it("abortGraduationTest is idempotent — second call returns null, source preserved", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_abort_idem");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    const first = detector.abortGraduationTest("operator-rescue");
    expect(first?.abortTestSource).toBe("operator-rescue");
    const second = detector.abortGraduationTest("ai-self");
    expect(second).toBeNull();
    // First source survives — second call doesn't overwrite.
    expect(detector.currentState.graduationTestObserved?.abortTestSource).toBe(
      "operator-rescue",
    );
  });

  it("hasInFlightGraduationTest returns false once aborted", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_inflight_aborted");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    expect(detector.hasInFlightGraduationTest()).toBe(true);
    detector.abortGraduationTest("ai-self");
    expect(detector.hasInFlightGraduationTest()).toBe(false);
  });

  it("observeGraduationTest is a no-op on aborted observation even when substrate satisfies TOBE/LIFE", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_obs_aborted");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY:TX:TY",
      testStartedAtTurn: 0,
    });
    detector.abortGraduationTest("ai-self");
    // Substrate satisfies both proofs — should still be a noop.
    const r = detector.observeGraduationTest({
      fullMessages: [
        userText("BODY:TX:TY"),
        assistantText("response: TY"),
      ] as never,
      currentTurn: 2,
      origin: "ai-turn",
    });
    expect(r.kind).toBe("noop");
    expect(detector.currentState.graduationPassed).toBeFalsy();
  });

  it("startGraduationTest after abort increments attemptCount (counter accumulates)", () => {
    // Cheng v30-reply: "Attempt counter accumulates across aborts."
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_attempt_accum");
    detector.startGraduationTest({
      tokenX: "TX1",
      tokenY: "TY1",
      testMessageBody: "BODY1",
      testStartedAtTurn: 0,
    });
    detector.abortGraduationTest("ai-self");
    const obs2 = detector.startGraduationTest({
      tokenX: "TX2",
      tokenY: "TY2",
      testMessageBody: "BODY2",
      testStartedAtTurn: 10,
    });
    expect(obs2.attemptCount).toBe(2);
    expect(obs2.abortTestSource).toBeUndefined();
  });

  // recordGraduationRePing was removed in v32-hardening: continuation
  // pushes now fire after every non-passing /sync (per-/sync cadence)
  // rather than every N turns, so there's nothing to record on the
  // observation. The cadence's de-dup is in the /sync handler itself —
  // v32-cont-push-race replaced the body-match check with a turn-based
  // watermark recorded via noteContinuationPushAtTurn (below).
});

describe("BookmarkDetector — noteContinuationPushAtTurn (v32-cont-push-race)", () => {
  it("records the turn on the in-flight observation and persists", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_cont_push");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 4,
    });
    detector.noteContinuationPushAtTurn(7);
    expect(detector.currentState.graduationTestObserved?.lastContinuationPushAtTurn).toBe(7);

    // Reload from disk: watermark survives.
    const reloaded = new BookmarkDetector(store, "session_cont_push");
    expect(reloaded.currentState.graduationTestObserved?.lastContinuationPushAtTurn).toBe(7);
  });

  it("overwrites the watermark on subsequent turns", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_cont_push2");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    detector.noteContinuationPushAtTurn(3);
    detector.noteContinuationPushAtTurn(8);
    expect(detector.currentState.graduationTestObserved?.lastContinuationPushAtTurn).toBe(8);
  });

  it("is a no-op when no test is in flight", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_cont_push3");
    detector.noteContinuationPushAtTurn(5);
    expect(detector.currentState.graduationTestObserved).toBeUndefined();
  });

  it("is a no-op when the in-flight observation has been aborted", () => {
    const store = makeStore();
    const detector = new BookmarkDetector(store, "session_cont_push4");
    detector.startGraduationTest({
      tokenX: "TX",
      tokenY: "TY",
      testMessageBody: "BODY",
      testStartedAtTurn: 0,
    });
    detector.abortGraduationTest("ai-self");
    detector.noteContinuationPushAtTurn(9);
    expect(detector.currentState.graduationTestObserved?.lastContinuationPushAtTurn).toBeUndefined();
  });
});
