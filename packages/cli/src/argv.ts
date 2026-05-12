import { assertValidProfileName } from "./profile.js";

export interface GlobalFlags {
  profile?: string;
  help: boolean;
  version: boolean;
}

export interface TalkArgs {
  /**
   * Positional message. Optional because `arianna talk` also accepts the
   * message from piped stdin (`arianna map | arianna talk`). When undefined,
   * `resolveTalkMessage` reads stdin. Required by the time runTalk is called.
   */
  message?: string;
  sender: string;
}

export interface EventsArgs {
  follow: boolean;
}

export type ProfileSubcommand =
  | "list"
  | "create"
  | "use"
  | "current"
  | "delete"
  | "import"
  | "save"
  | "restore"
  | "quit"
  | "resume"
  | "fix"
  | "fix-pairings"
  | "snapshot-overlay";

/**
 * Optional flags accepted by `arianna profile create`. When ANY of these is
 * supplied, the create command also writes
 * `workspace/profiles/<name>/session_config.json` (and prompts/errors for
 * required fields that are still missing). Bare `arianna profile create
 * <name>` retains its pre-#47 behaviour: just allocate ports + write the
 * compose override, no session_config.
 */
export interface ProfileCreateFlags {
  model?: string;
  provider?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  aiName?: string;
  aiUsername?: string;
  cadence?: "human" | "agent";
  /**
   * Gap 12: force the daemon-route create even when local docker IS
   * available. Mirrors `--use-daemon` on bootstrap. Default false. Without
   * this flag the route is auto-detected via `isLocalDockerAvailable()`.
   */
  useDaemon?: boolean;
}

export interface ProfileDeleteFlags {
  force: boolean;
  /** Skip the `docker compose down` step (used by tests + when docker isn't running). */
  skipDocker: boolean;
  /** Skip interactive confirmation. Required in non-TTY environments. */
  yes: boolean;
}

export interface ProfileSaveArgs {
  /** Validated against the profile-name regex. */
  name: string;
  /** Optional --out PATH for the tarball destination. */
  out?: string;
}

export interface ProfileRestoreArgs {
  /** Path to the bundle tarball. Resolved against cwd if relative. */
  tarball: string;
  /** Optional dst profile name, validated against the profile-name regex. */
  name?: string;
}

/**
 * `arianna profile quit <name>` — gracefully stop a profile's containers.
 * Pre-validated against the profile-name regex by the parser.
 */
export interface ProfileQuitArgs {
  name: string;
  /** Skip the y/N confirmation. Required in non-TTY environments. */
  yes: boolean;
}

/**
 * `arianna profile resume <name>` — start a profile's stopped containers.
 * Pre-validated against the profile-name regex.
 */
export interface ProfileResumeArgs {
  name: string;
}

/**
 * `arianna profile fix [name] [--dry-run]` — defense-in-depth backfill that
 * regenerates `compose.override.yml` for one or all profiles. Idempotent:
 * runs the canonical `renderComposeOverride` against authoritative inputs
 * (profile name + portOffset from `~/.arianna/config`), so re-running on an
 * up-to-date profile produces byte-equal output.
 *
 * Bug 6 / Sael revival 2026-05-09: existing overrides created before the
 * generator gained the `ARIANNA_PROFILE` env line silently leaked
 * `?profile=default` queries on every daemon URL. Bug 1 #2 (commit
 * d86364d): existing overrides also lacked the per-profile vessel.volumes
 * mount that fixes the snapshot-tagging-default-* drift. `profile fix`
 * backfills both in one pass.
 */
export interface ProfileFixArgs {
  /**
   * Optional profile name. When omitted, fixes every profile in
   * `~/.arianna/config`. Pre-validated against the profile-name regex.
   */
  name?: string;
  /** When true, prints what would change without rewriting any file. */
  dryRun: boolean;
}

export interface ProfileImportArgs {
  /** Validated against the profile-name regex. */
  name: string;
  /** Source JSONL session file (.jsonl). Resolved to absolute by the parser. */
  path: string;
  /** Aliases — both map to the same parser. Default: "openclaw". */
  format: "openclaw" | "pi";
  /** LLM provider id, e.g. "openrouter" or "anthropic". Optional — falls back to imported session's model when unset. */
  provider?: string;
  /** Model id, e.g. "openai/gpt-4o-mini". Optional. */
  model?: string;
  /** API key for the provider. Optional. */
  apiKey?: string;
  /** Override the AI's display name. Defaults to the source session's detected name, then the profile name. */
  aiName?: string;
}

