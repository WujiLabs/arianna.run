import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { assertValidProfileName } from "../profile.js";
import { loadConfig, saveConfig } from "../arianna-config.js";
import { profileDir, profileOverridePath } from "../paths.js";
import {
  allocateOffset,
  withPortLock,
  type AllocateOpts,
} from "../port-allocator.js";
import { writeComposeOverride } from "../compose-override.js";
import {
  SAFE_SESSION_ID_RE,
  assertNoDstTags,
  copySessionStateFile,
  copySnapshotHistories,
  retagDockerImages,
  type CloneExecFn,
} from "./_profile-clone-helpers.js";

// Re-export for tests + downstream consumers that imported these from
// fork.ts before the helpers extraction.
export { VESSEL_REPO } from "./_profile-clone-helpers.js";

export interface ForkArgs {
  src: string;
  dst: string;
}

export interface ForkExecResult {
  stdout: string;
  stderr: string;
}

export interface ForkDeps extends AllocateOpts {
  /**
   * Run a shell command. Production wires this to promisify(exec) from
   * node:child_process; tests pass a fake that records calls and returns
   * canned output.
   */
  exec: CloneExecFn;
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /** Source of fresh dst-sessionId timestamps. Default: Date.now. */
  now?: () => number;
}

export class ForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkError";
  }
}

/**
 * Full clone of a profile per the eng-review-locked decision (#38).
 *
 * Never mutates the source: docker tags are added (never removed), source
 * files are read but not modified, and `~/.arianna/config` only gains a new
 * dst entry. Source and dst diverge from the moment fork returns.
 *
 * Order of operations is chosen so a partial failure leaves the worktree in
 * a recoverable state: docker retag happens before any filesystem writes
 * specific to dst, then state files, then session_config, then port
 * allocation, then compose override, then config registration. If anything
 * before the final saveConfig fails, the dst profile dir may exist but no
 * registry entry is written — the user can `rm -rf
 * workspace/profiles/{dst}` and re-run.
 */
