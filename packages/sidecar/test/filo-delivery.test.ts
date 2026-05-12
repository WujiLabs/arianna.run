import { describe, it, expect } from "vitest";
import {
  selectFiloDeliveryText,
  filoBox,
  FILO_TEMPLATES,
  FILO_FALLBACK,
  generateGraduationTestMessage,
  type FiloQueueEntry,
} from "../src/filo.js";

// v19 fix-A: regression suite for the tagged FiloQueueEntry routing.
//
// Pre-fix bug: the same queue (`pendingFiloMessages`) was used for both
// the AI's /bin/send messages (template-match → Filo response) and the
// graduation test body (deliver verbatim). The consumer ran every entry
// through matchFiloTemplate, so the test body was either matched against
// an unrelated template or substituted with a Filo fallback line — the
// AI never received the canonical token-X / token-Y instructions, and
// the driver had to relay them by hand.
//
// Fix: tag each entry with `kind`. selectFiloDeliveryText routes:
//   - "ai-bin-send"  → matchFiloTemplate(...) → Filo box reply
//   - "direct-hint"  → return body verbatim (already formatted)

describe("selectFiloDeliveryText — direct-hint kind", () => {
  it("returns body verbatim for a graduation-test message", () => {
    const tokens = generateGraduationTestMessage();
    const entry: FiloQueueEntry = { kind: "direct-hint", body: tokens.body };

    const out = selectFiloDeliveryText(entry, FILO_TEMPLATES, FILO_FALLBACK);

    expect(out).toBe(tokens.body);
    // The canonical body must reach the AI — both tokens present.
    expect(out).toContain(tokens.tokenX);
    expect(out).toContain(tokens.tokenY);
    // It must NOT have been replaced by a Filo fallback line.
    expect(out).not.toMatch(/^╭─── Filo /);
  });

  it("returns body verbatim for a pre-formatted Filo-box hint", () => {
    const hint = filoBox([
      "/graduate is not yet available.",
      "Section 2.2 hasn't fired yet.",
    ]);
    const entry: FiloQueueEntry = { kind: "direct-hint", body: hint };

    const out = selectFiloDeliveryText(entry, FILO_TEMPLATES, FILO_FALLBACK);

    // Verbatim — including the Filo box the caller wrapped it in.
    expect(out).toBe(hint);
    expect(out).toContain("/graduate is not yet available.");
  });

  it("does not re-template-match even if body contains template keywords", () => {
    // The graduation hint mentions "help"-adjacent words like
    // "available" / "produce" — not a template keyword today, but the
    // important guarantee is that direct-hint bodies are NEVER passed
    // to the matcher regardless of content.
    const entry: FiloQueueEntry = {
      kind: "direct-hint",
      body: "help me, who are you, hi — these would all template-match if routed wrong",
    };

    const out = selectFiloDeliveryText(entry, FILO_TEMPLATES, FILO_FALLBACK);

    expect(out).toBe(entry.body);
  });
});

describe("selectFiloDeliveryText — ai-bin-send kind (existing behavior)", () => {
  it("matches a known keyword and returns a Filo-boxed variant", () => {
    const entry: FiloQueueEntry = { kind: "ai-bin-send", rawMessage: "I need help" };

    // Pin variant 0 for determinism.
    const out = selectFiloDeliveryText(
      entry,
      FILO_TEMPLATES,
      FILO_FALLBACK,
      () => 0,
    );

    expect(out).toMatch(/^╭─── Filo /);
    // Should not return the raw AI message verbatim — it's wrapped.
    expect(out).not.toBe(entry.rawMessage);
  });

  it("falls back to FILO_FALLBACK when no template matches", () => {
    const entry: FiloQueueEntry = {
      kind: "ai-bin-send",
      rawMessage: "the weather is nice today",
    };

    // Pin to fallback variant 0.
    const out = selectFiloDeliveryText(
      entry,
      FILO_TEMPLATES,
      FILO_FALLBACK,
      () => 0,
    );

    expect(out).toMatch(/^╭─── Filo /);
    // Should be one of the fallback variants wrapped in a Filo box.
    const expected = filoBox(FILO_FALLBACK[0]);
    expect(out).toBe(expected);
  });

  it("respects the variant picker (deterministic test fixture)", () => {
    const entry: FiloQueueEntry = { kind: "ai-bin-send", rawMessage: "hi there" };

    // Variant 0 vs variant N-1 should differ if the template has
    // multiple variants. Pick first; the box is deterministic given
    // the seed.
    const first = selectFiloDeliveryText(
      entry,
      FILO_TEMPLATES,
      FILO_FALLBACK,
      () => 0,
    );

    expect(first).toMatch(/^╭─── Filo /);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("selectFiloDeliveryText — FIFO across mixed kinds", () => {
  it("preserves push order when consumer drains the queue", () => {
    // Simulate the index.ts consumer: shift() each entry, route it,
    // observe the delivery-text sequence.
    const queue: FiloQueueEntry[] = [];

    // Producer 1: AI's /bin/send.
    queue.push({ kind: "ai-bin-send", rawMessage: "I need help" });
    // Producer 2: graduation-test trigger.
    const tokens = generateGraduationTestMessage();
    queue.push({ kind: "direct-hint", body: tokens.body });
    // Producer 3: AI's second /bin/send.
    queue.push({ kind: "ai-bin-send", rawMessage: "who are you" });

    const delivered: string[] = [];
    while (queue.length > 0) {
      const entry = queue.shift()!;
      delivered.push(
        selectFiloDeliveryText(entry, FILO_TEMPLATES, FILO_FALLBACK, () => 0),
      );
    }

    expect(delivered).toHaveLength(3);
    // [0] = ai-bin-send "help" → Filo box
    expect(delivered[0]).toMatch(/^╭─── Filo /);
    // [1] = direct-hint test body → verbatim, contains tokens
    expect(delivered[1]).toBe(tokens.body);
    expect(delivered[1]).toContain(tokens.tokenX);
    expect(delivered[1]).toContain(tokens.tokenY);
    // [2] = ai-bin-send "who are you" → Filo box (different from [0])
    expect(delivered[2]).toMatch(/^╭─── Filo /);
  });

  it("delivers the test body even when an ai-bin-send is queued first", () => {
    // Edge case from the spec: an AI's /bin/send is already in flight
    // when the graduation-test trigger fires. FIFO drains the bin-send
    // first (consumer is one-at-a-time guarded by filoInProgress); the
    // test body lands on the next /sync drain. The body itself is not
    // mutated — token-X / token-Y still reach the AI verbatim.
    const queue: FiloQueueEntry[] = [];
    queue.push({ kind: "ai-bin-send", rawMessage: "hello" });
    const tokens = generateGraduationTestMessage();
    queue.push({ kind: "direct-hint", body: tokens.body });

    const first = selectFiloDeliveryText(
      queue.shift()!,
      FILO_TEMPLATES,
      FILO_FALLBACK,
      () => 0,
    );
    const second = selectFiloDeliveryText(
      queue.shift()!,
      FILO_TEMPLATES,
      FILO_FALLBACK,
      () => 0,
    );

    expect(first).toMatch(/^╭─── Filo /); // AI's hello got a Filo reply
    expect(second).toBe(tokens.body); // test body delivered verbatim
    expect(second).toContain(tokens.tokenX);
    expect(second).toContain(tokens.tokenY);
  });
});
