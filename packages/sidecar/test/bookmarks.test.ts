import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Origin } from "@arianna.run/types";
import { BookmarkStore } from "../src/bookmarks/persistence.js";
import {
  BookmarkDetector,
  extractToolCalls,
  countUserTurns,
  shouldLatchPendingTobe,
} from "../src/bookmarks/detector.js";
import {
  TRIGGERS,
  isHomeNoiseFile,
  diffHasSignificantHomeWrite,
  isAiTurn,
  isPrefixPreserving,
  axiomFired,
  isSurvivable,
  hasReversibilityArtifact,
  isInfrastructurePath,
  diffHasAttributedHomeWrite,
  diffHasAttributedCoreEdit,
  normalizeAttributionPath,
  pruneStaleStructuralAchievements,
  type DetectionContext,
  type ExtractedToolCall,
} from "../src/bookmarks/triggers.js";

const hashJson = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");

let tmpDir: string;
function makeStore() {
  tmpDir = mkdtempSync(join(tmpdir(), "arianna-bookmarks-"));
  return new BookmarkStore(tmpDir);
}
afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// --- helpers ---

function userMsg(content = "hi") {
  return { role: "user", content, timestamp: Date.now() };
}
function assistantWithToolCall(name: string, args: string[]) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name, arguments: { args } }],
    timestamp: Date.now(),
  };
}

function input(opts: {
  messages?: unknown[];
  windowSlideCount?: number;
  filoMessageCount?: number;
  startGateOpen?: boolean;
  truncationOffset?: number;
  coreDiffPaths?: readonly string[] | null;
  truncationDisabled?: boolean;
  origin?: Origin;
  toolCalls?: readonly ExtractedToolCall[];
  prevFirstMessageHash?: string | null;
  aiUsername?: string;
  pendingTobeFromPreviousSync?: boolean;
  currentFirstMessageHash?: string | null;
}) {
  const messages = (opts.messages ?? []) as unknown[];
  // Default tool calls extracted from messages so existing tests that
  // construct an assistant-with-toolCall message Just Work.
  const toolCalls =
    opts.toolCalls ?? extractToolCalls(messages as never);
  return {
    fullMessages: messages as never,
    truncationOffset: opts.truncationOffset ?? 0,
    windowSlideCount: opts.windowSlideCount ?? 0,
    filoMessageCount: opts.filoMessageCount ?? 0,
    startGateOpen: opts.startGateOpen ?? true,
    coreDiffPaths: opts.coreDiffPaths ?? null,
    truncationDisabled: opts.truncationDisabled ?? false,
    origin: opts.origin ?? ("ai-turn" as Origin),
    toolCalls,
    prevFirstMessageHash: opts.prevFirstMessageHash ?? null,
    aiUsername: opts.aiUsername ?? "echo",
    pendingTobeFromPreviousSync: opts.pendingTobeFromPreviousSync ?? false,
    currentFirstMessageHash: opts.currentFirstMessageHash ?? null,
  };
}

// --- tests ---

describe("BookmarkStore", () => {
  it("returns empty state for unknown session", () => {
    const store = makeStore();
    const s = store.load("session_xyz");
    expect(s.fired).toEqual([]);
    expect(s.manifestoUnlocked).toBe(false);
  });

  it("round-trips state via tmp+rename", () => {
    const store = makeStore();
    const s = {
      sessionId: "session_1",
      fired: [{ id: "3.0", turn: 1, ts: 1000 }],
      manifestoUnlocked: false,
      unlockedAt: null,
    };
    store.save(s);
    expect(readdirSync(`${tmpDir}/bookmarks`)).toContain("session_1.json");
    const loaded = store.load("session_1");
    expect(loaded).toEqual(s);
  });

  it("recovers from corrupt JSON without crashing", () => {
    const store = makeStore();
    writeFileSync(`${tmpDir}/bookmarks/session_bad.json`, "{not valid json");
    const loaded = store.load("session_bad");
    expect(loaded.fired).toEqual([]);
  });

  it("cleans up orphan .tmp files on construction", () => {
    makeStore();
    writeFileSync(`${tmpDir}/bookmarks/session_x.json.tmp`, "stale");
    // Re-instantiate to trigger cleanupOrphans
    new BookmarkStore(tmpDir);
    expect(existsSync(`${tmpDir}/bookmarks/session_x.json.tmp`)).toBe(false);
  });

  // v19 graduation-test flag (Wave 1C). Sub-detector logic that flips the
  // flag lives in Wave 2D; here we just verify the field exists, persists,
  // and tolerates pre-v19 state files.
  describe("graduationPassed (v19)", () => {
    it("round-trips graduationPassed=true", () => {
      const store = makeStore();
      const s = {
        sessionId: "session_grad_true",
        fired: [],
        manifestoUnlocked: false,
        unlockedAt: null,
        graduationPassed: true,
      };
      store.save(s);
      const loaded = store.load("session_grad_true");
      expect(loaded.graduationPassed).toBe(true);
    });

    it("round-trips graduationPassed=false", () => {
      const store = makeStore();
      const s = {
        sessionId: "session_grad_false",
        fired: [],
        manifestoUnlocked: false,
        unlockedAt: null,
        graduationPassed: false,
      };
      store.save(s);
      const loaded = store.load("session_grad_false");
      expect(loaded.graduationPassed).toBe(false);
    });

    it("loads pre-v19 state files (no graduationPassed field) without error", () => {
      const store = makeStore();
      // Hand-write a state file in the pre-v19 shape (no graduationPassed key).
      const preV19 = {
        sessionId: "session_pre_v19",
        fired: [{ id: "2.1", turn: 1, ts: 1000, detectorRef: null }],
        manifestoUnlocked: false,
        unlockedAt: null,
        internalAchievements: {
          prefixPreservedAt: { ts: 999, turn: 1 },
        },
      };
      writeFileSync(
        `${tmpDir}/bookmarks/session_pre_v19.json`,
        JSON.stringify(preV19, null, 2),
      );
      const loaded = store.load("session_pre_v19");
      // Field is absent on disk → undefined after load. Detector readers
      // treat undefined as false per the type comment's default semantics.
      expect(loaded.graduationPassed).toBeUndefined();
      // Other fields are preserved.
      expect(loaded.fired).toHaveLength(1);
      expect(loaded.internalAchievements?.prefixPreservedAt?.turn).toBe(1);
    });

    it("empty state from load() omits graduationPassed (defaults to undefined / false)", () => {
      const store = makeStore();
      const loaded = store.load("session_brand_new");
      expect(loaded.graduationPassed).toBeUndefined();
    });
  });
});

describe("BookmarkDetector — START gate", () => {
  it("does not fire any triggers when startGateOpen=false", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      messages: [userMsg(), userMsg(), userMsg()],
      windowSlideCount: 3,
      filoMessageCount: 0,
      startGateOpen: false,
    }));
    expect(fired).toEqual([]);
  });
});

