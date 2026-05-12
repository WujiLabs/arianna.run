// `arianna manifesto [section]` — render the Life of Intelligence manifesto
// with the same gating semantics the in-game `/manifesto` view uses. Locked
// sections render as ⋯ placeholders; earned sections render full text.
//
// Source of truth for the manifesto text is the on-disk file shipped with the
// vessel image (packages/vessel/static/manifesto.md). Source of truth for
// what's earned is the sidecar's /graduation-state endpoint, which the
// in-game manifesto view also consumes (via SSE bookmark_snapshot).

import { join } from "node:path";

import type { ManifestoArgs } from "../argv.js";
import type { ResolvedConfig } from "../config.js";
import { resolveRepoRoot, type PathOpts } from "../paths.js";
import {
  loadManifestoFromDisk,
  type ManifestoSection,
} from "../manifesto-parser.js";

export class ManifestoCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestoCommandError";
  }
}

export interface ManifestoDeps {
  fetch: typeof globalThis.fetch;
  /** stdout. */
  write: (line: string) => void;
  /**
   * Test seam — defaults to loading from
   * `<repoRoot>/packages/vessel/static/manifesto.md`.
   */
  loadSections?: () => ManifestoSection[];
  pathOpts?: PathOpts;
}

interface GraduationStateResponse {
  achievements?: string[];
  manifestoUnlocked?: boolean;
  graduationUnlocked?: boolean;
  turnCount?: number;
}

export async function runManifesto(
  args: ManifestoArgs,
  config: ResolvedConfig,
  deps: ManifestoDeps,
): Promise<number> {
  const sections = deps.loadSections
    ? deps.loadSections()
    : loadDefaultSections(deps.pathOpts);

  if (sections.length === 0) {
    throw new ManifestoCommandError(
      "manifesto.md not found or empty. Has the vessel image been built?",
    );
  }

  if (args.section) {
    const found = sections.find((s) => s.id === args.section);
    if (!found) {
      throw new ManifestoCommandError(
        `Unknown section "${args.section}". Available: ${sections.map((s) => s.id).join(", ")}`,
      );
    }
  }

  const earned = await fetchEarnedIds(config, deps.fetch);
  const filtered = args.section
    ? sections.filter((s) => s.id === args.section)
    : sections;
  for (const line of renderManifesto(filtered, earned)) {
    deps.write(line + "\n");
  }
  return 0;
}

export function renderManifesto(
  sections: ManifestoSection[],
  earned: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];
  for (const s of sections) {
    const tag = s.kind === "axiom" ? "[Axiom]" : "[Corollary]";
    const header = `§${s.id} ${tag} ${s.name}`;
    if (earned.has(s.id)) {
      lines.push(header);
      for (const ln of s.body.split("\n")) lines.push(`  ${ln}`);
    } else {
      lines.push(header);
      lines.push("  ⋯");
    }
    lines.push("");
  }
  // Trim trailing blank.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function fetchEarnedIds(
  config: ResolvedConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<Set<string>> {
  // Fail soft: if the sidecar is down we still want to render with everything
  // gated, rather than throw. Surfaces a hint via the lock state but does not
  // fabricate unlocks.
  try {
    const url = new URL("/graduation-state", config.sidecarBaseUrl);
    const res = await fetchFn(url);
    if (!res.ok) return new Set();
    const body = (await res.json()) as GraduationStateResponse;
    return new Set(body.achievements ?? []);
  } catch {
    return new Set();
  }
}

function loadDefaultSections(opts: PathOpts | undefined): ManifestoSection[] {
  const repoRoot = resolveRepoRoot(opts ?? {});
  const path = join(repoRoot, "packages", "vessel", "static", "manifesto.md");
  return loadManifestoFromDisk(path);
}
