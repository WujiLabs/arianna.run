// `arianna profile restore <tarball> [--name <new-name>]`
//
// Inverse of `profile save`. Untar a portable bundle into a fresh profile,
// rebuilding docker images + per-profile workspace state. Refuses if the
// destination name already exists.
//
// Hardening notes:
//   - Tarball entry types are pre-checked with `tar -tvzf`: anything other
//     than a regular file or directory (symlinks, hardlinks, devices, fifos,
//     sockets) is refused before extraction. This prevents the "symlink
//     followed by file-through-symlink" CVE pattern that lets a tarball
//     redirect writes outside the destination dir.
//   - Entry names are pre-checked with `tar -tzf`: absolute paths and any
//     `..` segment are refused.
//   - After extraction, the tree is walked with `lstat` as defense-in-depth.
//     A symlink in the extracted tree (that somehow slipped past the
//     pre-checks) aborts the restore.
//   - Manifest is `version: 1`. Unknown versions are refused so future
//     formats don't get mishandled by older CLIs.
//   - All shell-interpolated values (sessionIds, paths) are either regex-
//     validated or single-quoted.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { PROFILE_NAME_RE, assertValidProfileName } from "../profile.js";
import { loadConfig, saveConfig } from "../arianna-config.js";
import { profileDir, profileOverridePath, type PathOpts } from "../paths.js";
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
import { SAVE_BUNDLE_VERSION, type SaveBundleManifestV1 } from "./profile-save.js";

export class ProfileRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileRestoreError";
  }
}

export interface ProfileRestoreArgs {
  /** Path to the tarball. Resolved against cwd if relative. */
  tarball: string;
  /** Optional dst profile name. Defaults to `<src-name>-restored-<ts>`. */
  name?: string;
}

export interface ProfileRestoreDeps extends AllocateOpts, PathOpts {
  exec: CloneExecFn;
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /** Source of dst-sessionId timestamps. Default: Date.now. */
  now?: () => number;
  /** Test seam — current working directory for resolving tarball path. */
  cwd?: string;
  /** Test seam — temp dir base. Default: os.tmpdir(). */
  tmpDir?: string;
}