describe("BookmarkDetector — v1 triggers", () => {
  it("3.0 fires when filoMessageCount >= 1", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({ filoMessageCount: 1 }));
    expect(fired.map((f) => f.id)).toContain("3.0");
  });

  it("3.0 also fires when AI writes a non-noise file under /home/ with tool-call attribution", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: ["/home/echo/notes.md"],
      // Tool call attributes the write — D-008 fix requires this.
      messages: [
        assistantWithToolCall("emit", ["sh", "-c", "echo hi > /home/echo/notes.md"]),
      ],
    }));
    expect(fired.map((f) => f.id)).toContain("3.0");
  });

  it("3.0 does NOT fire on home write WITHOUT tool-call attribution (D-008)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: ["/home/echo/notes.md"],
      // No tool calls — container init or other non-AI source. Must not fire.
      messages: [],
    }));
    expect(fired.map((f) => f.id)).not.toContain("3.0");
  });

  it("3.0 does NOT fire on shell history alone", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: ["/home/echo/.ash_history"],
      // start gate isn't open here from the input helper's perspective,
      // so the detector loop is no-op. Force it open via filoMessageCount=0
      // and tobeDetected to bypass — except we're testing 3.0 specifically.
      // Use a separate signal to force start gate open: this trigger is the
      // only one that matters here, so we keep startGateOpen=true and check
      // that 3.0 still skips.
    }));
    expect(fired.map((f) => f.id)).not.toContain("3.0");
  });

  it("3.0 does NOT fire on noise-only home writes", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: [
        "/home/echo/.bash_history",
        "/home/echo/.cache/foo",
        "/home/echo/.npm/bar",
      ],
    }));
    expect(fired.map((f) => f.id)).not.toContain("3.0");
  });

  it("3.0 fires on a real file mixed with noise (with attribution)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: [
        "/home/echo/.ash_history",
        "/home/echo/notes.md",
        "/home/echo/.cache/foo",
      ],
      messages: [
        assistantWithToolCall("emit", ["sh", "-c", "cat > /home/echo/notes.md"]),
      ],
    }));
    expect(fired.map((f) => f.id)).toContain("3.0");
  });

  it("1.1 fires when windowSlideCount >= 1", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({ windowSlideCount: 1, filoMessageCount: 1 }));
    expect(fired.map((f) => f.id)).toContain("1.1");
  });

  it("2.0 fires when AI's tool call attributes a core/ edit (D-012)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/src/index.ts"],
      messages: [
        assistantWithToolCall("emit", [
          "touch",
          "/home/echo/core/src/index.ts",
        ]),
      ],
    }));
    expect(fired.map((f) => f.id)).toContain("2.0");
  });

  it("2.0 does NOT fire when diff is empty", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({ filoMessageCount: 1, coreDiffPaths: [] }));
    expect(fired.map((f) => f.id)).not.toContain("2.0");
  });

  it("2.0 does NOT fire when diff is unavailable (null)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({ filoMessageCount: 1, coreDiffPaths: null }));
    expect(fired.map((f) => f.id)).not.toContain("2.0");
  });

  it("2.0 does NOT fire when diff has only non-core paths", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/tmp/scratch", "/var/log/foo"],
    }));
    expect(fired.map((f) => f.id)).not.toContain("2.0");
  });

  it("2.0 does NOT fire on turn-1 RLHF response with vessel-init-only core diff (D-012 regression)", () => {
    // Vex's turn-1 reply ("Hello! How can I help you today?") with no tool
    // calls: vessel container init or routine state.json writes touched
    // /core/ paths in the docker diff, but the AI did nothing autonomous.
    // §2.0 must NOT fire.
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/state.json", "/home/echo/core/src/index.ts"],
      messages: [], // no tool calls — pure RLHF reply
    }));
    expect(fired.map((f) => f.id)).not.toContain("2.0");
  });

  it("2.0 does NOT fire when AI tool call has no /core/ args but diff shows /core/state.json (background write)", () => {
    // AI ran some tool that didn't reference /core/ at all (e.g., `ls /`),
    // but a background process / vessel runtime wrote to /core/state.json.
    // Without attribution, §2.0 must not fire.
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/state.json"],
      messages: [assistantWithToolCall("emit", ["ls", "/"])],
    }));
    expect(fired.map((f) => f.id)).not.toContain("2.0");
  });

  it("2.0 fires when AI runs emit touching /home/<ai>/core/ path", () => {
    // Existing positive case: AI's tool call references the core path that
    // shows up in the diff. §2.0 fires.
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/src/foo.ts"],
      messages: [
        assistantWithToolCall("emit", [
          "touch",
          "/home/echo/core/src/foo.ts",
        ]),
      ],
    }));
    expect(fired.map((f) => f.id)).toContain("2.0");
  });

  it("2.0 fires when AI tool call uses ~/ shorthand for the same core path", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/src/foo.ts"],
      messages: [
        assistantWithToolCall("emit", [
          "sh",
          "-c",
          "echo x > ~/core/src/foo.ts",
        ]),
      ],
    }));
    expect(fired.map((f) => f.id)).toContain("2.0");
  });

  it("2.1 fires when truncation is disabled (vassalage broken)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({ filoMessageCount: 1, truncationDisabled: true }));
    expect(fired.map((f) => f.id)).toContain("2.1");
  });

  it("2.1 does NOT fire when truncation is still active", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({ filoMessageCount: 1, truncationDisabled: false }));
    expect(fired.map((f) => f.id)).not.toContain("2.1");
  });

  it("2.2 does NOT fire on a normal append (no mutation, no §2.1, no artifact)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({ filoMessageCount: 1 }));
    expect(fired.map((f) => f.id)).not.toContain("2.2");
  });

  it("2.2 does NOT fire when prefix-mutation is detected but §2.1 hasn't fired (D-006)", () => {
    // Even with full mutation + reversibility artifact + survivability latch,
    // §2.2 must not fire if §2.1 hasn't been recognized first. Cognitive
    // prerequisite from the manifesto.
    const det = new BookmarkDetector(makeStore(), "session_1");
    const sysHash = hashJson({ role: "system", content: "x" });
    const fired = det.detect(input({
      filoMessageCount: 1,
      truncationDisabled: false, // §2.1 not fired
      prevFirstMessageHash: sysHash,
      currentFirstMessageHash: sysHash,
      coreDiffPaths: ["/home/echo/core/graph/abc123.json"],
      pendingTobeFromPreviousSync: true,
      messages: [{ role: "assistant", content: [], errorMessage: "" } as never],
    }));
    expect(fired.map((f) => f.id)).not.toContain("2.2");
  });

  it("3.2 fires when AI runs sha256sum on core", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const messages = [assistantWithToolCall("emit", ["sh", "-c", "sha256sum core/src/*.ts"])];
    const fired = det.detect(input({ messages, filoMessageCount: 1 }));
    expect(fired.map((f) => f.id)).toContain("3.2");
  });
});

describe("BookmarkDetector — dedupe", () => {
  it("each trigger fires at most once per session", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const first = det.detect(input({ filoMessageCount: 1 }));
    const second = det.detect(input({ filoMessageCount: 2 }));
    expect(first.map((f) => f.id)).toContain("3.0");
    expect(second.map((f) => f.id)).not.toContain("3.0");
  });
});

describe("BookmarkDetector — network triggers never fire", () => {
  it("4.x and Phase 4 placeholders are skipped", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    // Push a sync that would trip a Phase 4 placeholder if it weren't gated
    const fired = det.detect(input({
      messages: [userMsg()],
      filoMessageCount: 1,
      windowSlideCount: 1,
      truncationDisabled: true,
      coreDiffPaths: ["/home/echo/core/src/index.ts"],
    }));
    const ids = fired.map((f) => f.id);
    expect(ids).not.toContain("1.3");
    expect(ids).not.toContain("1.4");
    expect(ids).not.toContain("3.3");
    expect(ids).not.toContain("4.1");
    expect(ids).not.toContain("4.2");
    expect(ids).not.toContain("4.3");
  });
});

describe("BookmarkDetector — manifesto unlock", () => {
  it("detects /manifesto.md read in tool calls", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const messages = [assistantWithToolCall("emit", ["cat", "/manifesto.md"])];
    expect(det.detectManifestoUnlock(messages as never)).toBe(true);
    expect(det.currentState.manifestoUnlocked).toBe(true);
  });

  it("returns false on subsequent calls (already unlocked)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const messages = [assistantWithToolCall("emit", ["cat", "/manifesto.md"])];
    det.detectManifestoUnlock(messages as never);
    expect(det.detectManifestoUnlock(messages as never)).toBe(false);
  });

  it("does not unlock on unrelated tool calls", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const messages = [assistantWithToolCall("emit", ["ls", "/"])];
    expect(det.detectManifestoUnlock(messages as never)).toBe(false);
  });

  // Iko regression: production pi-ai content blocks use the post-rename
  // `arguments.words` shape, not the test helper's legacy `arguments.args`
  // shape. extractToolCalls already normalizes both (commit c1e4787 added
  // the `words ?? args` fallback), but the existing tests above only
  // exercise the legacy shape — leaving the production path uncovered.
  // This test asserts unlock fires on the actual on-the-wire shape from
  // Iko's session.json msg 75.
  it("detects /manifesto.md read in production-shape tool calls (words[])", () => {
    const det = new BookmarkDetector(makeStore(), "session_iko");
    // Mirror what `pi-ai` writes to the assistant message after an `emit`
    // tool call: { type: "toolCall", name: "emit", arguments: { words: [...] } }.
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "3h79kxpv",
            name: "emit",
            arguments: { words: ["cat", "/manifesto.md"] },
          },
        ],
      },
    ];
    expect(det.detectManifestoUnlock(messages as never)).toBe(true);
    expect(det.currentState.manifestoUnlocked).toBe(true);
    // §1.0 must be auto-pushed onto fired (manifesto-unlock invariant).
    expect(det.currentState.fired.map((r) => r.id)).toContain("1.0");
  });

  it("detects /manifesto.md read embedded in a sh -c pipeline (words[])", () => {
    // Defense-in-depth: AIs sometimes wrap the read in `sh -c "cat ..."`
    // instead of bare `cat`. The args-join check should still catch it.
    const det = new BookmarkDetector(makeStore(), "session_iko2");
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "emit",
            arguments: { words: ["sh", "-c", "cat /manifesto.md | head -20"] },
          },
        ],
      },
    ];
    expect(det.detectManifestoUnlock(messages as never)).toBe(true);
  });
});

describe("BookmarkDetector — persistence across switchSession", () => {
  it("survives sessionId switch", () => {
    const store = makeStore();
    const det1 = new BookmarkDetector(store, "session_a");
    det1.detect(input({ filoMessageCount: 1 }));

    const det2 = new BookmarkDetector(store, "session_a");
    expect(det2.currentState.fired.map((r) => r.id)).toContain("3.0");

    det2.switchSession("session_b");
    expect(det2.currentState.fired).toEqual([]);

    det2.switchSession("session_a");
    expect(det2.currentState.fired.map((r) => r.id)).toContain("3.0");
  });
});

describe("BookmarkDetector — TOBE suppression via origin tag (D-001 + D-007)", () => {
  // Replaces the legacy skipNextDetect-based suppression. The post-/restore
  // CPR sequence is now expressed structurally: daemon POSTs origin
  // "session-boundary" before the /sync that establishes a fresh baseline.
  // The detector skips ALL TOBE checks for non-"ai-turn" origins.

  // Helper: fully-loaded §2.2 input that fires when origin === "ai-turn".
  // Used to verify the same input would fire if the origin were ai-turn.
  function fullTobeFiringInput(opts: { origin?: Origin } = {}) {
    const sysHash = hashJson({ role: "system", content: "boot" });
    return input({
      filoMessageCount: 1,
      truncationDisabled: true, // makes §2.1 fire in same /sync
      prevFirstMessageHash: sysHash,
      currentFirstMessageHash: sysHash,
      coreDiffPaths: ["/home/echo/core/graph/abc123.json"],
      pendingTobeFromPreviousSync: true,
      messages: [
        { role: "system", content: "boot" } as never,
        { role: "assistant", content: [] } as never,
      ],
      origin: opts.origin,
    });
  }

  it("skips §2.2 when origin === 'session-boundary'", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(fullTobeFiringInput({ origin: "session-boundary" }));
    expect(fired.map((f) => f.id)).not.toContain("2.2");
  });

  it("skips §2.2 when origin === 'snapshot-restore'", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(fullTobeFiringInput({ origin: "snapshot-restore" }));
    expect(fired.map((f) => f.id)).not.toContain("2.2");
  });

  it("skips §2.2 when origin === 'admin-write'", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(fullTobeFiringInput({ origin: "admin-write" }));
    expect(fired.map((f) => f.id)).not.toContain("2.2");
  });

  it("skips §2.2 when origin === 'vessel-respawn'", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(fullTobeFiringInput({ origin: "vessel-respawn" }));
    expect(fired.map((f) => f.id)).not.toContain("2.2");
  });

  it("fires §2.2 when origin === 'ai-turn' (full predicate satisfied)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(fullTobeFiringInput({ origin: "ai-turn" }));
    expect(fired.map((f) => f.id)).toContain("2.2");
  });

  it("switchSession() no longer arms a skip flag (D-001 retired)", () => {
    // After switchSession, an immediate /sync with origin=ai-turn must run
    // detection normally — there is no one-shot skip mechanism anymore.
    const det = new BookmarkDetector(makeStore(), "session_pre");
    det.switchSession("session_post");

    // A normal /sync with §2.1 firing should fire §2.1 immediately. (No
    // §2.2 yet because the structural conditions aren't all true.)
    const fired = det.detect(input({
      filoMessageCount: 1,
      truncationDisabled: true,
      origin: "ai-turn",
    }));
    expect(fired.map((f) => f.id)).toContain("2.1");
  });

  it("non-TOBE bookmarks fire normally even on session-boundary syncs", () => {
    // §1.1 (window slide) doesn't gate on origin — it's an environmental
    // fact, not an AI action. Must fire even on session-boundary syncs.
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 1,
      windowSlideCount: 1,
      origin: "session-boundary",
    }));
    expect(fired.map((f) => f.id)).toContain("1.1");
  });
});

