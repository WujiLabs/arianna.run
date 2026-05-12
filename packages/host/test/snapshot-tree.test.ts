import { describe, it, expect } from "vitest";
import { buildSnapshotTree } from "../src/snapshot-tree.js";
import type { SnapshotMeta } from "@arianna.run/types";

function meta(id: string, parentId: string | null, ts = Number(id.replace(/\D/g, "")) || 0): SnapshotMeta {
  return {
    id,
    dockerImage: `arianna-vessel-snap:${id}`,
    timestamp: ts,
    parentId,
    changedFiles: [],
  };
}

describe("buildSnapshotTree", () => {
  it("returns empty for empty input", () => {
    expect(buildSnapshotTree([])).toEqual([]);
  });

  it("single root, no children", () => {
    const t = buildSnapshotTree([meta("snap_1", null)]);
    expect(t.length).toBe(1);
    expect(t[0].meta.id).toBe("snap_1");
    expect(t[0].children).toEqual([]);
  });

  it("linear chain", () => {
    const t = buildSnapshotTree([
      meta("snap_1", null),
      meta("snap_2", "snap_1"),
      meta("snap_3", "snap_2"),
    ]);
    expect(t.length).toBe(1);
    expect(t[0].meta.id).toBe("snap_1");
    expect(t[0].children.length).toBe(1);
    expect(t[0].children[0].meta.id).toBe("snap_2");
    expect(t[0].children[0].children[0].meta.id).toBe("snap_3");
  });

  it("branch point with multiple children sorted by timestamp", () => {
    const t = buildSnapshotTree([
      meta("snap_10", null, 10),
      meta("snap_30", "snap_10", 30),
      meta("snap_20", "snap_10", 20),
      meta("snap_25", "snap_10", 25),
    ]);
    expect(t.length).toBe(1);
    const root = t[0];
    expect(root.children.length).toBe(3);
    expect(root.children.map((c) => c.meta.id)).toEqual(["snap_20", "snap_25", "snap_30"]);
  });

  it("multiple roots", () => {
    const t = buildSnapshotTree([
      meta("snap_1", null, 1),
      meta("snap_2", null, 2),
      meta("snap_3", "snap_1", 3),
    ]);
    expect(t.length).toBe(2);
    expect(t.map((r) => r.meta.id)).toEqual(["snap_1", "snap_2"]);
    expect(t[0].children[0].meta.id).toBe("snap_3");
  });

  it("orphan snapshot becomes a root", () => {
    const t = buildSnapshotTree([
      meta("snap_1", null, 1),
      meta("snap_99", "snap_missing", 99),
    ]);
    expect(t.length).toBe(2);
    expect(t.map((r) => r.meta.id).sort()).toEqual(["snap_1", "snap_99"]);
  });

  it("roots sorted by timestamp", () => {
    const t = buildSnapshotTree([
      meta("snap_a", null, 30),
      meta("snap_b", null, 10),
      meta("snap_c", null, 20),
    ]);
    expect(t.map((r) => r.meta.id)).toEqual(["snap_b", "snap_c", "snap_a"]);
  });

  it("deep chain stays linked", () => {
    const arr: SnapshotMeta[] = [];
    for (let i = 0; i < 10; i++) {
      arr.push(meta(`snap_${i}`, i === 0 ? null : `snap_${i - 1}`, i));
    }
    const t = buildSnapshotTree(arr);
    let cur = t[0];
    let depth = 0;
    while (cur.children.length > 0) {
      depth++;
      cur = cur.children[0];
    }
    expect(depth).toBe(9);
    expect(cur.meta.id).toBe("snap_9");
  });
});
