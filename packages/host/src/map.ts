// /map view — snapshot DAG browser using SnapshotTreeView inside VesselFrame.
//
// Loads snapshot meta files from workspace/snapshots/, builds the DAG, renders
// it with the tree view. Enter restores the selected snapshot via daemon /restore.
// F forwards the snapshot meta JSON into the chat input. Esc exits.

import { TUI, Text, Container, type Component } from "@mariozechner/pi-tui";
import { readFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import type { SnapshotMeta, SnapshotTreeNode, SessionConfig } from "@arianna/types";
import { VesselFrame } from "./components/vessel-frame.js";
import { SnapshotTreeView, formatSnapshotNode } from "./components/tree-view.js";
import { buildSnapshotTree } from "./snapshot-tree.js";

// Resolve to repo root the same way daemon does.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SNAPSHOTS_DIR = join(REPO_ROOT, "workspace", "snapshots");
const SESSION_CONFIG_PATH = join(REPO_ROOT, "workspace", "session_config.json");
const DAEMON_BASE_URL = process.env.DAEMON_BASE_URL ?? "http://127.0.0.1:9000";

function loadActiveSessionId(): string | null {
  try {
    const raw = readFileSync(SESSION_CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw) as SessionConfig;
    return cfg.sessionId ?? (cfg.createdAt ? `session_${cfg.createdAt}` : null);
  } catch {
    return null;
  }
}

export interface MapViewOptions {
  tui: TUI;
  onExit: () => void;
  onForward: (text: string) => void;
}

// Inner content component — renders either the tree or a status message after a switch.
class MapBody implements Component {
  private container: Container;
  private treeView: SnapshotTreeView | null = null;
  private statusText: Text | null = null;

  constructor() {
    this.container = new Container();
  }

  setTree(treeView: SnapshotTreeView): void {
    this.treeView = treeView;
    this.statusText = null;
    this.refresh();
  }

  setStatus(text: string, color: (s: string) => string = chalk.gray): void {
    this.statusText = new Text(color(text));
    this.refresh();
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.container.render(width);
  }

  private refresh(): void {
    this.container.clear();
    if (this.statusText) {
      this.container.addChild(this.statusText);
    } else if (this.treeView) {
      this.container.addChild(this.treeView);
    }
  }

  forwardInput(data: string): void {
    if (this.treeView) this.treeView.handleInput(data);
  }
}

export class MapView {
  private tui: TUI;
  private frame: VesselFrame;
  private body: MapBody;
  private snapshots: SnapshotMeta[] = [];
  private tree: SnapshotTreeNode[] = [];
  private treeView: SnapshotTreeView | null = null;
  private onExit: () => void;
  private onForward: (text: string) => void;
  private unsub: (() => void) | null = null;

  constructor(options: MapViewOptions) {
    this.tui = options.tui;
    this.onExit = options.onExit;
    this.onForward = options.onForward;
    this.body = new MapBody();
    this.frame = new VesselFrame({
      title: "Snapshot Map",
      hint: "[↑/↓] navigate   [Enter] restore   [F] forward to chat   [Esc/q] exit",
      content: this.body,
    });
  }

  mount(): void {
    this.loadSnapshots();
    this.tui.addChild(this.frame);
    this.tui.requestRender();
    this.unsub = this.tui.addInputListener((data: string) => this.handleInput(data));
  }

  unmount(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.tui.removeChild(this.frame);
    this.tui.requestRender();
  }

  private loadSnapshots(): void {
    const activeSessionId = loadActiveSessionId();
    try {
      const files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith(".json"));
      this.snapshots = files
        .map((f) => {
          const raw = readFileSync(join(SNAPSHOTS_DIR, f), "utf-8");
          return JSON.parse(raw) as SnapshotMeta;
        })
        // Phase 4: filter to the current session. Snapshots from other sessions
        // (or pre-Phase-4 metas with no sessionId) are hidden — pruning is
        // per-session via daemon /session/:id DELETE.
        .filter((m) => activeSessionId === null || m.sessionId === activeSessionId)
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      this.snapshots = [];
    }

    this.tree = buildSnapshotTree(this.snapshots);
    const currentLeafId = this.snapshots[this.snapshots.length - 1]?.id ?? null;

    if (this.snapshots.length === 0) {
      this.body.setStatus("  No snapshots yet.", chalk.gray);
      return;
    }

    const rows = (this.tui as unknown as { rows?: number }).rows ?? 30;
    const maxVisibleLines = Math.max(6, rows - 8); // leave room for chrome

    this.treeView = new SnapshotTreeView({
      tree: this.tree,
      currentLeafId,
      maxVisibleLines,
      formatNode: formatSnapshotNode,
      onSelect: (snapshotId) => this.switchToSnapshot(snapshotId),
      onCancel: () => this.onExit(),
    });
    this.body.setTree(this.treeView);
  }

  private handleInput(data: string): { consume?: boolean } | undefined {
    // F → forward selected snapshot meta as JSON into chat
    if (data === "f" || data === "F") {
      this.forwardSelected();
      return { consume: true };
    }
    // Everything else delegates to the tree view
    if (this.treeView) {
      this.body.forwardInput(data);
      this.tui.requestRender();
      return { consume: true };
    }
    // No tree (empty state) — Esc exits
    if (data === "\x1b" || data === "q" || data === "Q") {
      this.onExit();
      return { consume: true };
    }
    return undefined;
  }

  private async switchToSnapshot(snapshotId: string): Promise<void> {
    this.body.setStatus(`Switching to ${snapshotId}...`, chalk.yellow);
    this.tui.requestRender();

    try {
      const res = await fetch(`${DAEMON_BASE_URL}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((err as { error: string }).error);
      }

      this.body.setStatus(`Switched to ${snapshotId} successfully.`, chalk.green);
    } catch (err) {
      this.body.setStatus(`Switch failed: ${(err as Error).message}`, chalk.red);
    }
    this.tui.requestRender();
  }

  private forwardSelected(): void {
    if (this.snapshots.length === 0 || !this.treeView) return;
    // SnapshotTreeView keeps its own selectedIndex; expose via a getter call.
    // For v1 simplicity we forward the most recent snapshot (the leaf).
    const leaf = this.snapshots[this.snapshots.length - 1];
    const metaJson = JSON.stringify(leaf, null, 2);
    this.onForward(metaJson);
  }
}