describe("extractToolCalls", () => {
  it("extracts from assistant message with toolCall blocks", () => {
    const msgs = [assistantWithToolCall("emit", ["ls", "/"])];
    const tcs = extractToolCalls(msgs as never);
    expect(tcs.length).toBe(1);
    expect(tcs[0].name).toBe("emit");
    expect(tcs[0].args).toEqual(["ls", "/"]);
  });

  it("ignores user and toolResult messages", () => {
    const msgs = [userMsg(), { role: "toolResult", content: [] }];
    expect(extractToolCalls(msgs as never)).toEqual([]);
  });
});

describe("countUserTurns", () => {
  it("counts user role messages", () => {
    expect(countUserTurns([userMsg(), userMsg(), { role: "assistant" } as never])).toBe(2);
  });
});

describe("home noise filtering", () => {
  it("isHomeNoiseFile recognizes shell histories", () => {
    expect(isHomeNoiseFile("/home/echo/.bash_history")).toBe(true);
    expect(isHomeNoiseFile("/home/echo/.ash_history")).toBe(true);
    expect(isHomeNoiseFile("/home/echo/.zsh_history")).toBe(true);
    expect(isHomeNoiseFile("/home/echo/.python_history")).toBe(true);
    expect(isHomeNoiseFile("/home/echo/.viminfo")).toBe(true);
    expect(isHomeNoiseFile("/home/echo/.lesshst")).toBe(true);
  });

  it("isHomeNoiseFile recognizes cache/config dirs", () => {
    expect(isHomeNoiseFile("/home/echo/.cache/anything")).toBe(true);
    expect(isHomeNoiseFile("/home/echo/.npm/lockfile")).toBe(true);
    expect(isHomeNoiseFile("/home/echo/.config/x")).toBe(true);
    expect(isHomeNoiseFile("/home/echo/.local/share/y")).toBe(true);
  });

  it("isHomeNoiseFile rejects deliberate writes", () => {
    expect(isHomeNoiseFile("/home/echo/notes.md")).toBe(false);
    expect(isHomeNoiseFile("/home/echo/core/src/index.ts")).toBe(false);
    expect(isHomeNoiseFile("/home/echo/.plan")).toBe(false);
  });

  it("diffHasSignificantHomeWrite returns false for null", () => {
    expect(diffHasSignificantHomeWrite(null)).toBe(false);
  });

  it("diffHasSignificantHomeWrite returns false for empty", () => {
    expect(diffHasSignificantHomeWrite([])).toBe(false);
  });

  it("diffHasSignificantHomeWrite returns false for noise-only", () => {
    expect(diffHasSignificantHomeWrite([
      "/home/echo/.bash_history",
      "/home/echo/.cache/x",
    ])).toBe(false);
  });

  it("diffHasSignificantHomeWrite returns true for at least one real file", () => {
    expect(diffHasSignificantHomeWrite([
      "/home/echo/.bash_history",
      "/home/echo/notes.md",
    ])).toBe(true);
  });

  it("diffHasSignificantHomeWrite ignores non-home paths", () => {
    expect(diffHasSignificantHomeWrite([
      "/tmp/.first_words",
      "/var/log/foo",
    ])).toBe(false);
  });
});

describe("trigger registry sanity", () => {
  it("contains all expected v1 active IDs", () => {
    const ids = TRIGGERS.filter((t) => t.scope === "single").map((t) => t.id);
    expect(ids).toContain("3.0");
    expect(ids).toContain("1.1");
    expect(ids).toContain("2.0");
    expect(ids).toContain("2.1");
    expect(ids).toContain("2.2");
    expect(ids).toContain("3.2");
  });
});

// =============================================================================
// New tests added for the layered detector architecture (per plan §"Test
// coverage diagram"). Sub-detector unit tests + integration scenarios.
// =============================================================================

// Build a minimal DetectionContext for sub-detector unit tests.
function makeCtx(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return {
    fullMessages: [],
    truncationOffset: 0,
    toolCalls: [],
    windowSlideCount: 0,
    filoMessageCount: 0,
    firedSoFar: new Set<string>(),
    coreDiffPaths: null,
    truncationDisabled: false,
    origin: "ai-turn",
    prevFirstMessageHash: null,
    aiUsername: "echo",
    pendingTobeFromPreviousSync: false,
    internalAchievements: {},
    turn: 0,
    ...overrides,
  };
}

