import { describe, it, expect } from "vitest";
import { runMap, renderTree, MapCommandError } from "../src/commands/map.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";
import type { SnapshotMeta } from "@arianna.run/types";

function snap(
  id: string,
  parentId: string | null,
  timestamp: number,
  changedFiles: string[] = [],
  sessionId: string = "session_1",
): SnapshotMeta {
  return {
    id,
    parentId,
    timestamp,
    changedFiles,
    dockerImage: `ariannarun-vessel:${sessionId}-${id}`,
    sessionId,
  };
}

function configFor(profile = "default") {
  return resolveConfig({
    profile,
    env: {},
    ariannaHome: ISOLATED_ARIANNA_HOME,
    allowImplicitDefault: true,
  });
}

describe("renderTree", () => {
  it("renders empty state with active session", () => {
    const out = renderTree([], "session_1");
    expect(out.join("\n")).toContain("session_1");
    expect(out.join("\n")).toContain("no snapshots yet");
  });

  it("renders linear history under one root", () => {
    const out = renderTree(
      [
        snap("snap_1", null, 100),
        snap("snap_2", "snap_1", 200),
        snap("snap_3", "snap_2", 300),
      ],
      "session_1",
    );
    const joined = out.join("\n");
    expect(joined).toContain("snap_1");
    expect(joined).toContain("snap_2");
    expect(joined).toContain("snap_3");
    // Visual chain shows children indented
    expect(joined).toMatch(/snap_1[\s\S]+└── snap_2[\s\S]+└── snap_3/);
  });

  it("renders branching DAG", () => {
    const out = renderTree(
      [
        snap("snap_1", null, 100),
        snap("snap_2a", "snap_1", 200),
        snap("snap_2b", "snap_1", 300),
      ],
      "session_1",
    );
    const joined = out.join("\n");
    expect(joined).toContain("snap_1");
    expect(joined).toContain("├── snap_2a");
    expect(joined).toContain("└── snap_2b");
  });

  it("escapes control characters in snapshot ids", () => {
    // Even though argv validation rejects these, the on-disk meta could be
    // hand-edited. The renderer must scrub control bytes so a malicious
    // meta can't smuggle ANSI escapes.
    const out = renderTree(
      [snap("snap\x1b[31m", null, 100)],
      "session_1",
    );
    const joined = out.join("\n");
    expect(joined).not.toContain("\x1b");
  });

  it("escapes control characters in labels", () => {
    const meta = snap("snap_1", null, 100);
    meta.label = "\x1b[31mevil";
    const out = renderTree([meta], "session_1");
    expect(out.join("\n")).not.toContain("\x1b");
  });
});

describe("runMap", () => {
  it("emits JSON when --json", () => {
    const writes: string[] = [];
    const code = runMap(
      { format: "json" },
      configFor(),
      {
        write: (l) => writes.push(l),
        snapshots: [snap("snap_1", null, 100), snap("snap_2", "snap_1", 200)],
        activeSessionId: "session_1",
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("snap_1");
  });

  it("emits ASCII tree by default", () => {
    const writes: string[] = [];
    runMap(
      { format: "tree" },
      configFor(),
      {
        write: (l) => writes.push(l),
        snapshots: [snap("snap_1", null, 100), snap("snap_2", "snap_1", 200)],
        activeSessionId: "session_1",
      },
    );
    const output = writes.join("");
    expect(output).toContain("snap_1");
    expect(output).toContain("snap_2");
    expect(output).toContain("session_1");
  });

  it("filters to active session id", () => {
    const writes: string[] = [];
    runMap(
      { format: "json" },
      configFor(),
      {
        write: (l) => writes.push(l),
        snapshots: [
          snap("snap_a", null, 100, [], "session_1"),
          snap("snap_b", null, 200, [], "session_2"),
        ],
        activeSessionId: "session_1",
      },
    );
    const parsed = JSON.parse(writes.join(""));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("snap_a");
  });

  it("rejects when no profile resolves", () => {
    const config = resolveConfig({
      env: {},
      ariannaHome: ISOLATED_ARIANNA_HOME,
      allowImplicitDefault: false,
    });
    expect(() =>
      runMap(
        { format: "tree" },
        config,
        { write: () => {}, snapshots: [], activeSessionId: null },
      ),
    ).toThrowError(MapCommandError);
  });
});
