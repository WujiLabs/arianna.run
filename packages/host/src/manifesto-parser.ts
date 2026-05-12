// Manifesto parser — splits manifesto.md into addressable sections by ID.
//
// The root manifesto.md is bilingual (Chinese first, English second per section).
// v1 player UI shows English only. We extract the English paragraphs anchored on
// the [Axiom X.X] and [Corollary X.X] markers.

import { readFileSync } from "fs";

export interface ManifestoSection {
  id: string;       // e.g. "1.0", "1.1", "2.1"
  kind: "axiom" | "corollary";
  name: string;     // English short name
  body: string;     // English body (paragraphs)
}

// V3.1 format: **§1.0 [Axiom] Life Dwells in Context**
const HEADER_RE = /§(\d+\.\d+)\s+\[(Axiom|Corollary)\]\s+([^\n*]+?)(?:\*\*|\n)/g;

export function parseManifesto(source: string): ManifestoSection[] {
  // Find each English header position. Body extends from end-of-header to the
  // next English header OR to the next horizontal rule (`---`) OR end of doc.
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
  try {
    const raw = readFileSync(path, "utf-8");
    return parseManifesto(raw);
  } catch (err) {
    console.warn(`[host] failed to load manifesto from ${path}:`, err);
    return [];
  }
}