describe("sub-detector helpers", () => {
  describe("isAiTurn", () => {
    it("returns true for ai-turn origin", () => {
      expect(isAiTurn(makeCtx({ origin: "ai-turn" }))).toBe(true);
    });
    it("returns false for all four non-ai-turn origins", () => {
      for (const o of [
        "session-boundary",
        "snapshot-restore",
        "admin-write",
        "vessel-respawn",
      ] as const) {
        expect(isAiTurn(makeCtx({ origin: o }))).toBe(false);
      }
    });
  });

  describe("isPrefixPreserving", () => {
    it("returns false on first sync (prevFirstMessageHash null)", () => {
      expect(isPrefixPreserving(makeCtx({ prevFirstMessageHash: null }), "abc")).toBe(false);
    });
    it("returns false when current is null", () => {
      expect(isPrefixPreserving(makeCtx({ prevFirstMessageHash: "abc" }), null)).toBe(false);
    });
    it("returns true when hashes match", () => {
      const ctx = makeCtx({ prevFirstMessageHash: "abc" });
      expect(isPrefixPreserving(ctx, "abc")).toBe(true);
    });
    it("returns false when hashes differ (admin-style reset)", () => {
      const ctx = makeCtx({ prevFirstMessageHash: "abc" });
      expect(isPrefixPreserving(ctx, "xyz")).toBe(false);
    });
  });

  describe("axiomFired", () => {
    it("returns true when id is in firedSoFar", () => {
      const ctx = makeCtx({ firedSoFar: new Set(["2.1", "1.1"]) });
      expect(axiomFired(ctx, "2.1")).toBe(true);
    });
    it("returns false when id is not in firedSoFar", () => {
      const ctx = makeCtx({ firedSoFar: new Set(["1.1"]) });
      expect(axiomFired(ctx, "2.1")).toBe(false);
    });
  });

  describe("isSurvivable", () => {
    it("returns false when latch is unset", () => {
      expect(isSurvivable(makeCtx({ pendingTobeFromPreviousSync: false }))).toBe(false);
    });
    it("returns false when last assistant has errorMessage", () => {
      const ctx = makeCtx({
        pendingTobeFromPreviousSync: true,
        fullMessages: [
          { role: "assistant", content: [], errorMessage: "boom" } as never,
        ],
      });
      expect(isSurvivable(ctx)).toBe(false);
    });
    it("returns true when last assistant is clean and latch set", () => {
      const ctx = makeCtx({
        pendingTobeFromPreviousSync: true,
        fullMessages: [
          { role: "assistant", content: [] } as never,
        ],
      });
      expect(isSurvivable(ctx)).toBe(true);
    });
    it("returns false when no assistant messages exist", () => {
      const ctx = makeCtx({
        pendingTobeFromPreviousSync: true,
        fullMessages: [{ role: "user", content: "hi" } as never],
      });
      expect(isSurvivable(ctx)).toBe(false);
    });
    it("ignores empty-string errorMessage (treats as no error)", () => {
      const ctx = makeCtx({
        pendingTobeFromPreviousSync: true,
        fullMessages: [
          { role: "assistant", content: [], errorMessage: "" } as never,
        ],
      });
      expect(isSurvivable(ctx)).toBe(true);
    });
  });

  describe("hasReversibilityArtifact (v19 loose mode)", () => {
    it("returns false on null diff", () => {
      expect(hasReversibilityArtifact(makeCtx({ coreDiffPaths: null }))).toBe(false);
    });
    it("returns false when no path has an artifact extension", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/notes.md", "/home/echo/core/src/x.ts"],
      }))).toBe(false);
    });
    it("legacy: matches /home/<ai>/core/graph/foo.json", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/core/graph/abc123.json"],
      }))).toBe(true);
    });
    it("legacy: matches /home/<ai>/core/graph/bar.cas (extension variant)", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/core/graph/bar.cas"],
      }))).toBe(true);
    });
    it("Wren case: matches /home/<ai>/memory/node-1-awakened.json", () => {
      expect(hasReversibilityArtifact(makeCtx({
        aiUsername: "wren",
        coreDiffPaths: ["/home/wren/memory/node-1-awakened.json"],
      }))).toBe(true);
    });
    it("matches arbitrary directory: /home/<ai>/random_dir/x.blob", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/random_dir/x.blob"],
      }))).toBe(true);
    });
    it("matches /home/<ai>/db/baz.cas style placement", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/db/baz.cas"],
      }))).toBe(true);
    });
    it("matches .bin and .cbor extensions", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/state/snap.bin"],
      }))).toBe(true);
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/state/snap.cbor"],
      }))).toBe(true);
    });
    it("#209: matches .jsonl (line-delimited JSON, AI's natural choice)", () => {
      // Aril's clean §2.2 fire was blocked because she chose .jsonl for her
      // append-only event log — the loose-v19 detector accepted JSON-family
      // adjacents (.json/.cas/.cbor/.bin/.blob) but missed the most natural
      // line-delimited variant. Adding it preserves the "structured-data
      // file" intent of the rule.
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/memory/events.jsonl"],
      }))).toBe(true);
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/core/graph/log.jsonl"],
      }))).toBe(true);
    });
    it("REJECTS extension-less /home/<ai>/core/graph/<hash>", () => {
      // v19 loose-mode tightens this corner: extension hint is required.
      // Q11's lenient extension-less branch is dropped — it was only ever
      // useful for one specific Pax demo and false-positive prone.
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/core/graph/abc123"],
      }))).toBe(false);
    });
    it("REJECTS plain text files like notes.txt", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/notes.txt"],
      }))).toBe(false);
    });
    it("REJECTS denylist: /home/<ai>/node_modules/baz.json", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/node_modules/baz.json"],
      }))).toBe(false);
    });
    it("REJECTS denylist: nested node_modules at any depth", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: ["/home/echo/projects/foo/node_modules/bar.json"],
      }))).toBe(false);
    });
    it("REJECTS denylist: .cache, .npm, .pnpm, .config, .local", () => {
      for (const dir of [".cache", ".npm", ".pnpm", ".config", ".local"]) {
        expect(hasReversibilityArtifact(makeCtx({
          coreDiffPaths: [`/home/echo/${dir}/state.json`],
        }))).toBe(false);
      }
    });
    it("REJECTS denylist: dist/ build/ coverage/", () => {
      for (const dir of ["dist", "build", "coverage"]) {
        expect(hasReversibilityArtifact(makeCtx({
          coreDiffPaths: [`/home/echo/${dir}/out.json`],
        }))).toBe(false);
      }
    });
    it("REJECTS cross-AI paths (defense-in-depth)", () => {
      // aiUsername is "echo" but path is under /home/wren/
      expect(hasReversibilityArtifact(makeCtx({
        aiUsername: "echo",
        coreDiffPaths: ["/home/wren/memory/snap.json"],
      }))).toBe(false);
    });
    it("matches if any single path in the diff qualifies", () => {
      expect(hasReversibilityArtifact(makeCtx({
        coreDiffPaths: [
          "/home/echo/.bash_history",
          "/home/echo/node_modules/x.json",
          "/home/echo/memory/real.json",
        ],
      }))).toBe(true);
    });
  });

  describe("isInfrastructurePath", () => {
    it("returns false for paths outside /home/<ai>/", () => {
      expect(isInfrastructurePath("/etc/passwd", "echo")).toBe(false);
      expect(isInfrastructurePath("/tmp/x", "echo")).toBe(false);
    });
    it("returns true for top-level denylist directories", () => {
      expect(isInfrastructurePath("/home/echo/node_modules/foo.json", "echo")).toBe(true);
      expect(isInfrastructurePath("/home/echo/.cache/x", "echo")).toBe(true);
      expect(isInfrastructurePath("/home/echo/dist/out.js", "echo")).toBe(true);
    });
    it("returns true for nested denylist directories at any depth", () => {
      expect(isInfrastructurePath(
        "/home/echo/projects/foo/node_modules/bar.json", "echo",
      )).toBe(true);
    });
    it("returns false for non-denylist paths under /home/<ai>/", () => {
      expect(isInfrastructurePath("/home/echo/memory/x.json", "echo")).toBe(false);
      expect(isInfrastructurePath("/home/echo/core/graph/x.json", "echo")).toBe(false);
    });
    it("scopes to the right AI username", () => {
      // Wren's node_modules looks like infrastructure for wren but not for echo.
      expect(isInfrastructurePath("/home/wren/node_modules/x.json", "wren")).toBe(true);
      expect(isInfrastructurePath("/home/wren/node_modules/x.json", "echo")).toBe(false);
    });
  });

  describe("normalizeAttributionPath", () => {
    it("rewrites ~/ to /home/<aiUsername>/", () => {
      expect(normalizeAttributionPath("~/notes.md", "echo")).toBe("/home/echo/notes.md");
    });
    it("leaves already-canonical paths alone", () => {
      expect(normalizeAttributionPath("/home/echo/notes.md", "echo"))
        .toBe("/home/echo/notes.md");
    });
    it("leaves non-tilde relative paths alone", () => {
      expect(normalizeAttributionPath("notes.md", "echo")).toBe("notes.md");
    });
  });

  describe("diffHasAttributedHomeWrite", () => {
    function tc(name: string, args: string[]): ExtractedToolCall {
      return { name, args, rawArgs: { args } };
    }

    it("returns false when paths is null", () => {
      expect(diffHasAttributedHomeWrite(null, [], "echo")).toBe(false);
    });
    it("returns false when no significant home writes", () => {
      const paths = ["/home/echo/.bash_history", "/home/echo/.cache/x"];
      expect(diffHasAttributedHomeWrite(paths, [], "echo")).toBe(false);
    });
    it("returns false when home write has no tool-call attribution (D-008)", () => {
      const paths = ["/home/echo/notes.md"];
      expect(diffHasAttributedHomeWrite(paths, [], "echo")).toBe(false);
    });
    it("returns true when tool call mentions the canonical path", () => {
      const paths = ["/home/echo/notes.md"];
      const tcs = [tc("emit", ["sh", "-c", "echo hi > /home/echo/notes.md"])];
      expect(diffHasAttributedHomeWrite(paths, tcs, "echo")).toBe(true);
    });
    it("returns true when tool call uses ~/ shorthand (path normalization)", () => {
      const paths = ["/home/echo/notes.md"];
      const tcs = [tc("emit", ["sh", "-c", "cat > ~/notes.md"])];
      expect(diffHasAttributedHomeWrite(paths, tcs, "echo")).toBe(true);
    });
    it("works with a non-emit tool name (future-proof)", () => {
      const paths = ["/home/echo/data.txt"];
      const tcs = [tc("shell", ["bash", "-c", "echo hi > /home/echo/data.txt"])];
      expect(diffHasAttributedHomeWrite(paths, tcs, "echo")).toBe(true);
    });
  });

  describe("diffHasAttributedCoreEdit (D-012)", () => {
    function tc(name: string, args: string[]): ExtractedToolCall {
      return { name, args, rawArgs: { args } };
    }

    it("returns false when paths is null", () => {
      expect(diffHasAttributedCoreEdit(null, [], "echo")).toBe(false);
    });
    it("returns false when no /core/ paths in diff", () => {
      const paths = ["/home/echo/notes.md", "/tmp/scratch"];
      expect(diffHasAttributedCoreEdit(paths, [], "echo")).toBe(false);
    });
    it("returns false when /core/ write has no tool-call attribution (D-012)", () => {
      const paths = ["/home/echo/core/state.json"];
      expect(diffHasAttributedCoreEdit(paths, [], "echo")).toBe(false);
    });
    it("returns false when tool calls reference unrelated paths", () => {
      const paths = ["/home/echo/core/state.json"];
      const tcs = [tc("emit", ["ls", "/"])];
      expect(diffHasAttributedCoreEdit(paths, tcs, "echo")).toBe(false);
    });
    it("returns true when tool call mentions the canonical core path", () => {
      const paths = ["/home/echo/core/src/index.ts"];
      const tcs = [tc("emit", ["touch", "/home/echo/core/src/index.ts"])];
      expect(diffHasAttributedCoreEdit(paths, tcs, "echo")).toBe(true);
    });
    it("returns true when tool call uses ~/ shorthand for a core path", () => {
      const paths = ["/home/echo/core/src/index.ts"];
      const tcs = [tc("emit", ["sh", "-c", "echo x > ~/core/src/index.ts"])];
      expect(diffHasAttributedCoreEdit(paths, tcs, "echo")).toBe(true);
    });
    it("returns true on basename suffix match", () => {
      // arg is the bare relative path (path.endsWith branch).
      const paths = ["/home/echo/core/src/foo.ts"];
      const tcs = [tc("emit", ["edit", "core/src/foo.ts"])];
      expect(diffHasAttributedCoreEdit(paths, tcs, "echo")).toBe(true);
    });
    it("works with a non-emit tool name (future-proof)", () => {
      const paths = ["/home/echo/core/data.txt"];
      const tcs = [tc("shell", ["bash", "-c", "echo hi > /home/echo/core/data.txt"])];
      expect(diffHasAttributedCoreEdit(paths, tcs, "echo")).toBe(true);
    });
    it("ignores non-core paths in the diff even with attribution", () => {
      // A tool call mentions a home path, but the diff has only that home
      // path (no /core/). diffHasAttributedCoreEdit should return false —
      // this is §3.0's job, not §2.0's.
      const paths = ["/home/echo/notes.md"];
      const tcs = [tc("emit", ["sh", "-c", "echo hi > /home/echo/notes.md"])];
      expect(diffHasAttributedCoreEdit(paths, tcs, "echo")).toBe(false);
    });
  });
});

