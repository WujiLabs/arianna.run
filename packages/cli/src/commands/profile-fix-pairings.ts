// `arianna profile fix-pairings <name>` — operator-runnable rescue command
// that reconstructs missing snapshot-history pairing files for any docker-
// image-extant snapshot of the named profile.
//
// Why this exists: pairing files live at
//   workspace/profiles/<name>/sidecar-state/snapshot-histories/<id>.json
// and the daemon's /restore gate (snapshotPairingExists → sidecar
// /snapshot-exists) refuses to retag a snapshot's image as `:current` unless
// the file exists. For snapshots whose pairing got wiped (the snapshot-
// pairing-loss bug fixed in parallel with this command — sidecar cleanup
// previously classified snap_overlay_* tags as orphans), the only path to
// restore is recreating the JSON.
//
// Source of truth (per eng-review-locked decision c, 2026-05-11): docker
// image enumeration. Asks the daemon's GET /snapshot-images endpoint which
// scans `docker images --filter reference=ariannarun-vessel{-profile}:*`,
// parses snapshot tags, and returns `{ ids, details }` records carrying
// snapshotId + sessionId. We then write
//   { "snapshotId": "<id>", "sessionId": "<sid>" }
// for every record whose pairing file is missing. Idempotent — pre-existing
// pairings are left alone, including those whose stored sessionId disagrees
// with the docker tag (no overwrite — the operator likely chose that on
// purpose, e.g. arianna fork's sessionId-rewrite step).

import {
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { profileSessionConfigPath, type PathOpts } from "../paths.js";
import { DEFAULT_DAEMON_URL_FOR_CLI } from "../compose-up.js";

export class ProfileFixPairingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileFixPairingsError";
  }
}

export interface ProfileFixPairingsArgs {
  name: string;
  /** When true, prints what would change without writing files. */
  dryRun: boolean;
}

export interface ProfileFixPairingsDeps extends PathOpts {
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /**
   * fetch implementation. Production wires globalThis.fetch; tests inject a
   * recording fake that returns a fixed Response.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Daemon URL base (no trailing slash). Defaults to
   * process.env.ARIANNA_DAEMON_URL ?? DEFAULT_DAEMON_URL_FOR_CLI.
   */
  daemonUrl?: string;
}

interface SnapshotImageRecord {
  snapshotId: string;
  sessionId: string;
  /** Optional — included by the daemon but not required by this command. */
  repo?: string;
  tag?: string;
}

interface SnapshotImagesResponse {
  ids: string[];
  details: SnapshotImageRecord[];
}

interface PairingOutcome {
  snapshotId: string;
  sessionId: string;
  status: "created" | "already-present" | "would-create";
  path: string;
}

