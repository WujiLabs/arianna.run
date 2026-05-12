// `arianna profile fix [name]` — defense-in-depth backfill for existing
// profiles. Re-runs `renderComposeOverride` (the canonical generator) over
// each existing profile's compose.override.yml so they pick up additions
// the generator has gained over time:
//
//   - ARIANNA_PROFILE env on the sidecar (Bug 6, Sael revival 2026-05-09):
//     pre-fix, existing overrides lacked this env, so their sidecars
//     defaulted to `ARIANNA_PROFILE=default` and silently leaked
//     `?profile=default` queries on every daemon URL → cross-profile
//     diff/snapshot/sessions data.
//
//   - vessel.volumes block mounting per-profile session_config.json
//     (Bug 1 #2 followup, commit d86364d): pre-fix, the vessel resolved
//     sessionId from the legacy single-tenant file regardless of which
//     profile it belonged to → snapshots tagged with the wrong sessionId.
//
//   - vessel.build.args.AI_USERNAME (2026-05-10, Mirin r2 + Pax):
//     pre-fix, an operator-direct `docker compose build vessel` against a
//     per-profile override fell back to the Dockerfile's ARG default
//     (`vessel`), so the rebuilt image had /home/vessel/ instead of
//     /home/<aiUsername>/ — embodiment broken. Backfill reads aiUsername
//     from the profile's session_config.json (skipped silently when the
//     file is missing or lacks the field) and emits the build-arg block.
//
//   - vessel.image per-profile namespace (2026-05-10, Lume re-test):
//     pre-fix, the override left vessel.image to the base file, so every
//     profile's `docker compose ... build vessel` tagged into the shared
//     `ariannarun-vessel:latest`. Two profiles built back-to-back =
//     second profile's identity overwrites first → concurrent rebuilds
//     stomp. Backfill emits `image: ariannarun-vessel-{profile}:latest`
//     so each profile's rebuild lands in its own Docker image repo.
//
// Idempotent by construction: the file is fully regenerated from the
// authoritative inputs (profile name + portOffset from ~/.arianna/config),
// so running it twice produces byte-equal output. Pre-existing manual
// edits to compose.override.yml will be overwritten — that's the point of
// "this file is generated, do not hand-edit" comment in the override
// itself.
//
// Default behavior is to backfill all known profiles. Pass a profile name
// to fix only that one. Always prints a per-profile diff summary
// (changed / unchanged / would-create-missing).

import { existsSync, readFileSync } from "node:fs";

import { loadConfig } from "../arianna-config.js";
import {
  renderComposeOverride,
  writeComposeOverride,
} from "../compose-override.js";
import {
  profileOverridePath,
  profileSessionConfigPath,
  type PathOpts,
} from "../paths.js";
import { assertValidProfileName } from "../profile.js";

/**
 * Best-effort read of `aiUsername` from a profile's session_config.json.
 * Returns undefined when the file is missing, malformed, or doesn't carry
 * an aiUsername field (e.g. profiles created via `arianna profile create
 * <name>` without `--ai-name` and never followed up with a TUI lobby pass).
 *
 * Surfaced 2026-05-10 (Mirin r2 + Pax): operator-direct `docker compose
 * build vessel` against a per-profile override loses the AI's identity if
 * the override doesn't carry the AI_USERNAME build-arg. This helper feeds
 * the renderer with the right value at backfill time so the rebuild
 * preserves /home/<aiUsername>/.
 */
function readAiUsernameFromSessionConfig(
  name: string,
  deps: PathOpts,
): string | undefined {
  const path = profileSessionConfigPath(name, deps);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { aiUsername?: unknown };
    if (typeof parsed.aiUsername === "string" && parsed.aiUsername.length > 0) {
      return parsed.aiUsername;
    }
    return undefined;
  } catch {
    // Malformed JSON shouldn't block backfilling everything else — the user
    // can re-run `arianna profile fix` after fixing the config file.
    return undefined;
  }
}

export class ProfileFixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileFixError";
  }
}

export interface ProfileFixDeps extends PathOpts {
  /** stdout. */
  write: (line: string) => void;
}