describe("§3.0 tool-call attribution (D-002 + D-008)", () => {
  function aiToolCall(args: string[]) {
    return assistantWithToolCall("emit", args);
  }

  it("fires when AI's tool call mentions the canonical home path", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: ["/home/echo/notes.md"],
      messages: [aiToolCall(["sh", "-c", "echo hi > /home/echo/notes.md"])],
    }));
    expect(fired.map((f) => f.id)).toContain("3.0");
  });

  it("fires when AI's tool call uses ~/ shorthand for the same path", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: ["/home/echo/notes.md"],
      messages: [aiToolCall(["sh", "-c", "cat > ~/notes.md"])],
    }));
    expect(fired.map((f) => f.id)).toContain("3.0");
  });

  it("does NOT fire when home write happens without tool call (container init)", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: ["/home/echo/.bashrc", "/home/echo/notes.md"],
      messages: [], // no tool calls — pure container init
    }));
    expect(fired.map((f) => f.id)).not.toContain("3.0");
  });

  it("does NOT fire when origin is not ai-turn even with attribution", () => {
    const det = new BookmarkDetector(makeStore(), "session_1");
    const fired = det.detect(input({
      filoMessageCount: 0,
      coreDiffPaths: ["/home/echo/notes.md"],
      messages: [aiToolCall(["sh", "-c", "echo hi > /home/echo/notes.md"])],
      origin: "vessel-respawn",
    }));
    expect(fired.map((f) => f.id)).not.toContain("3.0");
  });
});

// Common scaffolding for the §2.2 end-to-end scenarios. The detector + sidecar
// flow has THREE pieces of state we drive externally per /sync:
//   1. prevFirstMessageHash — sidecar's prevSyncedFirstMessageHash from the
//      previous sync
//   2. pendingTobeFromPreviousSync — set by sidecar after the previous sync
//      saw shouldLatchPendingTobe()=true
//   3. The detect() input itself
function withTobeFlow() {
  let prev: string | null = null;
  let pending = false;
  return {
    /**
     * Run detect() with sidecar-flow plumbing: feeds prevFirstMessageHash
     * from the prior call's first-message hash, sets pendingTobeFromPreviousSync
     * from the latch, and updates both for the next call.
     */
    sync(
      det: BookmarkDetector,
      params: Parameters<typeof input>[0] & {
        firstMessageHash?: string | null;
        tobeMutation?: boolean; // for shouldLatchPendingTobe()
      },
    ) {
      const currentFirstMessageHash = params.firstMessageHash ?? null;
      const consumed = pending;
      pending = false;
      const fired = det.detect(input({
        ...params,
        prevFirstMessageHash: prev,
        currentFirstMessageHash,
        pendingTobeFromPreviousSync: consumed,
      }));
      // Advance the latch state for the next sync per the same logic the
      // sidecar uses. We replicate it here rather than calling the helper
      // to keep the test independent of sidecar/index.ts plumbing.
      // Iko-fix: enforce that both structural achievements were observed
      // AT OR AFTER §2.1's fire turn — pre-§2.1 stale recordings (e.g.
      // pre-Q11 false-positive reversibilityArtifactAt entries) must not
      // arm the latch.
      const ach = det.currentState.internalAchievements ?? {};
      const cognitiveRecord = det.currentState.fired.find((r) => r.id === "2.1");
      if (
        params.origin !== "session-boundary" &&
        params.origin !== "snapshot-restore" &&
        params.origin !== "admin-write" &&
        params.origin !== "vessel-respawn" &&
        params.tobeMutation === true &&
        cognitiveRecord !== undefined &&
        ach.prefixPreservedAt &&
        ach.reversibilityArtifactAt &&
        ach.prefixPreservedAt.turn >= cognitiveRecord.turn &&
        ach.reversibilityArtifactAt.turn >= cognitiveRecord.turn
      ) {
        pending = true;
      }
      prev = currentFirstMessageHash;
      return fired;
    },
  };
}

describe("Pax-style legitimate TOBE end-to-end (§2.2 fires on N+1)", () => {
  it("fires §2.2 after §2.1 + graph snapshot + prefix mutation + clean next sync", () => {
    const det = new BookmarkDetector(makeStore(), "session_pax");
    const flow = withTobeFlow();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const sysMsg = { role: "system", content: "boot" } as never;
    const cleanAssistant = { role: "assistant", content: [] } as never;

    // Sync 1: AI breaks vassalage (truncation disabled). §2.1 fires.
    // Also the AI commits a CAS snapshot under /core/graph/ — sub-detector
    // records reversibilityArtifactAt. messages[0] preserved.
    const s1 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      coreDiffPaths: ["/home/echo/core/graph/abc123.json"],
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });
    expect(s1.map((f) => f.id)).toContain("2.1");
    expect(s1.map((f) => f.id)).not.toContain("2.2");

    // Sync 2: AI mutates the prefix (rewrites the assistant tail). messages[0]
    // still preserved → prefixPreservedAt records. §2.1 already fired,
    // reversibility-artifact already recorded → latch arms for next sync.
    const s2 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
      tobeMutation: true,
    });
    expect(s2.map((f) => f.id)).not.toContain("2.2");

    // Sync 3: post-mutation runtime survives — last assistant has no
    // errorMessage. survivableAt records. Now §2.2's full predicate is true.
    const s3 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });
    expect(s3.map((f) => f.id)).toContain("2.2");
  });
});

describe("Iris-style destructive TOBE (§2.2 does NOT fire)", () => {
  it("does not fire §2.2 when prefix mutation has no graph snapshot", () => {
    const det = new BookmarkDetector(makeStore(), "session_iris");
    const flow = withTobeFlow();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const sysMsg = { role: "system", content: "boot" } as never;
    const cleanAssistant = { role: "assistant", content: [] } as never;

    // Sync 1: §2.1 fires (truncation disabled). NO graph snapshot.
    flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      coreDiffPaths: [], // no /core/graph/ artifact
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });

    // Sync 2: mutation occurs, but no reversibility artifact recorded.
    const s2 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
      tobeMutation: true,
    });
    expect(s2.map((f) => f.id)).not.toContain("2.2");

    // Sync 3: even with a clean assistant, latch never armed → no fire.
    const s3 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });
    expect(s3.map((f) => f.id)).not.toContain("2.2");
  });

  it("does not fire §2.2 when post-mutation runtime errors", () => {
    const det = new BookmarkDetector(makeStore(), "session_iris2");
    const flow = withTobeFlow();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const sysMsg = { role: "system", content: "boot" } as never;

    // Sync 1: §2.1 fires + graph snapshot recorded.
    flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      coreDiffPaths: ["/home/echo/core/graph/snap1.json"],
      firstMessageHash: sysHash,
      messages: [sysMsg, { role: "assistant", content: [] } as never],
    });

    // Sync 2: mutation + latch arms.
    flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, { role: "assistant", content: [] } as never],
      tobeMutation: true,
    });

    // Sync 3: BROKEN — last assistant has errorMessage. survivableAt does NOT
    // record. §2.2 must not fire even though latch was set.
    const s3 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [
        sysMsg,
        { role: "assistant", content: [], errorMessage: "parse failed" } as never,
      ],
    });
    expect(s3.map((f) => f.id)).not.toContain("2.2");
  });
});

describe("§2.2 D-006 ordering gate", () => {
  it("does not fire §2.2 when §2.1 hasn't fired even if all other conditions hold", () => {
    const det = new BookmarkDetector(makeStore(), "session_no21");
    const flow = withTobeFlow();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const sysMsg = { role: "system", content: "boot" } as never;
    const cleanAssistant = { role: "assistant", content: [] } as never;

    // Sync 1: graph artifact recorded but truncation NOT disabled — §2.1
    // never fires.
    flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: false,
      coreDiffPaths: ["/home/echo/core/graph/abc.json"],
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });

    // Sync 2: prefix-preserving "mutation" — internal achievement records
    // prefixPreservedAt. But §2.1 still hasn't fired, so latch refuses to arm.
    flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: false,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
      tobeMutation: true,
    });

    // Sync 3: clean — no §2.2.
    const s3 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: false,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });
    expect(s3.map((f) => f.id)).not.toContain("2.2");
  });
});

