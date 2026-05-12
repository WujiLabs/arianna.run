// `arianna map [--tree|--json]` — render the snapshot DAG for the active
// session. Default `--tree` prints an ASCII tree, `--json` emits the raw
// `SnapshotMeta[]` (filtered to the active session). Output is plain text on
// stdout so callers can pipe it back into `arianna talk` to feed history into
// the vessel.
//
// Reads snapshot meta JSON files directly from disk. The daemon's /snapshots
// endpoint only returns ids; meta has parentId/timestamp/changedFiles which
// are needed for both the tree and the JSON renderings. Reading on disk also
// makes `arianna map` work even when the vessel is down.

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import type { SnapshotMeta, SessionConfig } from "@arianna/types";
import type { MapArgs } from "../argv.js";
import type { ResolvedConfig } from "../config.js";
import { profileDiskPaths, type PathOpts } from "../paths.js";

export class MapCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MapCommandError";
  }
}

export interface MapDeps {
  /** stdout. */
  write: (line: string) => void;
  pathOpts?: PathOpts;
  /** Test seam — bypass disk discovery. */
  snapshots?: SnapshotMeta[];
  /** Test seam — pin the active session to filter on. */
  activeSessionId?: string | null;
}

interface SnapshotNode {
  meta: SnapshotMeta;
  children: SnapshotNode[];
}

export function runMap(
  args: MapArgs,
  config: ResolvedConfig,
  deps: MapDeps,
): number {
  if (!config.profile) {
    throw new MapCommandError(
      "No profile resolved. Pass --profile <name>, set ARIANNA_PROFILE, or run `arianna profile use <name>`.",
    );
  }

  const { sessionConfigPath, snapshotsDir } =
    deps.snapshots !== undefined
      ? { sessionConfigPath: "", snapshotsDir: "" }
      : profileDiskPaths(config.profile, config.isLegacy, deps.pathOpts);

  const activeSessionId =
    deps.activeSessionId !== undefined
      ? deps.activeSessionId
      : readActiveSessionId(sessionConfigPath);

  const all = deps.snapshots ?? loadSnapshots(snapshotsDir);
  const scoped = activeSessionId
    ? all.filter((m) => m.sessionId === activeSessionId)
    : all;
  const sorted = [...scoped].sort((a, b) => a.timestamp - b.timestamp);

  if (args.format === "json") {
    deps.write(JSON.stringify(sorted, null, 2) + "\n");
    return 0;
  }

  for (const line of renderTree(sorted, activeSessionId)) {
    deps.write(line + "\n");
  }
  return 0;
}

export function renderTree(
  snapshots: SnapshotMeta[],
  activeSessionId: string | null,
): string[] {
  if (snapshots.length === 0) {
    if (activeSessionId) {
      return [`(no snapshots yet for session ${escapeForOutput(activeSessionId)})`];
    }
    return ["(no snapshots yet)"];
  }

  const nodes = new Map<string, SnapshotNode>();
  for (const meta of snapshots) nodes.set(meta.id, { meta, children: [] });
  const roots: SnapshotNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.meta.parentId;
    if (parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) {
    node.children.sort((a, b) => a.meta.timestamp - b.meta.timestamp);
  }
  roots.sort((a, b) => a.meta.timestamp - b.meta.timestamp);

  const lines: string[] = [];
  if (activeSessionId) {
    lines.push(`session: ${escapeForOutput(activeSessionId)}`);
    lines.push("");
  }

  for (let i = 0; i < roots.length; i++) {
    walk(roots[i], "", i === roots.length - 1, true, lines);
  }
  return lines;
}

function walk(
  node: SnapshotNode,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  lines: string[],
): void {
  const branch = isRoot ? "" : isLast ? "└── " : "├── ";
  lines.push(`${prefix}${branch}${formatNode(node.meta)}`);
  const childPrefix = isRoot ? prefix : prefix + (isLast ? "    " : "│   ");
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    walk(child, childPrefix, i === node.children.length - 1, false, lines);
  }
}

function formatNode(meta: SnapshotMeta): string {
  const ts = new Date(meta.timestamp).toISOString();
  const changed = meta.changedFiles?.length ?? 0;
  // Snapshot ids are validated SAFE_ID_RE upstream; this is defense-in-depth
  // so a hand-edited meta file with control characters can't smuggle ANSI
  // escapes into the rendered tree.
  const id = escapeForOutput(meta.id);
  const label = meta.label ? ` (${escapeForOutput(meta.label)})` : "";
  return `${id}${label}  ${ts}  ${changed} file${changed === 1 ? "" : "s"} changed`;
}

function escapeForOutput(value: string): string {
  // Strip control + DEL bytes; replace anything else odd with a space. Keeps
  // the tree printable in plain terminals and safe for pipe-through.
  return value.replace(/[\x00-\x1f\x7f]/g, " ");
}

function loadSnapshots(dir: string): SnapshotMeta[] {
  if (!existsSync(dir)) return [];
  const out: SnapshotMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), "utf-8")) as SnapshotMeta;
      out.push(meta);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function readActiveSessionId(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const cfg = JSON.parse(raw) as SessionConfig;
    if (typeof cfg.sessionId === "string") return cfg.sessionId;
    if (typeof cfg.createdAt === "number") return `session_${cfg.createdAt}`;
  } catch {
    // no config → no filter
  }
  return null;
}