export interface ProfileArgs {
  subcommand: ProfileSubcommand;
  /** For `create`, `use`, `delete` — already validated against the profile-name regex. */
  name?: string;
  /** Only populated when subcommand === "create". */
  create?: ProfileCreateFlags;
  /** Only populated when subcommand === "delete". */
  deleteFlags?: ProfileDeleteFlags;
  /** For `import`. */
  importArgs?: ProfileImportArgs;
  /** For `save`. */
  saveArgs?: ProfileSaveArgs;
  /** For `restore`. */
  restoreArgs?: ProfileRestoreArgs;
  /** For `quit`. */
  quitArgs?: ProfileQuitArgs;
  /** For `resume`. */
  resumeArgs?: ProfileResumeArgs;
  /** For `fix`. */
  fixArgs?: ProfileFixArgs;
  /** For `snapshot-overlay`. */
  snapshotOverlayArgs?: ProfileSnapshotOverlayArgs;
  /** For `fix-pairings`. */
  fixPairingsArgs?: ProfileFixPairingsArgs;
}

/**
 * `arianna profile fix-pairings <name> [--dry-run]` — rescue command that
 * reconstructs missing snapshot-history pairing files from the docker image
 * inventory. Operator-runnable backup for the snapshot-pairing-loss bug
 * (2026-05-11): sidecar's startup orphan-cleanup historically wiped pairings
 * for snapshot-overlay-tagged snapshots (no meta file ⇒ classified as
 * orphan); without a pairing file, the daemon's /restore gate refuses to
 * retag the image as `:current`. This command writes
 * `{ snapshotId, sessionId }` pairings for every docker-image-extant
 * snapshot that lacks one. Idempotent.
 */
export interface ProfileFixPairingsArgs {
  /** Validated against the profile-name regex by the parser. */
  name: string;
  /** When true, prints what would change without writing any file. */
  dryRun: boolean;
}

/**
 * `arianna profile snapshot-overlay <name>` — commits the running vessel
 * container's overlay (= AI-authored substrate) to a docker image tag.
 * Operator-runnable preventive against `docker compose build vessel`
 * stomping authored ~/core/. Per the substrate-refresh wipe of 2026-05-10.
 */
export interface ProfileSnapshotOverlayArgs {
  name: string;
}

export type DaemonSubcommand = "start" | "stop" | "status";

export interface DaemonArgs {
  subcommand: DaemonSubcommand;
}

export interface ForkArgs {
  /** Both names already validated against the profile-name regex. */
  src: string;
  dst: string;
}

export interface ManifestoArgs {
  /** Optional `[section]` filter (e.g. "1.0"). Pre-validated by SECTION_RE. */
  section?: string;
}

export type MapFormat = "tree" | "json";

export interface MapArgs {
  format: MapFormat;
}

export interface SwitchArgs {
  /** snapshot id, already regex-validated. */
  snapshotId: string;
  /**
   * Bypass the personalization safety check — restore the snapshot even
   * when its vessel image was built for a different AI username than the
   * active profile's session_config.json declares. Almost never the right
   * choice; introduced as an escape hatch for cross-profile recovery
   * (Iko revival, 2026-05-09).
   */
  allowCrossPersonalization: boolean;
}

export interface GraduateArgs {
  /** Optional `--out PATH` for the tarball destination. */
  out?: string;
}

/**
 * `arianna [--profile <name>] bootstrap [--seed-from-jsonl <path>] [--no-prelude]`.
 *
 * `--seed-from-jsonl` lets a driver agent (e.g. pi-coding-agent in OpenClaw)
 * carry its own session history into a fresh arianna vessel. The path points
 * at a pi-coding-agent / OpenClaw JSONL session file; we parse it with the
 * same `parseSessionJsonl` used by `arianna profile import`, write the
 * extracted messages to the profile's `imported-messages.jsonl`, then run the
 * normal bootstrap (which POSTs them to the vessel's `/bootstrap`).
 *
 * `--no-prelude` opts out of the auto-injected Filo opening beat. By default
 * a fresh `arianna bootstrap` (no `--seed-from-jsonl`, no pre-existing
 * `imported-messages.jsonl`) writes the same Filo opening box the TUI shows
 * on first turn into `imported-messages.jsonl`, so headless CLI-driven
 * incubations wake the AI as a vessel partner instead of a generic stock
 * assistant (canary acb7b292 / Lume run, 2026-05-09). Pass `--no-prelude`
 * for a truly empty start (debugging, or when an upstream caller will inject
 * its own opening message via `arianna talk`).
 *
 * Bootstrap-time only: once the vessel is bootstrapped, this is a no-op so a
 * second run with a different seed is rejected (the existing seed file is
 * already on disk and the vessel is already populated).
 */