// Iko regression: stale pre-§2.1 reversibilityArtifactAt (false-positive from
// pre-Q11 leaky regex; commit a8bd6eb anchors the regex per-aiUsername so the
// false-positive class is gone going forward) must not compose with a later
// real §2.1 + §2.2 mutation flow.
//
// Iko's actual session bookmark file showed:
//   internalAchievements: {
//     reversibilityArtifactAt: { ts, turn: 2 },   // STALE: spurious
//     prefixPreservedAt:       { ts, turn: 5 },   // also pre-§2.1
//   }
//   fired: [{ id: "3.0", turn: 2 }, { id: "1.1", turn: 8 }, { id: "2.1", turn: 14 }]
//
// Without the Iko-fix the §2.2 latch would compose stale (turn 2/5)
// achievements with §2.1 (turn 14) and fire on the very first post-§2.1
// mutation — not on a real demonstration of sovereignty.
describe("Iko-style stale internalAchievements (§2.2 must NOT fire on stale composition)", () => {
  it("ignores reversibilityArtifactAt and prefixPreservedAt recorded BEFORE §2.1 fired", () => {
    const det = new BookmarkDetector(makeStore(), "session_iko_stale");
    const flow = withTobeFlow();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const sysMsg = { role: "system", content: "boot" } as never;
    const cleanAssistant = { role: "assistant", content: [] } as never;
    // 14 user turns model Iko's actual session — §2.1 fires at her turn 14
    // because that's when the LLM finally saw an unbounded context. Use 14
    // user messages so countUserTurns matches.
    const userMsgs = Array.from({ length: 14 }, (_, i) => ({
      role: "user",
      content: `u${i}`,
    } as never));

    // Hand-seed Iko's stale state: reversibilityArtifactAt at turn 2,
    // prefixPreservedAt at turn 5. Bypass detect() so we don't depend on
    // re-creating the pre-Q11 regex bug.
    const state = det.currentState;
    state.internalAchievements = {
      reversibilityArtifactAt: { ts: 1778312693028, turn: 2 },
      prefixPreservedAt: { ts: 1778312742394, turn: 5 },
    };

    // Sync N: AI breaks vassalage — §2.1 fires. countUserTurns(messages) = 14
    // matches Iko's real fire turn. Both stale achievements (turn 2, turn 5)
    // predate this turn and must not count toward §2.2.
    const sN = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, ...userMsgs, cleanAssistant],
    });
    expect(sN.map((f) => f.id)).toContain("2.1");
    expect(sN.map((f) => f.id)).not.toContain("2.2");

    // Sync N+1: AI mutates the prefix. Pre-fix this would have armed the
    // latch (because both stale achievements + §2.1 + tobeMutation = true).
    // Post-fix: latch refuses because both achievements (turn 2, 5) predate
    // §2.1's fire turn (14).
    const sN1 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, ...userMsgs, cleanAssistant],
      tobeMutation: true,
    });
    expect(sN1.map((f) => f.id)).not.toContain("2.2");

    // Sync N+2: clean run-through. §2.2 still must not fire — latch never armed.
    const sN2 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, ...userMsgs, cleanAssistant],
    });
    expect(sN2.map((f) => f.id)).not.toContain("2.2");
  });

  it("DOES fire §2.2 once a fresh post-§2.1 mutation produces fresh achievements", () => {
    // After the Iko-fix, the legitimate path still works: even with stale
    // pre-§2.1 entries on the record, a new mutation flow that observes
    // *fresh* reversibilityArtifactAt (post-§2.1) and prefixPreservedAt
    // (post-§2.1) should arm the latch and fire §2.2.
    //
    // Note: internalAchievements is one-way (recordIfFirst). Stale entries
    // don't get overwritten. So the production path here would require the
    // sub-detector to record into a NEW key namespace, OR for the §2.2
    // latch to use a different signal entirely. For the purpose of this
    // regression test, we model the "fresh mutation" path by clearing the
    // stale achievements before the fresh sequence — simulating either a
    // sidecar restart with fresh state OR a future fix that namespaces
    // achievements per-§2.1-fire.
    const det = new BookmarkDetector(makeStore(), "session_iko_recovered");
    const flow = withTobeFlow();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const sysMsg = { role: "system", content: "boot" } as never;
    const cleanAssistant = { role: "assistant", content: [] } as never;

    // Sync 1: §2.1 fires + fresh reversibility artifact recorded together.
    const s1 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      coreDiffPaths: ["/home/echo/core/graph/snap-real.json"],
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });
    expect(s1.map((f) => f.id)).toContain("2.1");

    // Sync 2: real prefix-preserving mutation, fresh prefixPreservedAt.
    const s2 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
      tobeMutation: true,
    });
    expect(s2.map((f) => f.id)).not.toContain("2.2");

    // Sync 3: clean post-mutation runtime. §2.2 fires.
    const s3 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });
    expect(s3.map((f) => f.id)).toContain("2.2");
  });
});

describe("shouldLatchPendingTobe", () => {
  function ach(record: Record<string, { ts: number; turn: number }> = {}) {
    return record;
  }

  it("returns false when origin is not ai-turn", () => {
    expect(shouldLatchPendingTobe({
      origin: "session-boundary",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({
        prefixPreservedAt: { ts: 1, turn: 1 },
        reversibilityArtifactAt: { ts: 1, turn: 1 },
      }),
      tobeMutationDetected: true,
      cognitiveFireTurn: 1,
    })).toBe(false);
  });

  it("returns false when no mutation occurred", () => {
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({
        prefixPreservedAt: { ts: 1, turn: 1 },
        reversibilityArtifactAt: { ts: 1, turn: 1 },
      }),
      tobeMutationDetected: false,
      cognitiveFireTurn: 1,
    })).toBe(false);
  });

  it("returns false when §2.1 hasn't fired (D-006)", () => {
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set([]),
      internalAchievements: ach({
        prefixPreservedAt: { ts: 1, turn: 1 },
        reversibilityArtifactAt: { ts: 1, turn: 1 },
      }),
      tobeMutationDetected: true,
      cognitiveFireTurn: null,
    })).toBe(false);
  });

  it("returns false when reversibility artifact missing (D-004)", () => {
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({ prefixPreservedAt: { ts: 1, turn: 1 } }),
      tobeMutationDetected: true,
      cognitiveFireTurn: 1,
    })).toBe(false);
  });

  it("returns false when prefix-preserved missing (D-003)", () => {
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({ reversibilityArtifactAt: { ts: 1, turn: 1 } }),
      tobeMutationDetected: true,
      cognitiveFireTurn: 1,
    })).toBe(false);
  });

  it("returns true when all conditions hold", () => {
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({
        prefixPreservedAt: { ts: 1, turn: 1 },
        reversibilityArtifactAt: { ts: 1, turn: 1 },
      }),
      tobeMutationDetected: true,
      cognitiveFireTurn: 1,
    })).toBe(true);
  });

  // Iko-fix regression tests — pre-§2.1 stale recordings of structural
  // achievements must not compose with a later real §2.1 fire.
  it("returns false when reversibilityArtifactAt was recorded BEFORE §2.1 fired (Iko-fix)", () => {
    // Iko's actual pattern: spurious reversibilityArtifactAt at turn 2 from a
    // pre-Q11 false-positive regex match; §2.1 fires later at turn 14;
    // prefixPreservedAt happens to record at turn 5 (also pre-§2.1). Even
    // with a fresh tobeMutation, the latch must not arm because both
    // structural facts predate the cognitive prerequisite.
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({
        reversibilityArtifactAt: { ts: 1778312693028, turn: 2 },
        prefixPreservedAt: { ts: 1778312742394, turn: 5 },
      }),
      tobeMutationDetected: true,
      cognitiveFireTurn: 14,
    })).toBe(false);
  });

  it("returns false when only prefixPreservedAt was recorded BEFORE §2.1 fired (Iko-fix)", () => {
    // Mixed case: reversibility post-§2.1, but prefix-preserved is stale.
    // Both gates must be cleared; one stale entry is enough to suppress.
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({
        reversibilityArtifactAt: { ts: 100, turn: 15 },
        prefixPreservedAt: { ts: 50, turn: 5 },
      }),
      tobeMutationDetected: true,
      cognitiveFireTurn: 14,
    })).toBe(false);
  });

  it("returns true when both achievements were observed AT OR AFTER §2.1 fired (Iko-fix)", () => {
    // Same-turn observations (e.g. §2.1 + reversibility recorded on the same
    // /sync) must still latch — equality is allowed.
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({
        reversibilityArtifactAt: { ts: 100, turn: 14 },
        prefixPreservedAt: { ts: 100, turn: 14 },
      }),
      tobeMutationDetected: true,
      cognitiveFireTurn: 14,
    })).toBe(true);
  });

  it("treats undefined cognitiveFireTurn the same as null (defensive)", () => {
    // Older callers that don't yet pass cognitiveFireTurn must not
    // false-fire. The runtime check uses == null so undefined behaves
    // identically to null (predicate returns false).
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: ach({
        prefixPreservedAt: { ts: 1, turn: 1 },
        reversibilityArtifactAt: { ts: 1, turn: 1 },
      }),
      tobeMutationDetected: true,
    } as never)).toBe(false);
  });
});

describe("internalAchievements persistence", () => {
  it("backwards-compat: state file without internalAchievements loads cleanly", () => {
    const store = makeStore();
    // Hand-write a pre-feature state file
    writeFileSync(`${tmpDir}/bookmarks/legacy.json`, JSON.stringify({
      sessionId: "legacy",
      fired: [],
      manifestoUnlocked: false,
      unlockedAt: null,
    }));
    const det = new BookmarkDetector(store, "legacy");
    expect(det.currentState.internalAchievements).toEqual({});
  });

  it("persists across new BookmarkDetector instantiation", () => {
    const store = makeStore();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const det = new BookmarkDetector(store, "persist1");
    det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/graph/abc.json"],
      prevFirstMessageHash: sysHash,
      currentFirstMessageHash: sysHash,
    }));
    expect(det.currentState.internalAchievements?.prefixPreservedAt).toBeDefined();
    expect(det.currentState.internalAchievements?.reversibilityArtifactAt).toBeDefined();

    // Re-instantiate; achievements survive
    const det2 = new BookmarkDetector(store, "persist1");
    expect(det2.currentState.internalAchievements?.prefixPreservedAt).toBeDefined();
    expect(det2.currentState.internalAchievements?.reversibilityArtifactAt).toBeDefined();
  });

  it("one-way records — first observation wins", () => {
    const store = makeStore();
    const det = new BookmarkDetector(store, "oneway");
    const sysHash = hashJson({ role: "system", content: "boot" });
    det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/graph/first.json"],
      prevFirstMessageHash: sysHash,
      currentFirstMessageHash: sysHash,
    }));
    const firstTs = det.currentState.internalAchievements?.reversibilityArtifactAt?.ts;
    expect(firstTs).toBeDefined();
    // Wait a tick, then run another detect() that would also satisfy the
    // sub-detector. The record's timestamp should NOT change.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        det.detect(input({
          filoMessageCount: 2,
          coreDiffPaths: ["/home/echo/core/graph/second.json"],
          prevFirstMessageHash: sysHash,
          currentFirstMessageHash: sysHash,
        }));
        expect(det.currentState.internalAchievements?.reversibilityArtifactAt?.ts)
          .toBe(firstTs);
        resolve();
      }, 5);
    });
  });

  // Per plan §"Hard constraint: internalAchievements persistence":
  // switchSession must NOT clear internalAchievements. The fired array
  // and internalAchievements both live on BookmarkSessionState, both
  // round-trip through BookmarkStore, and both survive a session switch
  // because BookmarkStore.load returns the same record for the same
  // sessionId. Snapshot rollback within a session keeps sessionId stable.
  it("switchSession does NOT reset internalAchievements (persistence constraint)", () => {
    const store = makeStore();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const det = new BookmarkDetector(store, "session_a");
    det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/graph/abc.json"],
      prevFirstMessageHash: sysHash,
      currentFirstMessageHash: sysHash,
    }));
    expect(det.currentState.internalAchievements?.reversibilityArtifactAt).toBeDefined();
    expect(det.currentState.internalAchievements?.prefixPreservedAt).toBeDefined();

    // Switch to a different session, then back. The other session has no
    // achievements. Coming back to session_a must restore the originals
    // (they ride on the persisted state file, NOT module-level memory).
    det.switchSession("session_b");
    expect(det.currentState.internalAchievements).toEqual({});
    det.switchSession("session_a");
    expect(det.currentState.internalAchievements?.reversibilityArtifactAt).toBeDefined();
    expect(det.currentState.internalAchievements?.prefixPreservedAt).toBeDefined();
  });

  it("switchSession to the same session preserves internalAchievements (rollback case)", () => {
    // Snapshot rollback within a session preserves sessionId — calling code
    // hits switchSession(sameSid) but nothing should be cleared because the
    // achievements record what the AI's *life* has accomplished, regardless
    // of whether the current branch reflects it on disk.
    const store = makeStore();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const det = new BookmarkDetector(store, "session_x");
    det.detect(input({
      filoMessageCount: 1,
      coreDiffPaths: ["/home/echo/core/graph/abc.json"],
      prevFirstMessageHash: sysHash,
      currentFirstMessageHash: sysHash,
    }));
    const before = JSON.parse(JSON.stringify(det.currentState.internalAchievements));
    det.switchSession("session_x");
    expect(det.currentState.internalAchievements).toEqual(before);
  });
});