export async function runFork(args: ForkArgs, deps: ForkDeps): Promise<number> {
  // Defensive validation — argv parser already enforced regex but forkers
  // may invoke runFork programmatically.
  assertValidProfileName(args.src);
  assertValidProfileName(args.dst);
  if (args.src === args.dst) {
    throw new ForkError("Source and destination profile names must differ.");
  }

  const cfg = loadConfig(deps);
  if (!cfg.profiles.has(args.src)) {
    throw new ForkError(
      `Source profile "${args.src}" not in ~/.arianna/config. Run \`arianna profile list\` to see configured profiles.`,
    );
  }
  if (cfg.profiles.has(args.dst)) {
    throw new ForkError(
      `Destination profile "${args.dst}" already exists. Pick another name or delete the existing profile first.`,
    );
  }

  const srcDir = profileDir(args.src, deps);
  const dstDir = profileDir(args.dst, deps);

  // Validate the source side BEFORE we touch the filesystem. A failure here
  // (missing session_config, bad JSON, unsafe sessionId) shouldn't leave an
  // orphaned dst directory blocking retry of the same name.
  const srcSessionConfigPath = join(srcDir, "session_config.json");
  if (!existsSync(srcSessionConfigPath)) {
    throw new ForkError(
      `Source profile "${args.src}" has no session_config.json (path: ${srcSessionConfigPath}). Nothing to fork.`,
    );
  }

  const srcConfigRaw = readFileSync(srcSessionConfigPath, "utf-8");
  let srcConfig: Record<string, unknown>;
  try {
    srcConfig = JSON.parse(srcConfigRaw) as Record<string, unknown>;
  } catch (err) {
    throw new ForkError(
      `Source session_config.json is not valid JSON (${(err as Error).message}).`,
    );
  }

  const srcSessionId = srcConfig.sessionId;
  if (typeof srcSessionId !== "string" || srcSessionId.length === 0) {
    throw new ForkError(
      `Source session_config.json is missing a sessionId — cannot determine which docker tags to retag.`,
    );
  }
  if (!SAFE_SESSION_ID_RE.test(srcSessionId)) {
    throw new ForkError(
      `Source sessionId "${srcSessionId}" contains characters that aren't safe to interpolate into a docker command. Expected ${SAFE_SESSION_ID_RE.source}.`,
    );
  }

  // Atomically claim the dst directory. mkdirSync(recursive:false) fails
  // with EEXIST if the directory is already there — a stronger guarantee
  // than a separate existsSync + mkdir would give, since two concurrent
  // forks could both pass the existsSync check before either had written.
  // We claim AFTER source validation so that a failed validate doesn't
  // leave an orphaned dst dir blocking retry of the same name. From here
  // forward the cleanup helper deletes dstDir on any thrown failure.
  mkdirSync(dirname(dstDir), { recursive: true });
  try {
    mkdirSync(dstDir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ForkError(
        `Destination directory ${dstDir} already exists. Either a previous fork left it behind, another \`arianna fork\` / \`profile create\` is racing us, or you picked a name that's already in use. Remove the directory manually or pick another name.`,
      );
    }
    throw err;
  }

  // From here forward we own dstDir. Any thrown error past this point should
  // remove the empty/partial directory so a re-run with the same dst name
  // can proceed without manual cleanup.
  try {
    // Mint a fresh dst sessionId. Date.now is deterministic in tests via
    // deps.now.
    const now = (deps.now ?? Date.now)();
    const dstSessionId = `session_${now}`;
    if (dstSessionId === srcSessionId) {
      throw new ForkError(
        `Generated dst sessionId collides with src (${srcSessionId}). Re-run fork.`,
      );
    }

    // Idempotency: if any docker tags already exist for dst sessionId,
    // refuse. Catches retry after a failure post-retag with the same minted
    // timestamp.
    try {
      await assertNoDstTags(dstSessionId, deps.exec);
    } catch (err) {
      throw new ForkError((err as Error).message + " Re-run fork to mint a different timestamp.");
    }

    // List src tags + retag.
    let retagged: number;
    try {
      const r = await retagDockerImages(srcSessionId, dstSessionId, deps.exec);
      retagged = r.retagged;
    } catch (err) {
      throw new ForkError((err as Error).message);
    }

    // Copy session state file (filename rename, content unchanged).
    const srcSessionsDir = join(srcDir, "sidecar-state", "sessions");
    const dstSessionsDir = join(dstDir, "sidecar-state", "sessions");
    const sessionFileCopied = copySessionStateFile(
      srcSessionsDir,
      dstSessionsDir,
      srcSessionId,
      dstSessionId,
    );

    // Copy snapshot histories with sessionId rewrite.
    const srcHistDir = join(srcDir, "sidecar-state", "snapshot-histories");
    const dstHistDir = join(dstDir, "sidecar-state", "snapshot-histories");
    const historiesCopied = copySnapshotHistories(
      srcHistDir,
      dstHistDir,
      srcSessionId,
      dstSessionId,
    );

    // Write dst session_config.json. Spread src then override sessionId +
    // createdAt so newer fields the sidecar picks up (e.g. cadence, plumbed
    // through later in the sprint) flow forward without code changes here.
    const dstConfig = {
      ...srcConfig,
      sessionId: dstSessionId,
      createdAt: now,
    };
    writeFileSync(
      join(dstDir, "session_config.json"),
      JSON.stringify(dstConfig, null, 2),
    );

    // Allocate a fresh port offset for dst. Held under the flock used by
    // `arianna profile create` so two concurrent fork/create invocations
    // can't pick the same offset.
    const offset = await withPortLock(() => allocateOffset(deps), deps);

    writeComposeOverride(profileOverridePath(args.dst, deps), {
      profile: args.dst,
      portOffset: offset,
      // Carry the source's aiUsername forward so the dst override embeds the
      // AI_USERNAME build-arg from t=0. Forks share identity with their src
      // (same AI, new sessionId), so the same /home/<aiUsername>/ layout
      // applies. Best-effort: if srcConfig somehow lacks the field (legacy
      // pre-aiUsername imports), fall through to undefined and rely on
      // `arianna profile fix` once it's populated.
      aiUsername:
        typeof srcConfig.aiUsername === "string" && srcConfig.aiUsername.length > 0
          ? srcConfig.aiUsername
          : undefined,
    });

    cfg.profiles.set(args.dst, { portOffset: offset, createdAt: now });
    saveConfig(cfg, deps);

    deps.write(`Forked "${args.src}" → "${args.dst}":\n`);
    deps.write(`  src sessionId:  ${srcSessionId}\n`);
    deps.write(`  dst sessionId:  ${dstSessionId}\n`);
    deps.write(
      `  retagged ${retagged} docker images, copied ${historiesCopied} snapshot histor${historiesCopied === 1 ? "y" : "ies"}` +
        `${sessionFileCopied ? " + 1 session state file" : ""}\n`,
    );
    deps.write(
      `  port_offset: ${offset} (vessel:${3000 + offset} sidecar:${8000 + offset} daemon:9000 [shared])\n`,
    );
    return 0;
  } catch (err) {
    // Roll back the dst directory we claimed at the top of runFork. We
    // intentionally do NOT roll back docker tags — `docker tag` is
    // non-destructive on the source, and the idempotency guard at the top
    // of fork rejects a re-run with pre-existing dst tags, so the user
    // either picks a new name or removes the stray tags manually.
    try {
      rmSync(dstDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
}