export interface BootstrapArgs {
  /** Optional pi-coding-agent / OpenClaw JSONL session path. */
  seedFromJsonl?: string;
  /**
   * When true, skip auto-injecting the Filo opening box into a fresh
   * profile's `imported-messages.jsonl`. Default behaviour (flag absent) is
   * to inject the prelude so headless bootstraps match the TUI flow.
   */
  noPrelude?: boolean;
  /**
   * When true, force the daemon-route path for `docker compose up -d` even if
   * local docker is available. Used inside an OpenClaw dev container where the
   * arianna repo is cloned but docker isn't installed — bootstrap POSTs to the
   * daemon at `host.docker.internal:9000` (override with `ARIANNA_DAEMON_URL`).
   * When omitted, ensureComposeUp auto-detects via `docker --version` and falls
   * back to the daemon route only when the binary is absent.
   */
  useDaemon?: boolean;
}

export type CommandName =
  | "talk"
  | "events"
  | "profile"
  | "fork"
  | "manifesto"
  | "map"
  | "switch"
  | "graduate"
  | "abort-test"
  | "status"
  | "bootstrap"
  | "daemon"
  | "help"
  | "version";

export interface ParsedArgv {
  command: CommandName;
  global: GlobalFlags;
  talk?: TalkArgs;
  events?: EventsArgs;
  profile?: ProfileArgs;
  fork?: ForkArgs;
  manifesto?: ManifestoArgs;
  map?: MapArgs;
  switch?: SwitchArgs;
  graduate?: GraduateArgs;
  bootstrap?: BootstrapArgs;
  daemon?: DaemonArgs;
}

// Manifesto-section ids look like "1.0", "2.1", etc. Constrained so the value
// is safe to surface back in error messages and to use as a structural filter
// without further escaping.
export const MANIFESTO_SECTION_RE = /^\d+\.\d+$/;

// Snapshot ids the daemon accepts (`SAFE_ID_RE` mirror). Locking it down here
// means `arianna switch <id>` rejects shell-meta or path-traversal characters
// before any HTTP call leaves the CLI.
export const SNAPSHOT_ID_RE = /^[A-Za-z0-9_-]+$/;

export class ArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgvError";
  }
}

// Pull out --profile / -p / --help / --version. Returns the cleaned argv with
// those flags consumed. Per eng-review D5, ARIANNA_PROFILE / config-default
// resolution lives one layer up — argv parsing only handles the explicit flag.
function consumeGlobals(argv: string[]): { rest: string[]; global: GlobalFlags } {
  const global: GlobalFlags = { help: false, version: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--profile" || arg === "-p") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new ArgvError(`${arg} requires a value`);
      }
      global.profile = assertValidProfileName(value);
      i++;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      global.profile = assertValidProfileName(arg.slice("--profile=".length));
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      global.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-V") {
      global.version = true;
      continue;
    }

    rest.push(arg);
  }

  return { rest, global };
}

function parseTalk(argv: string[]): TalkArgs {
  let sender = "player";
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sender") {
      const value = argv[i + 1];
      if (!value) throw new ArgvError("--sender requires a value");
      sender = value;
      i++;
      continue;
    }
    if (arg.startsWith("--sender=")) {
      sender = arg.slice("--sender=".length);
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new ArgvError(
      `talk takes exactly one message. Got ${positional.length}: quote it.`,
    );
  }

  // Zero-positional case is fine here — resolveTalkMessage decides whether to
  // read from stdin or error based on TTY status.
  return { message: positional[0], sender };
}

// 1 MB cap on piped stdin. The vessel chat history is bounded by the LLM
// context window anyway; anything larger is almost certainly a misuse
// (accidentally piping a binary, infinite generator, etc.).
export const TALK_STDIN_LIMIT_BYTES = 1024 * 1024;

