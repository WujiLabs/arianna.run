// `arianna profile save <name> [--out PATH]`
//
// Bundle a profile's full state (workspace dir + every docker image whose tag
// references the profile's sessionId) into a portable tarball that can be
// shipped to another machine and restored via `arianna profile restore`.
//
// The bundle layout:
//
//   manifest.json        — profile name, sessionId, AI name, model, provider,
//                          docker tag list, snapshot ids, save timestamp,
//                          arianna git HEAD hash, format version.
//   docker-images.tar    — `docker save` of every ariannarun-vessel:<sid>-*
//                          tag. Layer-shared by docker so 10 snapshots ≈ one
//                          base layer + per-snapshot deltas.
//   profile/             — verbatim copy of workspace/profiles/<name>/
//                          (session_config.json, sidecar-state, snapshots,
//                          compose.override.yml, ...).

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

import { assertValidProfileName } from "../profile.js";
import { loadConfig } from "../arianna-config.js";
import { profileDir, resolveRepoRoot, type PathOpts } from "../paths.js";
import {
  SAFE_SESSION_ID_RE,
  VESSEL_REPO,
  listTagsCmd,
  type CloneExecFn,
} from "./_profile-clone-helpers.js";

export const SAVE_BUNDLE_VERSION = 1 as const;

export class ProfileSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileSaveError";
  }
}

export interface ProfileSaveArgs {
  /** Already validated against the profile-name regex. */
  name: string;
  /** Optional --out PATH override. Resolved against cwd if relative. */
  out?: string;
}

export interface ProfileSaveDeps extends PathOpts {
  /** Run a shell command. Production: promisify(exec). */
  exec: CloneExecFn;
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /** Source of save-timestamp + default-output-name date. Default: Date.now. */
  now?: () => number;
  /** Test seam — current working directory for resolving --out. */
  cwd?: string;
  /** Test seam — temp dir base. Default: os.tmpdir(). */
  tmpDir?: string;
}

export interface SaveBundleManifestV1 {
  version: 1;
  savedAt: number;
  /** `null` if the arianna git HEAD couldn't be read. */
  ariannaGitHead: string | null;
  profile: {
    /** Source profile name at save time. Informational only — restore picks
     *  a fresh name; this exists for the saver's audit trail. */
    name: string;
    sessionId: string;
    /** Optional fields copied from session_config.json verbatim. */
    aiName?: string;
    aiUsername?: string;
    provider?: string;
    modelId?: string;
  };
  /** Tags found via `docker images --filter`. Informational. */
  dockerTags: string[];
  /** Snapshot ids derived from snapshot-histories filenames. Informational. */
  snapshotIds: string[];
}

// Same forbidden-prefixes set as graduate.ts. Limits where a tarball can be
// written when run as root.
const FORBIDDEN_OUT_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/sys",
  "/proc",
  "/dev",
  "/var/lib",
  "/var/log",
  "/private/etc",
  "/private/var/lib",
  "/private/var/log",
  "/Library/System",
  "/System",
];