export interface ProfileFixArgs {
  /**
   * Optional profile name. When undefined, fixes every profile in
   * ~/.arianna/config. When provided, the name is regex-validated by the
   * argv parser before reaching this point.
   */
  name?: string;
  /**
   * When true, only print what would change without rewriting any files.
   * Useful to preview in CI / scripts before mutating disk.
   */
  dryRun?: boolean;
}

interface FixOutcome {
  profile: string;
  status: "updated" | "unchanged" | "missing";
  /** Path to the override file (for log lines). */
  path: string;
}

export async function runProfileFix(
  args: ProfileFixArgs,
  deps: ProfileFixDeps,
): Promise<number> {
  const cfg = loadConfig(deps);

  let targets: { name: string; portOffset: number }[];
  if (args.name !== undefined) {
    // Defense-in-depth: argv parser validates, but a programmatic caller
    // could bypass it. Re-assert.
    assertValidProfileName(args.name);
    const entry = cfg.profiles.get(args.name);
    if (!entry) {
      throw new ProfileFixError(
        `Profile "${args.name}" is not in ~/.arianna/config. ` +
          `Run \`arianna profile list\` to see configured profiles.`,
      );
    }
    targets = [{ name: args.name, portOffset: entry.portOffset }];
  } else {
    if (cfg.profiles.size === 0) {
      deps.write("(no profiles configured)\n");
      return 0;
    }
    targets = [...cfg.profiles].map(([name, entry]) => ({
      name,
      portOffset: entry.portOffset,
    }));
  }

  const outcomes: FixOutcome[] = [];

  for (const { name, portOffset } of targets) {
    const path = profileOverridePath(name, deps);
    const aiUsername = readAiUsernameFromSessionConfig(name, deps);
    const inputs = { profile: name, portOffset, aiUsername };
    const fresh = renderComposeOverride(inputs);

    if (!existsSync(path)) {
      // Profile is in ~/.arianna/config but its directory has no
      // compose.override.yml — this is anomalous but recoverable. Treat as
      // "would create" in dry-run, "create" otherwise. The directory itself
      // must already exist; we don't recreate the profile's working dir.
      if (args.dryRun) {
        outcomes.push({ profile: name, status: "missing", path });
        continue;
      }
      writeComposeOverride(path, inputs);
      outcomes.push({ profile: name, status: "updated", path });
      continue;
    }

    const current = readFileSync(path, "utf-8");
    if (current === fresh) {
      outcomes.push({ profile: name, status: "unchanged", path });
      continue;
    }

    if (args.dryRun) {
      outcomes.push({ profile: name, status: "updated", path });
      continue;
    }
    writeComposeOverride(path, inputs);
    outcomes.push({ profile: name, status: "updated", path });
  }

  // Summary: one line per profile, mirroring the `profile list` voice.
  let changed = 0;
  let unchanged = 0;
  let missing = 0;
  for (const o of outcomes) {
    const verb =
      o.status === "updated"
        ? args.dryRun
          ? "WOULD UPDATE"
          : "updated"
        : o.status === "unchanged"
          ? "ok"
          : args.dryRun
            ? "WOULD CREATE"
            : "created";
    deps.write(`  ${verb.padEnd(12)} ${o.profile} (${o.path})\n`);
    if (o.status === "updated") changed++;
    else if (o.status === "unchanged") unchanged++;
    else missing++;
  }

  const total = outcomes.length;
  if (args.dryRun) {
    deps.write(
      `\n${total} profile${total === 1 ? "" : "s"} checked: ` +
        `${changed} would change, ${unchanged} already current, ` +
        `${missing} missing override file (would create).\n`,
    );
  } else {
    deps.write(
      `\n${total} profile${total === 1 ? "" : "s"} checked: ` +
        `${changed} updated, ${unchanged} already current.\n`,
    );
    if (changed > 0) {
      deps.write(
        `\nNote: existing containers keep their old compose env until ` +
          `\`docker compose up\` is rerun. Restart at your convenience.\n`,
      );
    }
  }
  return 0;
}