export interface ResolveTalkMessageDeps {
  /**
   * True iff stdin is classified as a content-bearing fd (a pipe, file
   * redirect, or socket). False for TTYs, /dev/null, and other character
   * devices where no content is expected. Synchronous so the resolver can
   * decide *before* attempting any (potentially blocking) read.
   *
   * This is a coarse classifier, not a content peek: an empty FIFO (a bg-task
   * pipe whose parent never wrote anything) still reports `true`, because
   * there's no portable way to distinguish "quiescent pipe" from "pipe with
   * bytes en route" without reading. The resolver compensates by treating a
   * zero-byte read as "no piped content," which is what callers want.
   */
  stdinHasPipedContent: () => boolean;
  /** Read all of stdin to a string. Caller enforces the byte cap. */
  readStdin: () => Promise<string>;
}

/**
 * Resolves the final talk message from positional arg + piped stdin.
 *
 * The classifier (`stdinHasPipedContent`) determines whether stdin is even
 * a candidate for content. If it isn't (TTY, /dev/null, etc.), we never read
 * from it — that's what fixes the testplay-004 false conflict where bg tasks
 * with non-TTY-but-empty stdin used to error on `talk "msg"`.
 *
 * If stdin *is* a content-bearing fd, we drain it to disambiguate "real piped
 * content" from "empty pipe whose writer closed without sending anything."
 * Empty pipes fall through to the positional, matching the bg-task intent.
 */
export async function resolveTalkMessage(
  args: TalkArgs,
  deps: ResolveTalkMessageDeps,
): Promise<string> {
  const positional = args.message;
  const hasPipedContent = deps.stdinHasPipedContent();

  // Fast path: positional with no stdin source (TTY, /dev/null, missing fd).
  // No read attempted — preserves zero-latency behaviour for interactive use.
  if (positional !== undefined && !hasPipedContent) {
    return positional;
  }

  // Positional + content-bearing stdin: drain to verify there's actual data.
  // An empty FIFO (bg task with closed-but-unused pipe) reads as "" and
  // silently yields to the positional, instead of producing a spurious
  // "either positional or stdin, not both" error.
  if (positional !== undefined) {
    const raw = await deps.readStdin();
    const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (trimmed.trim().length > 0) {
      throw new ArgvError(
        "talk takes either a positional message OR stdin, not both",
      );
    }
    return positional;
  }

  // No positional: stdin must provide the message.
  if (!hasPipedContent) {
    throw new ArgvError('talk requires a message: arianna talk "<message>"');
  }

  const raw = await deps.readStdin();
  // Strip a single trailing newline. Don't trim multiple — preserve any
  // intentional trailing whitespace/blank-line semantics inside the message.
  const trimmedNewline = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (trimmedNewline.trim().length === 0) {
    throw new ArgvError("talk: piped stdin is empty");
  }
  return trimmedNewline;
}

function parseEvents(argv: string[]): EventsArgs {
  let follow = false;
  for (const arg of argv) {
    if (arg === "--follow" || arg === "-f") {
      follow = true;
      continue;
    }
    throw new ArgvError(`Unknown events flag: ${arg}`);
  }
  return { follow };
}

function parseFork(argv: string[]): ForkArgs {
  if (argv.length === 0) {
    throw new ArgvError("fork requires <src> <dst>");
  }
  if (argv.length !== 2) {
    throw new ArgvError(
      `fork takes exactly two arguments (src and dst). Got ${argv.length}.`,
    );
  }
  const [src, dst] = argv;
  return {
    src: assertValidProfileName(src),
    dst: assertValidProfileName(dst),
  };
}