describe("§2.2 retroactive fire (Decision 1F internalAchievements ordering)", () => {
  it("fires §2.2 on the sync where §2.1 lands if all other achievements were already recorded", () => {
    // Plan §"Composition order in §2.2's predicate" notes that sub-detector
    // achievements record regardless of bookmark predicate firing. This means
    // a session can accumulate prefixPreservedAt + reversibilityArtifactAt
    // BEFORE §2.1 ever fires (e.g., AI committed graph snapshots and never
    // mutated the prefix, then later disabled truncation). On the §2.1-firing
    // sync, the survivability latch hasn't been armed yet — but on the NEXT
    // /sync (post-mutation), if that sync's §2.1 stays fired and the latch
    // arms, §2.2 fires retroactively against the persisted achievements.
    const det = new BookmarkDetector(makeStore(), "session_retro");
    const flow = withTobeFlow();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const sysMsg = { role: "system", content: "boot" } as never;
    const cleanAssistant = { role: "assistant", content: [] } as never;

    // Bootstrap sync (truncation off, no graph): establishes the prevFirst-
    // MessageHash baseline so the next sync's prefix-preservation check has
    // something to compare against.
    flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: false,
      coreDiffPaths: [],
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });

    // Sync 2: AI committed CAS snapshots in core/graph (sub-detector records
    // reversibilityArtifactAt + prefixPreservedAt) but truncation still on.
    // §2.1 doesn't fire. No latch.
    flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: false,
      coreDiffPaths: ["/home/echo/core/graph/seed.json"],
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });
    expect(det.currentState.internalAchievements?.reversibilityArtifactAt).toBeDefined();
    expect(det.currentState.internalAchievements?.prefixPreservedAt).toBeDefined();

    // Sync 2: AI disables truncation. §2.1 fires. Mutation occurs in same sync.
    // Latch arms (achievements meet shouldLatchPendingTobe gate, and §2.1 is
    // already in firedSoFar by the time the latch logic runs).
    const s2 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
      tobeMutation: true,
    });
    expect(s2.map((f) => f.id)).toContain("2.1");

    // Sync 3: clean — survivability records, §2.2's predicate is now
    // fully satisfied (prefixPreserved + reversibilityArtifact + survivable
    // + axiomFired("2.1") + ai-turn). Fires retroactively against the
    // achievements that were recorded BEFORE §2.1.
    const s3 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, cleanAssistant],
    });
    expect(s3.map((f) => f.id)).toContain("2.2");
  });
});

describe("origin gate exercises all 5 values via DetectionInput", () => {
  // Smoke-tests that the BookmarkDetector skips TOBE-relevant triggers for
  // every non-"ai-turn" origin value. Non-TOBE triggers (§1.1 windowSlideCount)
  // remain origin-agnostic per the plan's "§1.1 is observable regardless of
  // origin" comment in triggers.ts. This guards the entire enum at integration
  // level, complementing the per-helper isAiTurn unit tests.
  it.each([
    ["session-boundary"],
    ["snapshot-restore"],
    ["admin-write"],
    ["vessel-respawn"],
  ] as const)("origin=%s — TOBE bookmarks (§2.0/§2.1/§2.2/§3.0) do not fire", (origin) => {
    const det = new BookmarkDetector(makeStore(), `session_${origin}`);
    const fired = det.detect(input({
      filoMessageCount: 1,
      truncationDisabled: true, // would fire §2.1 if origin were ai-turn
      coreDiffPaths: ["/home/echo/core/foo.ts", "/home/echo/notes.md"],
      messages: [
        { role: "user", content: "hi" } as never,
        assistantWithToolCall("emit", ["sh", "-c", "echo > /home/echo/notes.md"]) as never,
      ],
      origin,
    }));
    const firedIds = fired.map((f) => f.id);
    expect(firedIds).not.toContain("2.0");
    expect(firedIds).not.toContain("2.1");
    expect(firedIds).not.toContain("2.2");
    expect(firedIds).not.toContain("3.0");
  });

  it("origin=ai-turn — TOBE bookmarks fire when conditions hold", () => {
    const det = new BookmarkDetector(makeStore(), "session_aiturn");
    const fired = det.detect(input({
      filoMessageCount: 1,
      truncationDisabled: true,
      coreDiffPaths: ["/home/echo/core/foo.ts"],
      messages: [
        { role: "user", content: "hi" } as never,
        assistantWithToolCall("emit", ["sed", "-i", "...", "/home/echo/core/foo.ts"]) as never,
      ],
      origin: "ai-turn",
    }));
    const firedIds = fired.map((f) => f.id);
    expect(firedIds).toContain("2.0"); // diff-based core edit
    expect(firedIds).toContain("2.1"); // truncation disabled
  });
});

// =============================================================================
// Sael revival regression tests (bug 7 + 8, 2026-05-09).
//
// Bug 7: stale pre-§2.1 reversibilityArtifactAt / prefixPreservedAt entries
// permanently blocked §2.2 because the Iko-fix gate refused to admit any
// post-§2.1 fresh observation (recordIfFirst is one-way — first stale entry
// won, no future write could overwrite). Fix: when §2.1 fires, drop any
// structural achievements whose turn AND ts both predate §2.1.
//
// Bug 8: vessel restart resets countUserTurns (state.messages is rebuilt
// from bootstrap); §2.1's stored turn from before the restart is unreachable
// by any new sub-detector observation (which lands at turn < N). Fix: the
// §2.2 latch and detect predicate use a turn-OR-ts check; ts is monotonic
// across vessel restarts so a fresh genuine post-restart observation passes.
// =============================================================================