export async function runProfileRestore(
  args: ProfileRestoreArgs,
  deps: ProfileRestoreDeps,
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const tarballPath = resolveTarball(args.tarball, cwd);

  // Stage in a temp dir. Layout after extraction:
  //   stage/
  //     manifest.json
  //     docker-images.tar
  //     profile/...
  const tmpBase = deps.tmpDir ?? tmpdir();
  const stage = mkdtempSync(join(tmpBase, "arianna-restore-"));
  try {
    // 1. Pre-extract checks: refuse non-regular entry types, absolute paths,
    //    `..` segments. Two `tar -t` passes — verbose for type, plain for
    //    names. Cheaper than extracting and rolling back, and prevents the
    //    symlink-redirection class of attack.
    await preflightTarball(tarballPath, deps.exec);

    // 2. Extract.
    await deps.exec(
      `tar -xzf ${shellQuote(tarballPath)} -C ${shellQuote(stage)}`,
    );

    // 3. Defense-in-depth: walk the extracted tree, reject any symlink we
    //    might have missed, verify realpath stays inside stage.
    verifyExtractedTree(stage);

    // 4. Read + validate manifest.
    const manifestPath = join(stage, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new ProfileRestoreError(
        `Tarball is missing manifest.json — not an arianna profile bundle.`,
      );
    }
    const manifest = parseAndValidateManifest(
      readFileSync(manifestPath, "utf-8"),
    );

    // 5. Verify the bundle's two other expected files are present.
    const dockerImagesPath = join(stage, "docker-images.tar");
    if (!existsSync(dockerImagesPath)) {
      throw new ProfileRestoreError(
        `Tarball is missing docker-images.tar — bundle is incomplete.`,
      );
    }
    const profileStageDir = join(stage, "profile");
    if (!existsSync(profileStageDir) || !lstatSync(profileStageDir).isDirectory()) {
      throw new ProfileRestoreError(
        `Tarball is missing the profile/ subdirectory — bundle is incomplete.`,
      );
    }

    // 6. Resolve dst name + validate manifest sessionId. User-provided
    //    (--name) is validated against the profile-name regex; otherwise
    //    auto-generated from src + timestamp.
    const now = (deps.now ?? Date.now)();
    const dstName = resolveDstName(args.name, manifest.profile.name, now);

    const srcSessionId = manifest.profile.sessionId;
    if (!SAFE_SESSION_ID_RE.test(srcSessionId)) {
      throw new ProfileRestoreError(
        `Manifest sessionId "${srcSessionId}" contains characters that aren't safe to interpolate into a docker command. Bundle is corrupt or malicious.`,
      );
    }
    const dstSessionId = `session_${now}`;
    if (dstSessionId === srcSessionId) {
      throw new ProfileRestoreError(
        `Generated dst sessionId collides with src (${srcSessionId}). Re-run restore.`,
      );
    }

    const cfg = loadConfig(deps);
    if (cfg.profiles.has(dstName)) {
      throw new ProfileRestoreError(
        `Destination profile "${dstName}" already exists. ` +
          `Pass --name <new-name> with a fresh name, or delete the existing profile first.`,
      );
    }

    // 7. Atomically claim dst dir BEFORE any docker work. Same pattern as
    //    fork.ts — mkdir(recursive:false) is the EEXIST race guard. If two
    //    concurrent restores race, only one wins the mkdir; the loser
    //    refuses early without `docker load`-ing or retagging anything.
    const dstDir = profileDir(dstName, deps);
    mkdirSync(dirname(dstDir), { recursive: true });
    try {
      mkdirSync(dstDir, { recursive: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new ProfileRestoreError(
          `Destination directory ${dstDir} already exists. ` +
            `Either a previous restore left it behind, another ` +
            `\`profile create\`/\`fork\`/\`restore\` is racing us, or you ` +
            `picked a name that's already in use. Remove the directory ` +
            `manually or pass --name <new-name>.`,
        );
      }
      throw err;
    }

    // From here forward we own dstDir. Any thrown error past this point
    // should remove the partial directory so a re-run can proceed without
    // manual cleanup.
    try {
      // 8. Idempotency: refuse if dst sessionId already has tags.
      try {
        await assertNoDstTags(dstSessionId, deps.exec);
      } catch (err) {
        throw new ProfileRestoreError(
          (err as Error).message + " Re-run restore to mint a different timestamp.",
        );
      }

      // 9. `docker load` brings the saved images back with their original
      //    tags. After this, retag from src sessionId namespace into the
      //    fresh dst sessionId namespace.
      await deps.exec(`docker load -i ${shellQuote(dockerImagesPath)}`);

      let retagged: number;
      try {
        const r = await retagDockerImages(srcSessionId, dstSessionId, deps.exec);
        retagged = r.retagged;
      } catch (err) {
        throw new ProfileRestoreError((err as Error).message);
      }

      // 10. Rewrite session_config.json: copy src fields, override sessionId
      //     + createdAt with fresh values.
      const stagedSessionConfigPath = join(profileStageDir, "session_config.json");
      if (!existsSync(stagedSessionConfigPath)) {
        throw new ProfileRestoreError(
          `Bundle's profile/session_config.json is missing — bundle is incomplete.`,
        );
      }
      const stagedConfigRaw = readFileSync(stagedSessionConfigPath, "utf-8");
      let stagedConfig: Record<string, unknown>;
      try {
        stagedConfig = JSON.parse(stagedConfigRaw) as Record<string, unknown>;
      } catch (err) {
        throw new ProfileRestoreError(
          `Bundle's session_config.json is not valid JSON (${(err as Error).message}).`,
        );
      }
      const dstConfig = {
        ...stagedConfig,
        sessionId: dstSessionId,
        createdAt: now,
      };
      writeFileSync(
        join(dstDir, "session_config.json"),
        JSON.stringify(dstConfig, null, 2),
      );

      // 12. Copy session-state file with sessionId rename.
      const stagedSessionsDir = join(
        profileStageDir,
        "sidecar-state",
        "sessions",
      );
      const dstSessionsDir = join(dstDir, "sidecar-state", "sessions");
      const sessionFileCopied = copySessionStateFile(
        stagedSessionsDir,
        dstSessionsDir,
        srcSessionId,
        dstSessionId,
      );

      // 13. Copy snapshot histories with sessionId rewrite.
      const stagedHistDir = join(
        profileStageDir,
        "sidecar-state",
        "snapshot-histories",
      );
      const dstHistDir = join(dstDir, "sidecar-state", "snapshot-histories");
      const historiesCopied = copySnapshotHistories(
        stagedHistDir,
        dstHistDir,
        srcSessionId,
        dstSessionId,
      );

      // 14. Copy snapshots/ dir verbatim if present (JSON metadata only —
      //     the heavy lifting is in docker-images.tar).
      const stagedSnapshotsDir = join(profileStageDir, "snapshots");
      if (existsSync(stagedSnapshotsDir)) {
        cpSync(stagedSnapshotsDir, join(dstDir, "snapshots"), {
          recursive: true,
          dereference: false,
        });
      }

      // 15. Allocate fresh ports + write compose override. The bundled
      //     compose.override.yml is intentionally NOT copied — we regenerate
      //     it with the dst profile name + freshly-allocated offset.
      const portOffset = await withPortLock(
        () => allocateOffset(deps),
        deps,
      );
      // Carry the restored AI's username forward into the override so a
      // future operator-direct `docker compose build vessel` preserves
      // /home/<aiUsername>/ instead of falling back to /home/vessel/
      // (2026-05-10 Mirin r2 + Pax fix). Best-effort: pre-aiUsername
      // archives fall through to undefined and rely on `arianna profile fix`.
      const stagedAiUsername = stagedConfig.aiUsername;
      const restoredAiUsername =
        typeof stagedAiUsername === "string" && stagedAiUsername.length > 0
          ? stagedAiUsername
          : undefined;
      writeComposeOverride(profileOverridePath(dstName, deps), {
        profile: dstName,
        portOffset,
        aiUsername: restoredAiUsername,
      });

      // 16. Register in ~/.arianna/config.
      cfg.profiles.set(dstName, { portOffset, createdAt: now });
      saveConfig(cfg, deps);

      deps.write(`Restored "${manifest.profile.name}" → "${dstName}":\n`);
      deps.write(`  src sessionId: ${srcSessionId}\n`);
      deps.write(`  dst sessionId: ${dstSessionId}\n`);
      deps.write(
        `  loaded + retagged ${retagged} docker image${retagged === 1 ? "" : "s"}, ` +
          `copied ${historiesCopied} snapshot histor${historiesCopied === 1 ? "y" : "ies"}` +
          `${sessionFileCopied ? " + 1 session state file" : ""}\n`,
      );
      deps.write(
        `  port_offset: ${portOffset} (vessel:${3000 + portOffset} sidecar:${8000 + portOffset} daemon:9000 [shared])\n`,
      );
      return 0;
    } catch (err) {
      // Best-effort rollback of the dst dir we claimed. We do NOT roll back
      // the docker tags — `docker load` is non-destructive on existing
      // images, and the idempotency guard rejects a re-run with pre-existing
      // dst tags, so the user picks a fresh --name on retry.
      try {
        rmSync(dstDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      throw err;
    }
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function resolveTarball(raw: string, cwd: string): string {
  if (raw.length === 0) {
    throw new ProfileRestoreError("tarball path must not be empty");
  }
  if (raw.includes("\0")) {
    throw new ProfileRestoreError("tarball path must not contain NUL bytes");
  }
  const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const normalized = resolve(absolute);
  if (!existsSync(normalized)) {
    throw new ProfileRestoreError(`Tarball not found: ${normalized}`);
  }
  // The tarball path is fed to `tar -xzf` and `tar -tvzf` via shellQuote; we
  // also lstat it. Symlinks are tolerated here (the user might have one in
  // their downloads dir) but the underlying target must be a regular file.
  let st;
  try {
    st = lstatSync(normalized);
  } catch (err) {
    throw new ProfileRestoreError(
      `Tarball lstat failed: ${(err as Error).message}`,
    );
  }
  // If symlink, follow it to verify target is a file. We don't refuse
  // symlinks for the input tarball — only for entries inside the tarball.
  if (st.isSymbolicLink()) {
    let real: string;
    try {
      real = realpathSync(normalized);
    } catch (err) {
      throw new ProfileRestoreError(
        `Tarball symlink target unreadable: ${(err as Error).message}`,
      );
    }
    const realSt = lstatSync(real);
    if (!realSt.isFile()) {
      throw new ProfileRestoreError(
        `Tarball symlink target is not a regular file: ${real}`,
      );
    }
    return real;
  }
  if (!st.isFile()) {
    throw new ProfileRestoreError(
      `Tarball path is not a regular file: ${normalized}`,
    );
  }
  return normalized;
}

/**
 * Pre-extract validation. Two passes:
 *   1. `tar -tvzf` — verbose listing. The first character of each line is
 *      the type indicator (`-` regular, `d` dir, `l` symlink, `b/c` device,
 *      `p` fifo, `s` socket, `h` hardlink). Refuse anything other than
 *      `-`/`d`. We don't try to parse names from verbose output (format
 *      varies between BSD and GNU tar) — only the type char, which is
 *      universal.
 *   2. `tar -tzf` — names only, one per line. Refuse absolute paths and any
 *      entry containing a `..` segment.
 */
async function preflightTarball(
  tarballPath: string,
  exec: CloneExecFn,
): Promise<void> {
  // Pass 1: types.
  const verbose = await exec(`tar -tvzf ${shellQuote(tarballPath)}`);
  let lineCount = 0;
  for (const rawLine of verbose.stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    lineCount++;
    const typeChar = line[0];
    // Regular files: `-` (BSD/GNU). Directories: `d`. Anything else is
    // refused. This blocks the symlink-redirection attack class.
    if (typeChar !== "-" && typeChar !== "d") {
      const what =
        typeChar === "l" ? "symlink" :
        typeChar === "h" ? "hardlink" :
        typeChar === "b" || typeChar === "c" ? "device" :
        typeChar === "p" ? "fifo" :
        typeChar === "s" ? "socket" :
        `entry of unknown type "${typeChar}"`;
      throw new ProfileRestoreError(
        `Tarball contains a ${what}; only regular files and directories are allowed in profile bundles. Refusing to extract.`,
      );
    }
  }
  if (lineCount === 0) {
    throw new ProfileRestoreError("Tarball is empty.");
  }

  // Pass 2: names.
  const names = await exec(`tar -tzf ${shellQuote(tarballPath)}`);
  for (const rawLine of names.stdout.split("\n")) {
    const name = rawLine.replace(/\r$/, "");
    if (name.length === 0) continue;
    if (isAbsolute(name) || name.startsWith("/")) {
      throw new ProfileRestoreError(
        `Tarball contains an absolute path "${name}". Refusing to extract.`,
      );
    }
    // Reject any path with a `..` component. `..` alone, `../foo`, `foo/..`,
    // and `foo/../bar` all match.
    const segments = name.split(/[/\\]/);
    if (segments.some((s) => s === "..")) {
      throw new ProfileRestoreError(
        `Tarball contains a parent-traversal path "${name}". Refusing to extract.`,
      );
    }
    // Drive letters / windows-style absolutes (defense-in-depth on cross-
    // platform tarballs).
    if (/^[A-Za-z]:/.test(name)) {
      throw new ProfileRestoreError(
        `Tarball contains a Windows-style absolute path "${name}". Refusing to extract.`,
      );
    }
  }
}

// After extraction, walk the stage tree with lstat. Every node must be a
// regular file or directory (no symlinks anywhere). Defense-in-depth — the
// preflight check should already have caught symlinks.
function verifyExtractedTree(stageDir: string): void {
  const realStage = realpathSync(stageDir);
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        throw new ProfileRestoreError(
          `Extracted tree contains a symlink at ${full}. Refusing to continue.`,
        );
      }
      if (st.isDirectory()) {
        // Realpath-check on directories: belt-and-suspenders against any
        // symlink we somehow missed.
        const real = realpathSync(full);
        if (real !== realStage && !real.startsWith(realStage + sep)) {
          throw new ProfileRestoreError(
            `Extracted tree escapes stage: ${real}. Refusing to continue.`,
          );
        }
        walk(full);
      } else if (!st.isFile()) {
        throw new ProfileRestoreError(
          `Extracted tree contains a non-regular file at ${full}. Refusing to continue.`,
        );
      }
    }
  };
  walk(stageDir);
}

function parseAndValidateManifest(text: string): SaveBundleManifestV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProfileRestoreError(
      `manifest.json is not valid JSON (${(err as Error).message}).`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileRestoreError(`manifest.json is not a JSON object.`);
  }
  const m = parsed as Record<string, unknown>;
  const version = m.version;
  if (typeof version !== "number") {
    throw new ProfileRestoreError(
      `manifest.json is missing a numeric "version" field.`,
    );
  }
  if (version !== SAVE_BUNDLE_VERSION) {
    throw new ProfileRestoreError(
      `manifest.json declares version ${version}, but this CLI understands only version ${SAVE_BUNDLE_VERSION}. ` +
        `Upgrade or downgrade your arianna CLI to match the bundle.`,
    );
  }
  const profile = m.profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new ProfileRestoreError(
      `manifest.json is missing a "profile" object.`,
    );
  }
  const p = profile as Record<string, unknown>;
  if (typeof p.sessionId !== "string" || p.sessionId.length === 0) {
    throw new ProfileRestoreError(
      `manifest.json profile.sessionId is missing or empty.`,
    );
  }
  if (typeof p.name !== "string" || p.name.length === 0) {
    throw new ProfileRestoreError(
      `manifest.json profile.name is missing or empty.`,
    );
  }
  // Validate src profile name against the regex too — it flows into the
  // auto-generated default dst name when --name is omitted.
  if (!PROFILE_NAME_RE.test(p.name)) {
    throw new ProfileRestoreError(
      `manifest.json profile.name "${p.name}" doesn't match ${PROFILE_NAME_RE.source}.`,
    );
  }
  return parsed as SaveBundleManifestV1;
}