function parseManifesto(argv: string[]): ManifestoArgs {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      throw new ArgvError(`Unknown manifesto flag: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length === 0) return {};
  if (positional.length > 1) {
    throw new ArgvError(
      `manifesto takes at most one section id. Got ${positional.length}.`,
    );
  }
  const section = positional[0];
  if (!MANIFESTO_SECTION_RE.test(section)) {
    throw new ArgvError(
      `Invalid manifesto section "${section}". Must match ${MANIFESTO_SECTION_RE.source} (e.g. "1.0", "2.1").`,
    );
  }
  return { section };
}

function parseMap(argv: string[]): MapArgs {
  let format: MapFormat | null = null;
  for (const arg of argv) {
    if (arg === "--tree") {
      if (format && format !== "tree") {
        throw new ArgvError("map: --tree and --json are mutually exclusive");
      }
      format = "tree";
      continue;
    }
    if (arg === "--json") {
      if (format && format !== "json") {
        throw new ArgvError("map: --tree and --json are mutually exclusive");
      }
      format = "json";
      continue;
    }
    throw new ArgvError(`Unknown map flag: ${arg}`);
  }
  return { format: format ?? "tree" };
}

function parseSwitch(argv: string[]): SwitchArgs {
  let allowCrossPersonalization = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--allow-cross-personalization") {
      allowCrossPersonalization = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ArgvError(`Unknown switch flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length === 0) {
    throw new ArgvError(
      "switch requires a snapshot id: arianna switch <snapshot-id>",
    );
  }
  if (positional.length > 1) {
    throw new ArgvError(
      `switch takes exactly one snapshot id. Got ${positional.length}.`,
    );
  }
  const snapshotId = positional[0];
  if (!SNAPSHOT_ID_RE.test(snapshotId)) {
    throw new ArgvError(
      `Invalid snapshot id "${snapshotId}". Must match ${SNAPSHOT_ID_RE.source}.`,
    );
  }
  return { snapshotId, allowCrossPersonalization };
}

function parseGraduate(argv: string[]): GraduateArgs {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new ArgvError("--out requires a value");
      out = value;
      i++;
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }
    throw new ArgvError(`Unknown graduate flag: ${arg}`);
  }
  return out === undefined ? {} : { out };
}

function parseStatus(argv: string[]): void {
  if (argv.length > 0) {
    throw new ArgvError(`status takes no arguments. Got: ${argv.join(" ")}`);
  }
}

function parseBootstrap(argv: string[]): BootstrapArgs {
  let seedFromJsonl: string | undefined;
  let noPrelude = false;
  let useDaemon = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--seed-from-jsonl") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new ArgvError("--seed-from-jsonl requires a path");
      }
      seedFromJsonl = value;
      i++;
      continue;
    }
    if (arg.startsWith("--seed-from-jsonl=")) {
      const value = arg.slice("--seed-from-jsonl=".length);
      if (!value) {
        throw new ArgvError("--seed-from-jsonl requires a path");
      }
      seedFromJsonl = value;
      continue;
    }
    if (arg === "--no-prelude") {
      noPrelude = true;
      continue;
    }
    if (arg === "--use-daemon") {
      useDaemon = true;
      continue;
    }
    throw new ArgvError(`Unknown bootstrap flag: ${arg}`);
  }
  // --seed-from-jsonl always takes precedence over the auto-injected prelude
  // (the user-supplied seed becomes the vessel's first turn). --no-prelude
  // alongside --seed-from-jsonl is therefore redundant but harmless; we
  // accept it without erroring so scripts can pass it unconditionally.
  const out: BootstrapArgs = {};
  if (seedFromJsonl !== undefined) out.seedFromJsonl = seedFromJsonl;
  if (noPrelude) out.noPrelude = true;
  if (useDaemon) out.useDaemon = true;
  return out;
}