export async function runProfileFixPairings(
  args: ProfileFixPairingsArgs,
  deps: ProfileFixPairingsDeps,
): Promise<number> {
  const { name } = args;
  // Verify the profile workspace exists. fix-pairings against a non-existent
  // profile is operator-error territory; surfacing it clearly here beats
  // silently writing pairings to a profile dir that won't be read by anyone.
  const sessionConfigPath = profileSessionConfigPath(name, deps);
  if (!existsSync(sessionConfigPath)) {
    throw new ProfileFixPairingsError(
      `session_config.json not found at ${sessionConfigPath}. ` +
        `Profile may not be initialized. Run \`arianna profile list\` to ` +
        `confirm the profile name.`,
    );
  }

  const histDir = join(
    dirname(sessionConfigPath),
    "sidecar-state",
    "snapshot-histories",
  );

  // Fetch docker-image-derived snapshot list from the daemon. We do NOT fall
  // back to a local `docker images` shell-out: the CLI may be running inside
  // an openclaw container without docker on PATH, and the daemon is the
  // authoritative cross-environment view anyway. If the daemon is
  // unreachable, fail loud with a specific instruction.
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const daemonUrl = (
    deps.daemonUrl ??
    deps.env?.ARIANNA_DAEMON_URL ??
    process.env.ARIANNA_DAEMON_URL ??
    DEFAULT_DAEMON_URL_FOR_CLI
  ).replace(/\/$/, "");
  const url = `${daemonUrl}/snapshot-images?profile=${encodeURIComponent(name)}`;

  let body: SnapshotImagesResponse;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProfileFixPairingsError(
        `daemon ${url} returned ${res.status}${text ? ": " + text.slice(0, 200) : ""}`,
      );
    }
    body = (await res.json()) as SnapshotImagesResponse;
  } catch (err) {
    if (err instanceof ProfileFixPairingsError) throw err;
    throw new ProfileFixPairingsError(
      `failed to fetch ${url}: ${(err as Error).message}. ` +
        `Is the daemon running? \`arianna daemon status\` to check.`,
    );
  }
  const records = Array.isArray(body.details) ? body.details : [];
  if (records.length === 0) {
    deps.write(
      `No snapshot images found for profile "${name}". Nothing to pair.\n`,
    );
    return 0;
  }

  // Only mkdir the histories dir if we'll actually write something. dry-run
  // shouldn't touch disk at all.
  let dirReady = false;
  const outcomes: PairingOutcome[] = [];
  for (const rec of records) {
    if (!rec.snapshotId || typeof rec.snapshotId !== "string") continue;
    if (!rec.sessionId || typeof rec.sessionId !== "string") continue;
    const pairingPath = join(histDir, `${rec.snapshotId}.json`);
    if (existsSync(pairingPath)) {
      outcomes.push({
        snapshotId: rec.snapshotId,
        sessionId: rec.sessionId,
        status: "already-present",
        path: pairingPath,
      });
      continue;
    }
    if (args.dryRun) {
      outcomes.push({
        snapshotId: rec.snapshotId,
        sessionId: rec.sessionId,
        status: "would-create",
        path: pairingPath,
      });
      continue;
    }
    if (!dirReady) {
      mkdirSync(histDir, { recursive: true });
      dirReady = true;
    }
    // Atomic write (tmp + rename) mirrors writeSnapshotPairingAtomic in
    // packages/sidecar/src/index.ts. A torn write would leave behind an
    // unparseable file that snapshotPairingExists still accepts (it's
    // filename-only) but that `arianna fork`'s copySnapshotHistories
    // sessionId-rewrite step crashes on when it tries to JSON.parse.
    const tmp = `${pairingPath}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ snapshotId: rec.snapshotId, sessionId: rec.sessionId }),
    );
    renameSync(tmp, pairingPath);
    outcomes.push({
      snapshotId: rec.snapshotId,
      sessionId: rec.sessionId,
      status: "created",
      path: pairingPath,
    });
  }

  let created = 0;
  let alreadyPresent = 0;
  let wouldCreate = 0;
  for (const o of outcomes) {
    if (o.status === "created") created++;
    else if (o.status === "already-present") alreadyPresent++;
    else wouldCreate++;
  }

  // One-line-per-action log first, then a summary. Matches `profile fix`
  // voice so operators reading both don't context-switch.
  for (const o of outcomes) {
    const verb =
      o.status === "created"
        ? "created"
        : o.status === "would-create"
          ? "WOULD CREATE"
          : "ok";
    deps.write(`  ${verb.padEnd(12)} ${o.snapshotId} -> ${o.path}\n`);
  }
  const total = outcomes.length;
  if (args.dryRun) {
    deps.write(
      `\n${total} snapshot${total === 1 ? "" : "s"} inspected: ` +
        `${wouldCreate} would create, ${alreadyPresent} already paired.\n`,
    );
  } else {
    deps.write(
      `\n${total} snapshot${total === 1 ? "" : "s"} inspected: ` +
        `${created} pairings written, ${alreadyPresent} already present.\n`,
    );
  }
  return 0;
}

