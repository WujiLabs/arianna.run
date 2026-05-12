// Daemon-side prelude write for `/compose-up`. Closes the openclaw container
// blocker (validation aea28db5, 2026-05-09): the CLI's local prelude-write
// path resolves `imported-messages.jsonl` through `resolveRepoRoot`, which
// inside an openclaw container walks up cwd and finds openclaw's own
// docker-compose.yml. The prelude lands at a path the host daemon never
// reads, so vessel boots blank and the AI wakes as a generic stock assistant
// instead of a vessel partner.
//
// The daemon already has authoritative access to the host's profile workspace
// (via ctx.sessionConfigPath which sits next to imported-messages.jsonl), so
// folding the prelude write into /compose-up makes the daemon route a single
// atomic step from the CLI's POV: one POST → containers up + prelude written.
//
// Mirrors the CLI's runBootstrap rules for the local route:
//   - skip if imported-messages.jsonl already exists (don't clobber a
//     `profile import` seed, a previous prelude write, or an explicit
//     `--seed-from-jsonl` carry-in)
//   - skip + warn if session_config.json is missing / has no aiName
//   - otherwise write a single AgentMessage carrying the canonical prelude
//
// Returns { written, skipReason } so the daemon's response body can surface
// what happened without the operator needing to grep the daemon log. Skip
// reasons are short stable tokens — the CLI maps them to operator-facing
// messages.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildFiloPreludeAgentMessage } from "@arianna.run/cli/filo-prelude";

export type PreludeSkipReason =
  | "writePrelude=false"
  | "imported-messages-exists"
  | "session-config-missing"
  | "ai-name-missing"
  | "write-failed";

export interface PreludeWriteResult {
  written: boolean;
  skipReason?: PreludeSkipReason;
}

/**
 * Resolve the canonical `imported-messages.jsonl` path for a profile from the
 * already-resolved `session_config.json` path. Both files live in the same
 * directory regardless of legacy/profile-aware split.
 */
export function importedMessagesPathFromSessionConfig(
  sessionConfigPath: string,
): string {
  return join(dirname(sessionConfigPath), "imported-messages.jsonl");
}

/**
 * Read & parse the `imported-messages.jsonl` file for a profile. Returns an
 * empty array if the file is missing — matches the CLI's
 * `readJsonlMessages` tolerance: blank lines and unparseable lines are
 * silently skipped so a partially-corrupt seed doesn't block bootstrap.
 *
 * Used by `/compose-up` to forward the seed to vessel `/bootstrap` after a
 * fresh container bring-up. Closes the openclaw container blocker: the CLI's
 * `ensureBootstrapped` reads this file from ITS OWN filesystem (not the host),
 * which inside an openclaw container is the wrong path. The daemon owns the
 * authoritative copy and forwards on the CLI's behalf.
 */
export function readImportedMessagesFromDisk(sessionConfigPath: string): unknown[] {
  const path = importedMessagesPathFromSessionConfig(sessionConfigPath);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export interface PreludeWriteContext {
  /** Where the profile's session_config.json lives on the host filesystem. */
  sessionConfigPath: string;
  /**
   * Compose project name, used for log messages only. Pass null/undefined
   * for legacy single-tenant flow; we'll fall back to "arianna".
   */
  projectName?: string | null;
}

export interface MaybeWritePreludeOptions {
  /**
   * Test seam — sink for the warning lines the function would otherwise
   * emit via `console.warn`. Production callers leave this undefined and
   * warnings go to the daemon log. Keeping warnings in test scope means we
   * don't pollute the test runner output.
   */
  warn?: (line: string) => void;
}

/**
 * Pure(ish) helper — does filesystem I/O but is fully deterministic given
 * its inputs. Unit-testable without spinning up a real daemon process.
 */
export function maybeWritePreludeForCompose(
  ctx: PreludeWriteContext,
  options: MaybeWritePreludeOptions = {},
): PreludeWriteResult {
  const projectName = ctx.projectName ?? "arianna";
  const warn = options.warn ?? ((line) => console.warn(line));

  // imported-messages.jsonl sits in the same dir as session_config.json.
  // For legacy single-tenant: workspace/imported-messages.jsonl
  // For named profiles:      workspace/profiles/<name>/imported-messages.jsonl
  const importedMessagesPath = join(
    dirname(ctx.sessionConfigPath),
    "imported-messages.jsonl",
  );

  if (existsSync(importedMessagesPath)) {
    return { written: false, skipReason: "imported-messages-exists" };
  }

  if (!existsSync(ctx.sessionConfigPath)) {
    warn(
      `[daemon] /compose-up: prelude skipped — no session_config.json at ${ctx.sessionConfigPath} (project ${projectName}).`,
    );
    return { written: false, skipReason: "session-config-missing" };
  }

  let aiName: string | null = null;
  try {
    const raw = readFileSync(ctx.sessionConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as { aiName?: unknown };
    if (typeof parsed.aiName === "string" && parsed.aiName.length > 0) {
      aiName = parsed.aiName;
    }
  } catch {
    // Fall through — treat malformed file as missing aiName.
  }
  if (!aiName) {
    warn(
      `[daemon] /compose-up: prelude skipped — no aiName in ${ctx.sessionConfigPath} (project ${projectName}).`,
    );
    return { written: false, skipReason: "ai-name-missing" };
  }

  try {
    const preludeMsg = buildFiloPreludeAgentMessage(aiName);
    mkdirSync(dirname(importedMessagesPath), { recursive: true });
    writeFileSync(importedMessagesPath, JSON.stringify(preludeMsg) + "\n");
    return { written: true };
  } catch (writeErr) {
    warn(
      `[daemon] /compose-up: prelude write failed for project ${projectName}: ${(writeErr as Error).message}`,
    );
    return { written: false, skipReason: "write-failed" };
  }
}