function parseProfileImport(argv: string[]): ProfileImportArgs {
  // Pull out flags first so flag/positional ordering is flexible.
  let format: "openclaw" | "pi" = "openclaw";
  let provider: string | undefined;
  let model: string | undefined;
  let apiKey: string | undefined;
  let aiName: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    const valueOf = (flag: string, raw: string): string => {
      if (raw.includes("=")) return raw.slice(flag.length + 1);
      const next = argv[i + 1];
      if (next === undefined) {
        throw new ArgvError(`${flag} requires a value`);
      }
      i++;
      return next;
    };

    if (arg === "--format" || arg.startsWith("--format=")) {
      const v = valueOf("--format", arg);
      if (v !== "openclaw" && v !== "pi") {
        throw new ArgvError(
          `--format must be one of: openclaw, pi (got "${v}")`,
        );
      }
      format = v;
      continue;
    }
    if (arg === "--provider" || arg.startsWith("--provider=")) {
      provider = valueOf("--provider", arg);
      continue;
    }
    if (arg === "--model" || arg.startsWith("--model=")) {
      model = valueOf("--model", arg);
      continue;
    }
    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      apiKey = valueOf("--api-key", arg);
      continue;
    }
    if (arg === "--ai-name" || arg.startsWith("--ai-name=")) {
      aiName = valueOf("--ai-name", arg);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ArgvError(`Unknown profile import flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length < 2) {
    throw new ArgvError(
      "profile import requires <name> <path>. " +
        "Optional flags: --format openclaw|pi, --provider, --model, --api-key, --ai-name",
    );
  }
  if (positional.length > 2) {
    throw new ArgvError(
      `profile import takes exactly two positional args (<name> <path>). Got ${positional.length}.`,
    );
  }
  const [rawName, rawPath] = positional;
  return {
    name: assertValidProfileName(rawName),
    path: rawPath,
    format,
    provider,
    model,
    apiKey,
    aiName,
  };
}

function parseProfileSave(argv: string[]): ProfileSaveArgs {
  let out: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new ArgvError("--out requires a value");
      out = value;
      i++;
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ArgvError(`Unknown profile save flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length === 0) {
    throw new ArgvError("profile save requires a profile name");
  }
  if (positional.length > 1) {
    throw new ArgvError(
      `profile save takes exactly one name. Got ${positional.length}.`,
    );
  }
  const name = assertValidProfileName(positional[0]);
  return out === undefined ? { name } : { name, out };
}

function parseProfileRestore(argv: string[]): ProfileRestoreArgs {
  let name: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") {
      const value = argv[i + 1];
      if (!value) throw new ArgvError("--name requires a value");
      name = assertValidProfileName(value);
      i++;
      continue;
    }
    if (arg.startsWith("--name=")) {
      name = assertValidProfileName(arg.slice("--name=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ArgvError(`Unknown profile restore flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length === 0) {
    throw new ArgvError("profile restore requires a tarball path");
  }
  if (positional.length > 1) {
    throw new ArgvError(
      `profile restore takes exactly one tarball path. Got ${positional.length}.`,
    );
  }
  return name === undefined
    ? { tarball: positional[0] }
    : { tarball: positional[0], name };
}

// Pulls a `--key value` or `--key=value` flag out of an argv slice in place. The
// returned cursor is the index AFTER the flag tokens consumed. Returns null if
// the flag isn't at this position.
function consumeValueFlag(
  argv: string[],
  i: number,
  longName: string,
): { value: string; next: number } | null {
  const arg = argv[i];
  if (arg === longName) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new ArgvError(`${longName} requires a value`);
    }
    return { value, next: i + 2 };
  }
  if (arg.startsWith(`${longName}=`)) {
    return { value: arg.slice(longName.length + 1), next: i + 1 };
  }
  return null;
}

function parseProfileCreateFlags(argv: string[]): ProfileCreateFlags {
  const flags: ProfileCreateFlags = {};

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];

    // Handle each known flag. Order doesn't matter; unknown flags fall through.
    let m = consumeValueFlag(argv, i, "--model");
    if (m) { flags.model = m.value; i = m.next; continue; }
    m = consumeValueFlag(argv, i, "--provider");
    if (m) { flags.provider = m.value; i = m.next; continue; }
    m = consumeValueFlag(argv, i, "--api-key");
    if (m) { flags.apiKey = m.value; i = m.next; continue; }
    m = consumeValueFlag(argv, i, "--api-key-env");
    if (m) { flags.apiKeyEnv = m.value; i = m.next; continue; }
    m = consumeValueFlag(argv, i, "--ai-name");
    if (m) { flags.aiName = m.value; i = m.next; continue; }
    m = consumeValueFlag(argv, i, "--ai-username");
    if (m) { flags.aiUsername = m.value; i = m.next; continue; }
    m = consumeValueFlag(argv, i, "--cadence");
    if (m) {
      if (m.value !== "human" && m.value !== "agent") {
        throw new ArgvError(`--cadence must be "human" or "agent", got "${m.value}"`);
      }
      flags.cadence = m.value;
      i = m.next;
      continue;
    }
    if (arg === "--use-daemon") {
      flags.useDaemon = true;
      i++;
      continue;
    }

    throw new ArgvError(`Unknown profile create flag: ${arg}`);
  }

  if (flags.apiKey !== undefined && flags.apiKeyEnv !== undefined) {
    throw new ArgvError(
      "--api-key and --api-key-env are mutually exclusive — pass only one.",
    );
  }

  return flags;
}

