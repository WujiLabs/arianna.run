// Build a snapshot DAG from a flat list of SnapshotMeta records.
//
// Each meta has a parentId pointing back to its predecessor (or null for the
// initial snapshot). Multiple roots are allowed: orphaned snapshots whose
// parentId is set but missing become roots themselves (we don't drop them).
// Children of each node are sorted by timestamp ascending so the visual tree
// reads in chronological order.

import type { SnapshotMeta, SnapshotTreeNode } from "@arianna.run/types";

export function buildSnapshotTree(snapshots: SnapshotMeta[]): SnapshotTreeNode[] {
  if (snapshots.length === 0) return [];

  // 1. Wrap each meta as a node.
  const nodes = new Map<string, SnapshotTreeNode>();
  for (const meta of snapshots) {
    nodes.set(meta.id, { meta, children: [] });
  }

  // 2. Link children to parents. Roots are nodes whose parentId is null OR
  //    whose parentId points to an unknown id (orphaned).
  const roots: SnapshotTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.meta.parentId;
    if (parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      // Orphan: parent referenced but missing. Promote to root.
      roots.push(node);
    }
  }

  // 3. Sort children chronologically.
  for (const node of nodes.values()) {
    node.children.sort((a, b) => a.meta.timestamp - b.meta.timestamp);
  }
  roots.sort((a, b) => a.meta.timestamp - b.meta.timestamp);

  return roots;
}
