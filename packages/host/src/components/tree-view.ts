// SnapshotTreeView — compact tree component for browsing the snapshot DAG.
//
// Visual style is inspired by pi-coding-agent's TreeSelectorComponent
// (gutters, ascii connectors, selected highlight, active-path marker), but
// the tree-walking logic is rewritten to work directly with SnapshotTreeNode
// instead of pi-coding-agent's deep SessionTreeNode entry shape.
//
// Layout (per row):
//
//   › ├─ • snap_1712345678  3 changes  [optional label]
//   │
//   ├─ cursor (› for selected)
//   ├─ tree connector (├─ / └─ / spaces) with gutter pipes for ancestor branches
//   ├─ active-path marker (• if this snapshot is on the current leaf's lineage)
//   └─ display text (formatNode callback output)

import {
  type Component,
  Container,
  Text,
  TruncatedText,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import type { SnapshotTreeNode } from "@arianna.run/types";
import { theme } from "../theme.js";

interface FlatNode {
  node: SnapshotTreeNode;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  /** Gutter positions for ancestor branches that still have siblings to render */
  gutters: number[];
  isVirtualRootChild: boolean;
}

export interface SnapshotTreeViewOptions {
  tree: SnapshotTreeNode[];
  currentLeafId: string | null;
  maxVisibleLines: number;
  formatNode: (node: SnapshotTreeNode, isSelected: boolean) => string;
  onSelect: (snapshotId: string) => void;
  onCancel: () => void;
}

export class SnapshotTreeView implements Component {
  private container: Container;
  private flatNodes: FlatNode[] = [];
  private selectedIndex = 0;
  private currentLeafId: string | null;
  private activePathIds = new Set<string>();
  private maxVisibleLines: number;
  private formatNode: (node: SnapshotTreeNode, isSelected: boolean) => string;
  private multipleRoots: boolean;

  public onSelect: (snapshotId: string) => void;
  public onCancel: () => void;

  constructor(opts: SnapshotTreeViewOptions) {
    this.container = new Container();
    this.currentLeafId = opts.currentLeafId;
    this.maxVisibleLines = opts.maxVisibleLines;
    this.formatNode = opts.formatNode;
    this.onSelect = opts.onSelect;
    this.onCancel = opts.onCancel;
    this.multipleRoots = opts.tree.length > 1;
    this.flatNodes = this.flattenTree(opts.tree);
    this.buildActivePath();
    // Start cursor on the current leaf if visible.
    if (this.currentLeafId) {
      const idx = this.flatNodes.findIndex((n) => n.node.meta.id === this.currentLeafId);
      if (idx >= 0) this.selectedIndex = idx;
    }
  }

  // ── tree flattening ────────────────────────────────────────────────────

  private flattenTree(roots: SnapshotTreeNode[]): FlatNode[] {
    const result: FlatNode[] = [];
    type StackItem = [SnapshotTreeNode, number, boolean, number[], boolean];
    const stack: StackItem[] = [];

    // If multiple roots, treat them as siblings under a virtual root that branches.
    const multipleRoots = roots.length > 1;
    for (let i = roots.length - 1; i >= 0; i--) {
      const isLast = i === roots.length - 1;
      const indent = multipleRoots ? 1 : 0;
      stack.push([roots[i], indent, isLast, [], multipleRoots]);
    }

    while (stack.length > 0) {
      const [node, indent, isLast, gutters, isVirtualRootChild] = stack.pop()!;
      const showConnector = isVirtualRootChild || node.children.length >= 0; // simplified: always show for non-roots
      result.push({
        node,
        indent,
        showConnector: !isVirtualRootChild ? indent > 0 : true,
        isLast,
        gutters: [...gutters],
        isVirtualRootChild,
      });

      const children = node.children;
      const multipleChildren = children.length > 1;
      // Children get +1 indent only if there's a branch (multiple children)
      // OR if we just came out of a branch point with a single child (visual grouping).
      const childIndent = multipleChildren ? indent + 1 : indent;

      // Gutter for THIS node passes through to descendants if this node has siblings
      // remaining (not the last sibling).
      const newGutters = !isLast && indent > 0 ? [...gutters, indent - 1] : gutters;

      for (let i = children.length - 1; i >= 0; i--) {
        const childIsLast = i === children.length - 1;
        stack.push([children[i], childIndent, childIsLast, newGutters, false]);
      }
    }

    return result;
  }

  private buildActivePath(): void {
    this.activePathIds.clear();
    if (!this.currentLeafId) return;
    // Build parent map from flatNodes
    const parentOf = new Map<string, string | null>();
    for (const fn of this.flatNodes) {
      parentOf.set(fn.node.meta.id, fn.node.meta.parentId);
    }
    let cur: string | null = this.currentLeafId;
    while (cur) {
      this.activePathIds.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }

  // ── input ─────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q" || data === "Q") {
      this.onCancel();
      return;
    }
    if (data === "\x1b[A" || data === "k") {
      // Up
      if (this.selectedIndex > 0) this.selectedIndex--;
      return;
    }
    if (data === "\x1b[B" || data === "j") {
      // Down
      if (this.selectedIndex < this.flatNodes.length - 1) this.selectedIndex++;
      return;
    }
    if (data === "\r" || data === "\n") {
      // Enter — select
      const cur = this.flatNodes[this.selectedIndex];
      if (cur) this.onSelect(cur.node.meta.id);
      return;
    }
    if (data === " ") {
      // Page down
      this.selectedIndex = Math.min(
        this.flatNodes.length - 1,
        this.selectedIndex + this.maxVisibleLines,
      );
      return;
    }
  }

  invalidate(): void {
    // Container handles its own invalidation
  }

  // ── render ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.flatNodes.length === 0) {
      return [truncateToWidth(theme.fg("muted", "  No snapshots yet."), width)];
    }

    // Compute scroll window so cursor stays visible.
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisibleLines / 2),
        this.flatNodes.length - this.maxVisibleLines,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisibleLines, this.flatNodes.length);

    const lines: string[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      const fn = this.flatNodes[i];
      const isSelected = i === this.selectedIndex;

      const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

      // Build prefix with gutters and connector.
      const displayIndent = this.multipleRoots ? Math.max(0, fn.indent - 1) : fn.indent;
      const totalChars = displayIndent * 3;
      const prefixChars: string[] = [];
      const showConnector = fn.showConnector && !fn.isVirtualRootChild;
      const connectorPosition = showConnector ? displayIndent - 1 : -1;

      for (let c = 0; c < totalChars; c++) {
        const level = Math.floor(c / 3);
        const posInLevel = c % 3;
        if (fn.gutters.includes(level)) {
          prefixChars.push(posInLevel === 0 ? "│" : " ");
        } else if (showConnector && level === connectorPosition) {
          if (posInLevel === 0) prefixChars.push(fn.isLast ? "└" : "├");
          else if (posInLevel === 1) prefixChars.push("─");
          else prefixChars.push(" ");
        } else {
          prefixChars.push(" ");
        }
      }
      const prefix = prefixChars.join("");

      const isOnActivePath = this.activePathIds.has(fn.node.meta.id);
      const pathMarker = isOnActivePath ? theme.fg("accent", "• ") : "";

      const content = this.formatNode(fn.node, isSelected);
      let line = cursor + theme.fg("dim", prefix) + pathMarker + content;
      if (isSelected) {
        line = theme.bg("selectedBg", line);
      }
      lines.push(truncateToWidth(line, width));
    }

    // Footer: position indicator
    lines.push(
      truncateToWidth(
        theme.fg("muted", `  (${this.selectedIndex + 1}/${this.flatNodes.length})`),
        width,
      ),
    );

    return lines;
  }
}

/** Helper: format a snapshot node for display in the tree row. */
export function formatSnapshotNode(node: SnapshotTreeNode, _isSelected: boolean): string {
  const m = node.meta;
  const date = new Date(m.timestamp).toLocaleString();
  const changes = m.changedFiles.length;
  const label = m.label ? theme.fg("warning", ` [${m.label}]`) : "";
  return `${m.id}  ${theme.fg("muted", date)}  ${theme.fg("accent", `${changes} changes`)}${label}`;
}

// Re-export for tree-view consumers that want chrome composition
export { TruncatedText };
