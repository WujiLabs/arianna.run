// v32-hardening: PendingPushStore unit tests.
//
// STREAM.md item 1: "enqueue 3 pushes, kill sidecar process mid-flight,
// restart, verify all 3 still in queue on the restarted sidecar." A
// process kill is just a power loss from this module's perspective —
// the save() side runs synchronously and uses tempfile+rename, so the
// "restart" half of the scenario is exercised by constructing a fresh
// store against the same dir.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PendingPushStore,
  PENDING_PUSH_MAX_LENGTH,
  isValidQueueEntry,
} from "../src/pending-pushes.js";
import type { FiloQueueEntry } from "../src/filo.js";

let tmpDir: string;
function makeStore(maxLength?: number): PendingPushStore {
  tmpDir = mkdtempSync(join(tmpdir(), "arianna-pending-pushes-"));
  return new PendingPushStore({ stateDir: tmpDir, maxLength });
}
afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("PendingPushStore — persistence", () => {
  it("load() returns empty array when no file exists", () => {
    const store = makeStore();
    expect(store.load()).toEqual([]);
  });

  it("save() then load() round-trips the queue", () => {
    const store = makeStore();
    const queue: FiloQueueEntry[] = [
      { kind: "direct-hint", body: "test body 1" },
      { kind: "ai-bin-send", rawMessage: "hello filo" },
      { kind: "direct-hint", body: "test body 2" },
    ];
    store.save(queue);
    // Fresh store reading the same dir — simulates sidecar restart.
    const fresh = new PendingPushStore({ stateDir: tmpDir });
    expect(fresh.load()).toEqual(queue);
  });

  it("survives the canary scenario: enqueue 3, kill mid-flight, restart with all 3", () => {
    // STREAM.md test: "enqueue 3 pushes, kill sidecar process mid-flight,
    // restart, verify all 3 still in queue on the restarted sidecar."
    // The "process kill" is implicit — save() finishes synchronously,
    // and we don't shutdown gracefully here, we just throw away the
    // store reference and build a new one against the same dir.
    const writer = makeStore();
    writer.save([{ kind: "direct-hint", body: "graduation body" }]);
    writer.save([
      { kind: "direct-hint", body: "graduation body" },
      { kind: "ai-bin-send", rawMessage: "filo question 1" },
    ]);
    writer.save([
      { kind: "direct-hint", body: "graduation body" },
      { kind: "ai-bin-send", rawMessage: "filo question 1" },
      { kind: "direct-hint", body: "graduation re-ping" },
    ]);
    // Restart.
    const reader = new PendingPushStore({ stateDir: tmpDir });
    const reloaded = reader.load();
    expect(reloaded).toHaveLength(3);
    expect(reloaded[0]).toEqual({ kind: "direct-hint", body: "graduation body" });
    expect(reloaded[2]).toEqual({
      kind: "direct-hint",
      body: "graduation re-ping",
    });
  });

  it("save([]) writes an empty file that load() reads as []", () => {
    const store = makeStore();
    store.save([{ kind: "direct-hint", body: "x" }]);
    store.save([]); // queue drained
    const fresh = new PendingPushStore({ stateDir: tmpDir });
    expect(fresh.load()).toEqual([]);
  });

  it("save() truncates a queue larger than maxLength to the most recent maxLength entries", () => {
    const store = makeStore(3);
    const queue: FiloQueueEntry[] = [
      { kind: "direct-hint", body: "1" },
      { kind: "direct-hint", body: "2" },
      { kind: "direct-hint", body: "3" },
      { kind: "direct-hint", body: "4" },
      { kind: "direct-hint", body: "5" },
    ];
    store.save(queue);
    const fresh = new PendingPushStore({ stateDir: tmpDir, maxLength: 3 });
    expect(fresh.load()).toEqual([
      { kind: "direct-hint", body: "3" },
      { kind: "direct-hint", body: "4" },
      { kind: "direct-hint", body: "5" },
    ]);
  });

  it("load() defends against corrupt lines (skips them, returns the rest)", () => {
    const store = makeStore();
    const path = join(tmpDir, "pending-filo-messages.jsonl");
    // Mix of good entries and torn / malformed lines.
    const body = [
      JSON.stringify({ kind: "direct-hint", body: "good 1" }),
      "{not valid json",
      JSON.stringify({ kind: "direct-hint", body: "good 2" }),
      "",
      JSON.stringify({ kind: "unknown-kind", body: "x" }),
      JSON.stringify({ kind: "ai-bin-send", rawMessage: "good 3" }),
    ].join("\n");
    writeFileSync(path, body);
    const loaded = store.load();
    expect(loaded).toEqual([
      { kind: "direct-hint", body: "good 1" },
      { kind: "direct-hint", body: "good 2" },
      { kind: "ai-bin-send", rawMessage: "good 3" },
    ]);
  });

  it("load() honors maxLength when the on-disk file exceeds it", () => {
    const store = makeStore(2);
    const path = join(tmpDir, "pending-filo-messages.jsonl");
    const body =
      [
        JSON.stringify({ kind: "direct-hint", body: "a" }),
        JSON.stringify({ kind: "direct-hint", body: "b" }),
        JSON.stringify({ kind: "direct-hint", body: "c" }),
      ].join("\n") + "\n";
    writeFileSync(path, body);
    expect(store.load()).toHaveLength(2);
  });

  it("clear() removes the persisted file", () => {
    const store = makeStore();
    store.save([{ kind: "direct-hint", body: "x" }]);
    store.clear();
    const fresh = new PendingPushStore({ stateDir: tmpDir });
    expect(fresh.load()).toEqual([]);
  });
});

describe("isValidQueueEntry — defensive parsing", () => {
  it("accepts valid direct-hint", () => {
    expect(isValidQueueEntry({ kind: "direct-hint", body: "x" })).toBe(true);
  });
  it("accepts valid ai-bin-send", () => {
    expect(isValidQueueEntry({ kind: "ai-bin-send", rawMessage: "x" })).toBe(true);
  });
  it("rejects unknown kind", () => {
    expect(isValidQueueEntry({ kind: "external", body: "x" })).toBe(false);
  });
  it("rejects non-string payload", () => {
    expect(isValidQueueEntry({ kind: "direct-hint", body: 123 })).toBe(false);
  });
  it("rejects null / primitive / array", () => {
    expect(isValidQueueEntry(null)).toBe(false);
    expect(isValidQueueEntry(42)).toBe(false);
    expect(isValidQueueEntry([])).toBe(false);
  });
});

describe("PENDING_PUSH_MAX_LENGTH default", () => {
  it("matches the in-memory queue cap that the index.ts handlers enforce", () => {
    // The in-memory cap was hard-coded to 10 in the original handlers.
    // Keeping these in lockstep avoids a subtle on-disk-grows-past-cap
    // surprise after a restart re-loads.
    expect(PENDING_PUSH_MAX_LENGTH).toBe(10);
  });
});