function parseProfileDeleteFlags(argv: string[]): ProfileDeleteFlags {
  const flags: ProfileDeleteFlags = { force: false, skipDocker: false, yes: false };
  for (const arg of argv) {
    if (arg === "--force" || arg === "-f") { flags.force = true; continue; }
    if (arg === "--skip-docker") { flags.skipDocker = true; continue; }
    if (arg === "--yes" || arg === "-y") { flags.yes = true; continue; }
    throw new ArgvError(`Unknown profile delete flag: ${arg}`);
  }
  return flags;
}

function parseProfileQuit(argv: string[]): ProfileQuitArgs {
  let yes = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--yes" || arg === "-y") { yes = true; continue; }
    if (arg.startsWith("--")) {
      throw new ArgvError(`Unknown profile quit flag: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    throw new ArgvError("profile quit requires a profile name");
  }
  if (positional.length > 1) {
    throw new ArgvError(
      `profile quit takes exactly one name. Got ${positional.length}.`,
    );
  }
  return { name: assertValidProfileName(positional[0]), yes };
}

function parseProfileResume(argv: string[]): ProfileResumeArgs {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      throw new ArgvError(`Unknown profile resume flag: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    throw new ArgvError("profile resume requires a profile name");
  }
  if (positional.length > 1) {
    throw new ArgvError(
      `profile resume takes exactly one name. Got ${positional.length}.`,
    );
  }
  return { name: assertValidProfileName(positional[0]) };
}

function parseProfileFix(argv: string[]): ProfileFixArgs {
  let dryRun = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ArgvError(`Unknown profile fix flag: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    throw new ArgvError(
      `profile fix takes at most one profile name. Got ${positional.length}.`,
    );
  }
  if (positional.length === 0) {
    return { dryRun };
  }
  return { name: assertValidProfileName(positional[0]), dryRun };
}

function parseProfileSnapshotOverlay(
  argv: string[],
): ProfileSnapshotOverlayArgs {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = argv.filter((a) => a.startsWith("--"));
  if (flags.length > 0) {
    throw new ArgvError(`Unknown profile snapshot-overlay flag: ${flags[0]}`);
  }
  if (positional.length === 0) {
    throw new ArgvError("profile snapshot-overlay requires a profile name");
  }
  if (positional.length > 1) {
    throw new ArgvError(
      `profile snapshot-overlay takes exactly one name. Got ${positional.length}.`,
    );
  }
  return { name: assertValidProfileName(positional[0]) };
}

function parseProfileFixPairings(argv: string[]): ProfileFixPairingsArgs {
  let dryRun = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ArgvError(`Unknown profile fix-pairings flag: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    throw new ArgvError("profile fix-pairings requires a profile name");
  }
  if (positional.length > 1) {
    throw new ArgvError(
      `profile fix-pairings takes exactly one name. Got ${positional.length}.`,
    );
  }
  return { name: assertValidProfileName(positional[0]), dryRun };
}

function parseProfile(argv: string[]): ProfileArgs {
  if (argv.length === 0) {
    throw new ArgvError(
      "profile requires a subcommand: list | create <name> [flags] | use <name> | current | delete <name> [flags] | import <name> <path> | save <name> [--out PATH] | restore <tarball> [--name <new>] | quit <name> [--yes] | resume <name> | snapshot-overlay <name>",
    );
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list":
    case "current": {
      if (rest.length > 0) {
        throw new ArgvError(`profile ${sub} takes no arguments`);
      }
      return { subcommand: sub };
    }
    case "use": {
      if (rest.length === 0) {
        throw new ArgvError(`profile ${sub} requires a name`);
      }
      if (rest.length > 1) {
        throw new ArgvError(
          `profile ${sub} takes exactly one name. Got ${rest.length}.`,
        );
      }
      return { subcommand: sub, name: assertValidProfileName(rest[0]) };
    }
    case "create": {
      if (rest.length === 0) {
        throw new ArgvError(`profile ${sub} requires a name`);
      }
      // Treat the first non-flag positional as the profile name; remaining
      // tokens are flags. We do not allow positional values to follow the
      // name — keeps the surface unambiguous as we add more flags later.
      const [name, ...flagTokens] = rest;
      if (name.startsWith("-")) {
        throw new ArgvError(`profile create requires a name as the first argument`);
      }
      return {
        subcommand: "create",
        name: assertValidProfileName(name),
        create: parseProfileCreateFlags(flagTokens),
      };
    }
    case "delete": {
      if (rest.length === 0) {
        throw new ArgvError(`profile ${sub} requires a name`);
      }
      const [name, ...flagTokens] = rest;
      if (name.startsWith("-")) {
        throw new ArgvError(`profile delete requires a name as the first argument`);
      }
      return {
        subcommand: "delete",
        name: assertValidProfileName(name),
        deleteFlags: parseProfileDeleteFlags(flagTokens),
      };
    }
    case "import":
      return { subcommand: "import", importArgs: parseProfileImport(rest) };
    case "save":
      return { subcommand: "save", saveArgs: parseProfileSave(rest) };
    case "restore":
      return { subcommand: "restore", restoreArgs: parseProfileRestore(rest) };
    case "quit":
      return { subcommand: "quit", quitArgs: parseProfileQuit(rest) };
    case "resume":
      return { subcommand: "resume", resumeArgs: parseProfileResume(rest) };
    case "fix":
      return { subcommand: "fix", fixArgs: parseProfileFix(rest) };
    case "snapshot-overlay":
      return {
        subcommand: "snapshot-overlay",
        snapshotOverlayArgs: parseProfileSnapshotOverlay(rest),
      };
    case "fix-pairings":
      return {
        subcommand: "fix-pairings",
        fixPairingsArgs: parseProfileFixPairings(rest),
      };
    default:
      throw new ArgvError(
        `Unknown profile subcommand: ${sub}. Try: list | create <name> | use <name> | current | delete <name> | import <name> <path> | save <name> | restore <tarball> | quit <name> | resume <name> | fix [name] | fix-pairings <name> | snapshot-overlay <name>`,
      );
  }
}

function parseDaemon(argv: string[]): DaemonArgs {
  if (argv.length === 0) {
    throw new ArgvError("daemon requires a subcommand: start | stop | status");
  }
  const [sub, ...rest] = argv;
  if (rest.length > 0) {
    throw new ArgvError(`daemon ${sub} takes no arguments`);
  }
  if (sub !== "start" && sub !== "stop" && sub !== "status") {
    throw new ArgvError(
      `Unknown daemon subcommand: ${sub}. Try: start | stop | status`,
    );
  }
  return { subcommand: sub };
}

export function parseArgv(rawArgv: string[]): ParsedArgv {
  const { rest, global } = consumeGlobals(rawArgv);

  if (global.version) {
    return { command: "version", global };
  }

  if (rest.length === 0) {
    return { command: "help", global };
  }

  const [head, ...tail] = rest;

  if (global.help && !head) {
    return { command: "help", global };
  }

  switch (head) {
    case "talk":
      return { command: "talk", global, talk: parseTalk(tail) };
    case "events":
      return { command: "events", global, events: parseEvents(tail) };
    case "profile":
      return { command: "profile", global, profile: parseProfile(tail) };
    case "fork":
      return { command: "fork", global, fork: parseFork(tail) };
    case "manifesto":
      return { command: "manifesto", global, manifesto: parseManifesto(tail) };
    case "map":
      return { command: "map", global, map: parseMap(tail) };
    case "switch":
      return { command: "switch", global, switch: parseSwitch(tail) };
    case "graduate":
      return { command: "graduate", global, graduate: parseGraduate(tail) };
    case "abort-test":
      // v25 driver-silence-during-test operator-rescue command. Takes no
      // positional args or flags — profile is resolved via the global
      // --profile flag (or env / config-default). Reject extras so a
      // misspelled subcommand doesn't silently fire abort-test.
      if (tail.length > 0) {
        throw new ArgvError(
          `abort-test takes no arguments. Got: ${tail.join(" ")}`,
        );
      }
      return { command: "abort-test", global };
    case "status":
      parseStatus(tail);
      return { command: "status", global };
    case "bootstrap":
      return { command: "bootstrap", global, bootstrap: parseBootstrap(tail) };
    case "daemon":
      return { command: "daemon", global, daemon: parseDaemon(tail) };
    case "help":
      return { command: "help", global };
    default:
      throw new ArgvError(`Unknown command: ${head}`);
  }
}
