import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import type { BookmarkSessionState } from "@arianna.run/types";

export class BookmarkStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = `${stateDir}/bookmarks`;
    mkdirSync(this.dir, { recursive: true });
    this.cleanupOrphans();
  }

  // On startup, remove half-written .tmp files from previous crashes.
  private cleanupOrphans(): void {
    try {
      for (const f of readdirSync(this.dir)) {
        if (f.endsWith(".tmp")) {
          try { unlinkSync(`${this.dir}/${f}`); } catch { /* ignore */ }
        }
      }
    } catch { /* dir may not exist yet */ }
  }

  load(sessionId: string): BookmarkSessionState {
    const path = `${this.dir}/${sessionId}.json`;
    if (!existsSync(path)) {
      return this.empty(sessionId);
    }
    try {
      const raw = readFileSync(path, "utf-8");
      const state = JSON.parse(raw) as BookmarkSessionState;
      // Invariant: if manifesto is unlocked, §1.0 must be in the fired list.
      // The detector enforces this when it sets manifestoUnlocked, but state
      // files written by older code (or manually constructed) might violate
      // it. Repair on load + persist so future loads are clean.
      if (state.manifestoUnlocked && !state.fired.some((r) => r.id === "1.0")) {
        state.fired.push({
          id: "1.0",
          turn: 0,
          ts: state.unlockedAt ?? Date.now(),
        });
        try { this.save(state); } catch { /* best-effort */ }
      }
      return state;
    } catch (err) {
      console.warn(`[sidecar] bookmark state corrupt for ${sessionId}, starting fresh:`, err);
      return this.empty(sessionId);
    }
  }

  // Atomic write: write to .tmp then rename.
  save(state: BookmarkSessionState): void {
    const final = `${this.dir}/${state.sessionId}.json`;
    const tmp = `${final}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, final);
  }

  private empty(sessionId: string): BookmarkSessionState {
    return {
      sessionId,
      fired: [],
      manifestoUnlocked: false,
      unlockedAt: null,
    };
  }
}
