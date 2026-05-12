// `arianna [--profile <name>] profile quit` — gracefully stop a profile's
// vessel + sidecar containers without removing them. Containers' writable
// overlays (which carry the AI's filesystem state) are preserved, so a
// subsequent `profile resume` brings the same containers back.
//
// Stop, not down. `docker compose down` removes containers and forfeits the
// writable overlay; `stop` is the right verb for "park this for later".

import { existsSync } from "node:fs";

import type { ProfileQuitArgs } from "../argv.js";
import { loadConfig } from "../arianna-config.js";
import { profileDir, profileOverridePath, type PathOpts } from "../paths.js";
import { assertValidProfileName, PROFILE_NAME_RE } from "../profile.js";
import type { CloneExecFn } from "./_profile-clone-helpers.js";

export class ProfileQuitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileQuitError";
  }
}

export interface ProfileQuitDeps extends PathOpts {
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /** Run a shell command. Production: promisify(child_process.exec). */
  exec: CloneExecFn;
  /** Test seam — defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * TTY detection. Defaults to `() => process.stdin.isTTY ?? false`.
   * The confirmation prompt is interactive only when this returns true.
   */
  isTTY?: () => boolean;
  /**
   * Test seam for the y/N prompt. Returns the raw value typed by the user.
   * Production reads from stdin via readline.
   */
  prompt?: (label: string) => Promise<string>;
}

export async function runProfileQuit(
  args: ProfileQuitArgs,
  deps: ProfileQuitDeps,
): Promise<number> {
  // Defense-in-depth — the argv parser already validated, but the name is
  // about to be interpolated into a docker compose shell command.
  assertValidProfileName(args.name);
  if (!PROFILE_NAME_RE.test(args.name)) {
    throw new ProfileQuitError(
      `Profile name "${args.name}" contains characters that would not be safe to interpolate into a shell command.`,
    );
  }

  const cfg = loadConfig(deps);
  const dir = profileDir(args.name, deps);
  const inConfig = cfg.profiles.has(args.name);
  if (!inConfig && !existsSync(dir)) {
    throw new ProfileQuitError(
      `No such profile "${args.name}" — not in ~/.arianna/config and no workspace dir.`,
    );
  }

  const overridePath = profileOverridePath(args.name, deps);
  if (!existsSync(overridePath)) {
    throw new ProfileQuitError(
      `Profile "${args.name}" has no compose.override.yml at ${overridePath}. ` +
        `Run \`arianna profile create ${args.name}\` first or restore the override.`,
    );
  }

  if (!args.yes) {
    if (!isInteractive(deps)) {
      throw new ProfileQuitError(
        `Refusing to quit profile in a non-TTY environment without --yes.`,
      );
    }
    const ask = deps.prompt ?? defaultPrompt;
    const ans = (
      await ask(
        `Quit profile "${args.name}"? Containers will stop. ` +
          `Conversation state preserved. [y/N] `,
      )
    )
      .trim()
      .toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      deps.write("Aborted.\n");
      return 1;
    }
  }

  // Idempotent: list any running services for this project. If none, we're
  // already stopped — print and exit 0 without bothering docker further.
  // If the ps probe ITSELF fails (docker daemon offline, project never
  // started, file syntax issue), we don't know the state. Falling through
  // to `stop` is the safer default: stop on a never-started project is a
  // no-op, and stop on a running project does the right thing.
  const projectName = `arianna-${args.name}`;
  const composeBase =
    `docker compose -p ${projectName} ` +
    `-f docker-compose.yml -f ${composeOverrideRelPath(args.name)}`;

  let psSucceeded = false;
  let runningServices = "";
  try {
    const { stdout } = await deps.exec(`${composeBase} ps --services --filter status=running`);
    runningServices = stdout.trim();
    psSucceeded = true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    deps.warn?.(
      `warn: docker compose ps for ${projectName} failed: ${msg.split("\n")[0]}\n`,
    );
  }

  if (psSucceeded && runningServices.length === 0) {
    deps.write(
      `Profile "${args.name}" is already stopped (no running services).\n`,
    );
    return 0;
  }

  // SIGTERM with 10s timeout. Existing /chat HTTP connections will be
  // aborted when the vessel container shuts down — documented in the
  // help text.
  try {
    await deps.exec(`${composeBase} stop -t 10`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    deps.warn?.(`error: docker compose stop failed: ${msg.split("\n")[0]}\n`);
    return 1;
  }

  deps.write(
    `Profile "${args.name}" stopped. ` +
      `Resume with \`arianna --profile ${args.name} profile resume\`.\n`,
  );
  return 0;
}

function isInteractive(deps: ProfileQuitDeps): boolean {
  if (deps.isTTY) return deps.isTTY();
  return Boolean(process.stdin.isTTY);
}

async function defaultPrompt(label: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(label);
  } finally {
    rl.close();
  }
}

// The compose override path relative to repo root — what we want to pass to
// `docker compose -f`. Mirrors the daemon's `composeBaseCommand` which keeps
// paths repo-relative so the command is shorter and cwd-stable.
function composeOverrideRelPath(name: string): string {
  return `workspace/profiles/${name}/compose.override.yml`;
}