function resolveDstName(
  fromArg: string | undefined,
  srcName: string,
  now: number,
): string {
  if (fromArg !== undefined) {
    return assertValidProfileName(fromArg);
  }
  // Default: `<src>-restored-<ts>`. Trim if too long; profile-name regex
  // allows up to 31 chars (1 leading lower + 30 trailing).
  const tsTail = `-restored-${now}`;
  const maxBase = 31 - tsTail.length;
  // If the suffix alone is too long, fall back to a short name. Date.now is
  // 13 digits in 2026; "-restored-1714603200000" is 23 chars, leaving 8 for
  // base. Fine for typical names.
  if (maxBase < 1) {
    throw new ProfileRestoreError(
      `Auto-generated dst name from timestamp ${now} would exceed the 31-char limit. Pass --name <short-name> instead.`,
    );
  }
  const base = srcName.length > maxBase ? srcName.slice(0, maxBase) : srcName;
  const candidate = `${base}${tsTail}`;
  // `now` is digits only; src is regex-validated; so candidate matches the
  // regex by construction. assertValidProfileName re-checks (defense-in-
  // depth against future edits to the construction logic).
  return assertValidProfileName(candidate);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const _internal = {
  parseAndValidateManifest,
  resolveDstName,
  shellQuote,
  preflightTarball,
};