export async function runProfileSave(
  args: ProfileSaveArgs,
  deps: ProfileSaveDeps,
): Promise<number> {
  // Defensive validation — argv parser already enforced regex but
  // programmatic callers may invoke runProfileSave directly.
  assertValidProfileName(args.name);

  const cfg = loadConfig(deps);
  if (!cfg.profiles.has(args.name)) {
    throw new ProfileSaveError(
      `Profile "${args.name}" not in ~/.arianna/config. Run \`arianna profile list\` to see configured profiles.`,
    );
  }

  const srcDir = profileDir(args.name, deps);
  const sessionConfigPath = join(srcDir, "session_config.json");
  if (!existsSync(sessionConfigPath)) {
    throw new ProfileSaveError(
      `Profile "${args.name}" has no session_config.json (path: ${sessionConfigPath}). Nothing to save.`,
    );
  }

  let srcConfig: Record<string, unknown>;
  try {
    srcConfig = JSON.parse(readFileSync(sessionConfigPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new ProfileSaveError(
      `session_config.json is not valid JSON (${(err as Error).message}).`,
    );
  }

  const sessionId = srcConfig.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ProfileSaveError(
      `session_config.json is missing a sessionId — cannot determine which docker tags to save.`,
    );
  }
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new ProfileSaveError(
      `sessionId "${sessionId}" contains characters that aren't safe to interpolate into a docker command. Expected ${SAFE_SESSION_ID_RE.source}.`,
    );
  }

  // List tags BEFORE picking output path so a docker-side failure doesn't
  // create empty bundles.
  const tagListResult = await deps.exec(listTagsCmd(sessionId));
  const dockerTags = tagListResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (dockerTags.length === 0) {
    throw new ProfileSaveError(
      `No docker tags found for sessionId ${sessionId}. ` +
        `Profile must have at least an ${VESSEL_REPO}:${sessionId}-base tag — was the vessel ever bootstrapped?`,
    );
  }

  // Resolve output path. Default lives in cwd, named with profile + date.
  const cwd = deps.cwd ?? process.cwd();
  const now = (deps.now ?? Date.now)();
  const dateStamp = formatDateStamp(now);
  const defaultOutName = `arianna-profile-${args.name}-${dateStamp}.tar.gz`;
  const rawOut = args.out ?? join(cwd, defaultOutName);
  const outPath = validateOutPath(rawOut, cwd);

  // Refuse to clobber an existing file. The user may not realize they're
  // about to overwrite a previous save.
  if (existsSync(outPath)) {
    throw new ProfileSaveError(
      `Output path ${outPath} already exists. Pick a different --out path or remove the existing file.`,
    );
  }
  // Ensure parent dir exists; we don't auto-create deep paths, just the
  // immediate parent for ergonomics.
  mkdirSync(dirname(outPath), { recursive: true });

  // Stage the bundle in a temp dir so a partial failure doesn't leave
  // half-baked artifacts at the user's chosen path.
  const tmpBase = deps.tmpDir ?? tmpdir();
  const stage = mkdtempSync(join(tmpBase, "arianna-save-"));
  try {
    // 1. Copy profile dir into stage/profile/. cpSync(recursive:true)
    //    follows the same rules as the source — no extraordinary symlink
    //    handling needed because workspace/profiles/<name>/ never contains
    //    user-controlled symlinks (everything in there is written by the
    //    sidecar or arianna CLI).
    const profileStageDir = join(stage, "profile");
    cpSync(srcDir, profileStageDir, {
      recursive: true,
      // Don't follow symlinks. If anything is a symlink (it shouldn't be),
      // copy the link itself so the tarball doesn't pull in random files.
      dereference: false,
    });

    // 2. `docker save` every tag → stage/docker-images.tar. Layer-shared
    //    automatically.
    const dockerImagesPath = join(stage, "docker-images.tar");
    await dockerSaveAll(dockerTags, dockerImagesPath, deps.exec);

    // 3. Build manifest. Snapshot ids come from snapshot-histories filenames.
    const histDir = join(srcDir, "sidecar-state", "snapshot-histories");
    const snapshotIds = listSnapshotIds(histDir);
    const ariannaGitHead = await readGitHead(deps);

    const manifest: SaveBundleManifestV1 = {
      version: SAVE_BUNDLE_VERSION,
      savedAt: now,
      ariannaGitHead,
      profile: {
        name: args.name,
        sessionId,
        ...optStr("aiName", srcConfig),
        ...optStr("aiUsername", srcConfig),
        ...optStr("provider", srcConfig),
        ...optStr("modelId", srcConfig),
      },
      dockerTags,
      snapshotIds,
    };
    writeFileSync(
      join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    // 4. tar+gzip stage/ → outPath. `-C stage .` so paths inside the tarball
    //    are relative to the stage dir (no absolute paths embedded).
    await deps.exec(`tar -czf ${shellQuote(outPath)} -C ${shellQuote(stage)} .`);

    deps.write(`Saved profile "${args.name}" → ${outPath}\n`);
    deps.write(`  sessionId: ${sessionId}\n`);
    deps.write(
      `  ${dockerTags.length} docker image${dockerTags.length === 1 ? "" : "s"}, ${snapshotIds.length} snapshot${snapshotIds.length === 1 ? "" : "s"}\n`,
    );
    return 0;
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function dockerSaveAll(
  tags: string[],
  outPath: string,
  exec: CloneExecFn,
): Promise<void> {
  // Validate each tag against the safe character set so we don't risk shell
  // injection through a hand-edited image-list output. Tags should always
  // have the form `ariannarun-vessel:<sessionId>-<slot>` where sessionId
  // matches SAFE_SESSION_ID_RE and slot is similar.
  for (const t of tags) {
    if (!/^[a-zA-Z0-9_./:-]+$/.test(t)) {
      throw new ProfileSaveError(
        `Refusing to docker-save tag "${t}" — contains characters that aren't safe to interpolate into a shell command.`,
      );
    }
  }
  const tagArgs = tags.map(shellQuote).join(" ");
  await exec(`docker save -o ${shellQuote(outPath)} ${tagArgs}`);
}

function listSnapshotIds(histDir: string): string[] {
  if (!existsSync(histDir)) return [];
  return readdirSync(histDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

async function readGitHead(deps: ProfileSaveDeps): Promise<string | null> {
  // Use `git -C <repoRoot> rev-parse HEAD` so we read the arianna repo's
  // HEAD, not whatever cwd the user is in.
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(deps);
  } catch {
    return null;
  }
  try {
    const r = await deps.exec(`git -C ${shellQuote(repoRoot)} rev-parse HEAD`);
    const head = r.stdout.trim();
    return /^[0-9a-f]{7,40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

function optStr(
  key: string,
  cfg: Record<string, unknown>,
): Record<string, string> {
  const v = cfg[key];
  if (typeof v !== "string" || v.length === 0) return {};
  return { [key]: v };
}

function formatDateStamp(ms: number): string {
  // YYYY-MM-DD in UTC. Avoids TZ-dependent filenames so two users in different
  // timezones save with the same timestamp produce identical default names.
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function validateOutPath(rawOut: string, cwd: string): string {
  if (rawOut.length === 0) {
    throw new ProfileSaveError("--out path must not be empty");
  }
  if (rawOut.includes("\0")) {
    throw new ProfileSaveError("--out path must not contain NUL bytes");
  }
  const absolute = isAbsolute(rawOut) ? rawOut : resolve(cwd, rawOut);
  const normalized = resolve(absolute);

  // First check the literal normalized path against forbidden prefixes —
  // covers `/etc/foo.tar.gz` directly. Mirrors graduate.ts.
  rejectIfForbidden(normalized, rawOut);

  // Now resolve symlinks. `resolve()` does NOT follow symlinks, so a path
  // like `/Users/me/legit/save.tar.gz` where `legit` is a symlink to `/etc`
  // would pass the literal check above. realpath the deepest existing
  // ancestor and re-check forbidden prefixes against it.
  const ancestor = deepestExistingAncestor(normalized);
  if (ancestor) {
    let real: string;
    try {
      real = realpathSync(ancestor);
    } catch (err) {
      throw new ProfileSaveError(
        `--out path "${rawOut}" ancestor unreadable: ${(err as Error).message}`,
      );
    }
    const tail = normalized.slice(ancestor.length);
    const realDest = real + tail;
    rejectIfForbidden(realDest, rawOut);
  }

  return normalized;
}

function rejectIfForbidden(path: string, rawOut: string): void {
  for (const prefix of FORBIDDEN_OUT_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + sep)) {
      throw new ProfileSaveError(
        `--out path "${rawOut}" resolves into a protected system directory (${prefix}).`,
      );
    }
  }
}

function deepestExistingAncestor(path: string): string | null {
  let cur = path;
  while (cur !== sep && cur !== "") {
    try {
      lstatSync(cur);
      return cur;
    } catch {
      // doesn't exist — walk up
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    lstatSync(sep);
    return sep;
  } catch {
    return null;
  }
}

// Single-quote a path for safe shell interpolation. Embedded single quotes
// are escaped per the standard `'\''` trick.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const _internal = {
  validateOutPath,
  formatDateStamp,
  shellQuote,
  FORBIDDEN_OUT_PREFIXES,
};