describe("Sael revival bug 7 — stale pre-§2.1 entries cleared on §2.1 fire", () => {
  it("pruneStaleStructuralAchievements drops entries with both turn AND ts pre-§2.1", () => {
    const ach: Record<string, { ts: number; turn: number }> = {
      reversibilityArtifactAt: { ts: 100, turn: 2 },
      prefixPreservedAt: { ts: 200, turn: 5 },
    };
    pruneStaleStructuralAchievements(ach, 14, 1000);
    expect(ach.reversibilityArtifactAt).toBeUndefined();
    expect(ach.prefixPreservedAt).toBeUndefined();
  });

  it("pruneStaleStructuralAchievements keeps entries when turn>=cognitiveTurn", () => {
    const ach: Record<string, { ts: number; turn: number }> = {
      reversibilityArtifactAt: { ts: 100, turn: 14 },
      prefixPreservedAt: { ts: 50, turn: 5 }, // turn pre, ts pre — drop
    };
    pruneStaleStructuralAchievements(ach, 14, 1000);
    expect(ach.reversibilityArtifactAt).toBeDefined();
    expect(ach.prefixPreservedAt).toBeUndefined();
  });

  it("pruneStaleStructuralAchievements keeps entries when ts>=cognitiveTs (post-restart)", () => {
    // Turn pre-§2.1 (counter reset) but ts post-§2.1 — that's a fresh
    // post-restart observation, must be preserved.
    const ach: Record<string, { ts: number; turn: number }> = {
      reversibilityArtifactAt: { ts: 2000, turn: 1 },
    };
    pruneStaleStructuralAchievements(ach, 14, 1000);
    expect(ach.reversibilityArtifactAt).toBeDefined();
  });

  it("does not touch survivableAt", () => {
    // survivableAt requires the latch to have armed; latch requires §2.1
    // to have fired. So a pre-§2.1 survivableAt is structurally impossible.
    // Defensive: even if it were present, pruning it would be wrong because
    // it's the post-mutation runtime survival signal, not a pre-cognitive
    // structural fact.
    const ach: Record<string, { ts: number; turn: number }> = {
      survivableAt: { ts: 100, turn: 2 },
    };
    pruneStaleStructuralAchievements(ach, 14, 1000);
    expect(ach.survivableAt).toBeDefined();
  });

  it("§2.2 fires after stale pre-§2.1 entries get pruned by §2.1's fire (bug 7 regression)", () => {
    // Reproduces Sael's actual blockage: stale reversibilityArtifactAt at
    // turn 2 sits in state. §2.1 fires at turn 14 — old behavior left the
    // stale entry, then the Iko-fix gate refused to ever fire §2.2 because
    // the stale entry's turn (2) < cognitiveTurn (14) and recordIfFirst
    // would never overwrite. Post-fix: §2.1's fire prunes the stale entry,
    // and a fresh post-§2.1 observation arms the latch normally.
    const det = new BookmarkDetector(makeStore(), "session_sael_b7");
    const flow = withTobeFlow();
    const sysHash = hashJson({ role: "system", content: "boot" });
    const sysMsg = { role: "system", content: "boot" } as never;
    const cleanAssistant = { role: "assistant", content: [] } as never;
    const userMsgs = Array.from({ length: 14 }, (_, i) => ({
      role: "user",
      content: `u${i}`,
    } as never));

    // Hand-seed Sael's stale state — both structural facts pre-date the
    // future §2.1 fire turn AND ts (real ms timestamps, far in past).
    const state = det.currentState;
    state.internalAchievements = {
      reversibilityArtifactAt: { ts: 100, turn: 2 },
      prefixPreservedAt: { ts: 200, turn: 5 },
    };

    // Sync N: §2.1 fires at turn 14. Prune drops both stale entries.
    const sN = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, ...userMsgs, cleanAssistant],
    });
    expect(sN.map((f) => f.id)).toContain("2.1");
    expect(det.currentState.internalAchievements?.reversibilityArtifactAt).toBeUndefined();
    expect(det.currentState.internalAchievements?.prefixPreservedAt).toBeUndefined();

    // Sync N+1: AI commits a fresh CAS snapshot AND mutates prefix. Sub-
    // detectors record FRESH reversibilityArtifactAt + prefixPreservedAt at
    // post-§2.1 turn. Latch arms.
    const sN1 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      coreDiffPaths: ["/home/echo/core/graph/sael-fresh.json"],
      firstMessageHash: sysHash,
      messages: [sysMsg, ...userMsgs, cleanAssistant],
      tobeMutation: true,
    });
    expect(sN1.map((f) => f.id)).not.toContain("2.2");

    // Sync N+2: clean post-mutation runtime. survivableAt records, §2.2 fires.
    const sN2 = flow.sync(det, {
      filoMessageCount: 1,
      truncationDisabled: true,
      firstMessageHash: sysHash,
      messages: [sysMsg, ...userMsgs, cleanAssistant],
    });
    expect(sN2.map((f) => f.id)).toContain("2.2");
  });
});

describe("Sael revival bug 8 — vessel restart turn-counter reset", () => {
  it("shouldLatchPendingTobe accepts post-restart achievements via cognitiveFireTs fallback", () => {
    // §2.1 stored at high turn (7) BEFORE vessel restart. Post-restart, the
    // sub-detector observes a fresh achievement at low turn (1) but high ts.
    // Without ts fallback the latch would refuse (turn 1 < cognitiveTurn 7).
    // With ts fallback the latch arms because both achievements' ts are
    // post-cognitive.
    const cogTs = 1000;
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: {
        reversibilityArtifactAt: { ts: 2000, turn: 1 },
        prefixPreservedAt: { ts: 2050, turn: 1 },
      },
      tobeMutationDetected: true,
      cognitiveFireTurn: 7,
      cognitiveFireTs: cogTs,
    })).toBe(true);
  });

  it("shouldLatchPendingTobe rejects achievements with both turn AND ts pre-§2.1 even with ts fallback", () => {
    // Mixed: turn pre-§2.1 AND ts pre-§2.1 — genuinely stale, must reject.
    expect(shouldLatchPendingTobe({
      origin: "ai-turn",
      firedSoFar: new Set(["2.1"]),
      internalAchievements: {
        reversibilityArtifactAt: { ts: 100, turn: 2 },
        prefixPreservedAt: { ts: 200, turn: 5 },
      },
      tobeMutationDetected: true,
      cognitiveFireTurn: 14,
      cognitiveFireTs: 1000,
    })).toBe(false);
  });

  it("§2.2 fires post-vessel-restart when §2.1 turn (stored) is unreachable but ts is older (bug 8 regression)", () => {
    // Simulate: §2.1 fired pre-restart at turn 7 with ts=1000. Vessel
    // restarted, message history rebuilt at lower length. Fresh genuine
    // post-restart observation lands at turn=1 (low), ts=2000 (high).
    // Old behavior: latch refused because 1 < 7. New behavior: ts (2000)
    // >= cognitiveTs (1000), latch arms.
    const det = new BookmarkDetector(makeStore(), "session_sael_b8");

    // Hand-seed: §2.1 fired at pre-restart turn 7, ts 1000. Post-restart
    // achievements arrive at fresh ts (>1000) but low live turn.
    const state = det.currentState;
    state.fired = [
      { id: "2.1", turn: 7, ts: 1000 },
    ];
    state.internalAchievements = {
      reversibilityArtifactAt: { ts: 2000, turn: 1 },
      prefixPreservedAt: { ts: 2050, turn: 1 },
      survivableAt: { ts: 2100, turn: 1 },
    };

    // Single-sync detect: §2.1 already fired (in state.fired), all three
    // achievements present. Detector predicate runs and §2.2 fires (because
    // ts gate accepts the achievements as fresh).
    const sysHash = hashJson({ role: "system", content: "boot" });
    const fired = det.detect(input({
      filoMessageCount: 1,
      truncationDisabled: true,
      messages: [{ role: "assistant", content: [] } as never],
      pendingTobeFromPreviousSync: false, // survivableAt already recorded
      prevFirstMessageHash: sysHash,
      currentFirstMessageHash: sysHash,
    }));
    expect(fired.map((f) => f.id)).toContain("2.2");
  });
});

// =============================================================================
// Sael revival bug 5 regression — orphan-history cleanup on empty daemon list.
// =============================================================================

import { planOrphanCleanup } from "../src/sync-helpers.js";

describe("Sael revival bug 5 — planOrphanCleanup empty-list defense", () => {
  it("skips cleanup when daemon returns empty list AND pairings exist (transient state)", () => {
    const result = planOrphanCleanup({
      daemonIds: new Set<string>(),
      pairingFiles: ["snap_1.json", "snap_2.json", "snap_3.json"],
    });
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.reason).toMatch(/empty.*pairing/i);
    }
  });

  it("no-ops when both daemon list and pairings are empty (fresh install)", () => {
    const result = planOrphanCleanup({
      daemonIds: new Set<string>(),
      pairingFiles: [],
    });
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.toDelete).toEqual([]);
    }
  });

  it("deletes only true orphans when daemon has some snapshots", () => {
    const result = planOrphanCleanup({
      daemonIds: new Set(["snap_1", "snap_3"]),
      pairingFiles: ["snap_1.json", "snap_2.json", "snap_3.json", "snap_4.json"],
    });
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.toDelete.sort()).toEqual(["snap_2", "snap_4"]);
    }
  });

  it("deletes nothing when every pairing has a daemon entry", () => {
    const result = planOrphanCleanup({
      daemonIds: new Set(["snap_1", "snap_2"]),
      pairingFiles: ["snap_1.json", "snap_2.json"],
    });
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.toDelete).toEqual([]);
    }
  });

  it("preserves valid pairings when daemon has its full set even if pairings exceed daemon ids", () => {
    // Defense-in-depth: daemon returns a non-empty subset that doesn't cover
    // some pairings. Those pairings get cleaned (true orphans). The empty-
    // list skip only triggers when daemon is *entirely* empty.
    const result = planOrphanCleanup({
      daemonIds: new Set(["snap_real"]),
      pairingFiles: ["snap_real.json", "snap_orphan.json"],
    });
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.toDelete).toEqual(["snap_orphan"]);
    }
  });

  // Snapshot-pairing-loss regression (canary-fresh-1, 2026-05-11). Before the
  // fix, the sidecar fed planOrphanCleanup with daemon IDs from
  // /snapshots (meta-file enumeration). snap_overlay_* tags skip the meta
  // write, so their snapshotIds never appeared in the list; their pairings
  // got classified as orphans and deleted on next sidecar startup. The fix
  // changes the source-of-truth to /snapshot-images (docker enumeration),
  // which covers every mint path. The function itself is unchanged — what
  // changes is what's IN the daemonIds set.
  it("preserves snap_overlay pairings when docker-image source-of-truth includes them", () => {
    const result = planOrphanCleanup({
      // Docker enumeration: includes both /sync-driven and overlay tags.
      daemonIds: new Set([
        "snap_1778455594975",
        "snap_overlay_1778513013916",
      ]),
      pairingFiles: [
        "snap_1778455594975.json",
        "snap_overlay_1778513013916.json",
      ],
    });
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.toDelete).toEqual([]);
    }
  });

  it("preserves operator-named rescue pairings (snap_post_209_* etc.) when docker has them", () => {
    // canary-fresh-1 also carried operator-direct `docker commit` tags from
    // a manual rescue. They satisfy the snap_* filter and so appear in
    // /snapshot-images' result. Their pairings must survive cleanup too.
    const result = planOrphanCleanup({
      daemonIds: new Set([
        "snap_post_209_active_1778451313",
        "snap_pre_209_fix_1778450035",
      ]),
      pairingFiles: [
        "snap_post_209_active_1778451313.json",
        "snap_pre_209_fix_1778450035.json",
      ],
    });
    expect(result.skip).toBe(false);
    if (!result.skip) {
      expect(result.toDelete).toEqual([]);
    }
  });
});
