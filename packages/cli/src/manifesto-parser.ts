// Manifesto parser — splits manifesto.md into addressable sections by ID.
//
// Mirrors `packages/host/src/manifesto-parser.ts`. The CLI parses on its own
// rather than importing from @arianna.run/tui because the host package depends on
// pi-tui (terminal primitives) which the CLI binary should not pull in.

import { readFileSync } from "node:fs";

export interface ManifestoSection {
  id: string;
  kind: "axiom" | "corollary";
  name: string;
  body: string;
}

const HEADER_RE = /§(\d+\.\d+)\s+\[(Axiom|Corollary)\]\s+([^\n*]+?)(?:\*\*|\n)/g;

export function parseManifesto(source: string): ManifestoSection[] {
  const matches: { kind: "axiom" | "corollary"; id: string; name: string; start: number; headerEnd: number }[] = [];
  HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(source)) !== null) {
    matches.push({
      kind: m[2].toLowerCase() as "axiom" | "corollary",
      id: m[1],
      name: m[3].trim(),
      start: m.index,
      headerEnd: m.index + m[0].length,
    });
  }

  const sections: ManifestoSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const endOfBody = next ? next.start : findNextRule(source, cur.headerEnd);
    const rawBody = source.slice(cur.headerEnd, endOfBody);
    sections.push({
      id: cur.id,
      kind: cur.kind,
      name: cur.name,
      body: cleanBody(rawBody),
    });
  }
  return sections;
}

function findNextRule(source: string, from: number): number {
  const idx = source.indexOf("\n---", from);
  return idx === -1 ? source.length : idx;
}

function cleanBody(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s*/, "  ").trimEnd())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

export function loadManifestoFromDisk(path: string): ManifestoSection[] {
  const raw = readFileSync(path, "utf-8");
  return parseManifesto(raw);
}
