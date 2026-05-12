import {
  parseArgv,
  ArgvError,
  resolveTalkMessage,
  TALK_STDIN_LIMIT_BYTES,
} from "./argv.js";
import { InvalidProfileNameError } from "./profile.js";
import { resolveConfig } from "./config.js";
import { runTalk } from "./commands/talk.js";
import { runEvents } from "./commands/events.js";
import { runProfile, ProfileCommandError } from "./commands/profile.js";
import { ProfileImportCommandError } from "./commands/profile-import.js";
import { ProfileSaveError } from "./commands/profile-save.js";
import { ProfileRestoreError } from "./commands/profile-restore.js";
import { ProfileQuitError } from "./commands/profile-quit.js";
import { ProfileResumeError } from "./commands/profile-resume.js";
import { ProfileFixError } from "./commands/profile-fix.js";
import { ProfileFixPairingsError } from "./commands/profile-fix-pairings.js";
import { ProfileSnapshotOverlayError } from "./commands/profile-snapshot-overlay.js";
import { SessionConfigError } from "./session-config.js";
import { runFork, ForkError } from "./commands/fork.js";
import { runManifesto, ManifestoCommandError } from "./commands/manifesto.js";
import { runMap, MapCommandError } from "./commands/map.js";
import { runSwitch, SwitchCommandError } from "./commands/switch.js";
import {
  runGraduate,
  GraduateCommandError,
  GraduateNotReadyError,
} from "./commands/graduate.js";
import { runAbortTest, AbortTestError } from "./commands/abort-test.js";
import { runStatus, StatusCommandError } from "./commands/status.js";
import { runBootstrap, BootstrapCommandError } from "./commands/bootstrap.js";
import { VesselUnreachableError } from "./bootstrap.js";
import { runDaemon, DaemonCommandError } from "./commands/daemon.js";
import {
  NoProfileResolvedError,
  ImplicitDefaultBlockedError,
} from "./profile-resolver.js";
import { PortAllocationError } from "./port-allocator.js";
import { fstatSync } from "node:fs";

const HELP = `arianna — Docker-incubated AI control surface

Usage:
  arianna [--profile <name>] talk "<message>" [--sender <name>]
  <something> | arianna [--profile <name>] talk [--sender <name>]
  arianna [--profile <name>] events [--follow]
  arianna [--profile <name>] manifesto [section]
  arianna [--profile <name>] map [--tree | --json]
  arianna [--profile <name>] switch <snapshot-id>
  arianna [--profile <name>] graduate [--out PATH]
  arianna [--profile <name>] abort-test
  arianna [--profile <name>] status
  arianna [--profile <name>] bootstrap [--seed-from-jsonl <path>] [--no-prelude] [--use-daemon]
  arianna profile list
  arianna profile create <name> [flags]
  arianna profile use <name>
  arianna profile current
  arianna profile delete <name> [--force] [--yes] [--skip-docker]
  arianna profile import <name> <path> [--format openclaw|pi]
                                       [--provider <id>] [--model <id>]
                                       [--api-key <key>] [--ai-name <name>]
  arianna profile save <name> [--out PATH]
  arianna profile restore <tarball> [--name <new-name>]
  arianna [--profile <name>] profile quit [--yes]
  arianna [--profile <name>] profile resume
  arianna profile fix [name] [--dry-run]
  arianna profile fix-pairings <name> [--dry-run]
  arianna fork <src> <dst>
  arianna daemon start | stop | status
  arianna --version
  arianna --help

Global flags:
  --profile, -p <name>   Profile to target (validated: ^[a-z][a-z0-9-]{0,30}$).
                         Falls back to ARIANNA_PROFILE env, then ~/.arianna/config.
  --help, -h             Show this help.
  --version, -V          Print version.

profile create flags (all optional — when ANY is given the command also writes
                      workspace/profiles/<name>/session_config.json):
  --provider <id>          One of: google | anthropic | openai | openrouter
  --model <id>             Model id (provider-specific, e.g. gemini-2.5-flash)
  --api-key <key>          External LLM API key (mutually exclusive with --api-key-env)
  --api-key-env <VAR>      Read the API key from the named environment variable
  --ai-name <name>         Player-facing AI display name
  --ai-username <name>     Optional override; derived from --ai-name when omitted
  --cadence <human|agent>  Default: human

Commands:
  talk       POST a message to the vessel and stream the response to stdout.
  events     Stream sidecar events (memory state, bookmarks, Filo turns) as
             one-line JSON. Use --follow to keep the stream open.
  manifesto  Render the Life of Intelligence manifesto with in-game gating
             (locked sections show as ⋯). Pass [section] to filter to one id.
  map        Render the snapshot DAG for the active session as ASCII tree
             (--tree, default) or raw JSON (--json). Plain text on stdout —
             pipe into 'arianna talk' to feed history into the vessel.
  switch     POST daemon /restore for the given snapshot id. Daemon errors
             surface verbatim (snapshot not found, daemon unreachable, …).
  graduate   Bundle the AI's home + manifest into a tarball. Gated on §2.2
             (matches the in-game /graduate). --out PATH overrides default.
  abort-test v25 operator-rescue: end the in-flight graduation test for a
             sandbox-locked vessel. POSTs sidecar /admin/abort-test (does
             NOT go through the daemon — sidecarBaseUrl already encodes the
             active profile). Idempotent no-op when no test is running. The
             attempt counter accumulates: the next /graduate continues at
             attemptCount+1 with a fresh tokenX/tokenY pair. AI-self path
             (preferred): '/bin/send /abort-test' from inside the vessel.
  status     Multi-line dashboard: profile, model, daemon/vessel/sidecar
             health, memory indicator, fired bookmarks, graduation gate.
  bootstrap  Explicit, idempotent vessel bootstrap. By default auto-injects
             the Filo opening prelude (same wording the TUI shows on first
             turn) into the profile's imported-messages.jsonl, so headless
             incubations wake the AI as a vessel partner instead of a stock
             assistant. --seed-from-jsonl <path> overrides the prelude with
             a pi-coding-agent / OpenClaw JSONL session (driver carry-over).
             --no-prelude opts out of the auto-injection (truly empty start).
             --use-daemon forces docker compose up -d to run via the host
             daemon (POST /compose-up) instead of the local docker binary;
             use this from inside an OpenClaw dev container that has the
             arianna repo cloned but no docker installed. When omitted, the
             route is auto-detected via 'docker --version'.
  profile    Manage profiles (per-stack workspace + port allocation).
  fork       Full clone of an existing profile (docker tag retag + state
             copy + fresh sessionId).
  daemon     Lifecycle for the shared host daemon at 127.0.0.1:9000.

Endpoints (env-overridable):
  VESSEL_BASE_URL   default http://{host}:{3000+offset}
  SIDECAR_BASE_URL  default http://{host}:{8000+offset}
  DAEMON_BASE_URL   default http://127.0.0.1:9000 (single shared loopback daemon)
                    {host} = 127.0.0.1 when local docker is on PATH,
                    host.docker.internal otherwise (e.g. inside an OpenClaw
                    container — same auto-detect as the /compose-up route).
`;

/** Subset of `fs.Stats` that the classifier needs. Lets tests fake fstat
 *  without constructing a full Stats instance. */
export interface StdinFdStats {
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
  isFIFO(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
}

export interface StdinClassifierDeps {
  /** `process.stdin.isTTY` — `true` only when stdin is a real terminal. */
  isTTY: boolean | undefined;
  /** Sync fstat on fd 0. Returns `null` when fstat fails (closed fd, sandbox). */
  fstat: () => StdinFdStats | null;
}

/**
 * Synchronous classifier for stdin used by `resolveTalkMessage` to decide
 * whether to attempt a read at all. Distinguishes content-bearing fds (real
 * pipes, file redirects, sockets) from non-content fds (TTYs, /dev/null,
 * other character devices). Same semantics on macOS and Linux — fstat fd
 * types are POSIX-portable for the kinds we care about.
 *
 * Why fstat instead of "is non-TTY": background tasks, ssh non-interactive
 * sessions, and `< /dev/null` redirects all give the process a non-TTY stdin
 * with no actual content. Treating those as "piped" produced a spurious
 * "talk takes either a positional message OR stdin, not both" error
 * (testplay-004 finding; first-hand observation by an orchestrator agent
 * sending a recovery message from a bg task).
 */
export function classifyStdin(deps: StdinClassifierDeps): boolean {
  if (deps.isTTY === true) return false;
  const stat = deps.fstat();
  // fstat on fd 0 should not realistically fail. If it does (sandbox
  // weirdness, fd already closed elsewhere), be conservative: trust the
  // positional path. Erring "no content" is recoverable; erring "has
  // content" would resurrect the bug we're fixing.
  if (stat === null) return false;
  // Char devices (TTYs that didn't set isTTY for some reason, /dev/null,
  // /dev/zero, etc.) and block devices are never piped content.
  if (stat.isCharacterDevice() || stat.isBlockDevice()) return false;
  // FIFOs (pipes), regular files (file redirects), and sockets are the
  // shapes a content-bearing stdin can take. An empty pipe still reports
  // `true` here — `resolveTalkMessage` drains and treats zero bytes as
  // "no piped content," which is the behaviour bg-task callers want.
  return stat.isFIFO() || stat.isFile() || stat.isSocket();
}

/** Production wiring: classify the real fd 0 via Node's fstatSync. */
export function stdinHasPipedContent(): boolean {
  return classifyStdin({
    isTTY: process.stdin.isTTY,
    fstat: () => {
      try {
        return fstatSync(0);
      } catch {
        return null;
      }
    },
  });
}

export async function readStdinCapped(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limitBytes) {
      throw new ArgvError(
        `talk: piped stdin exceeds ${limitBytes}-byte cap`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readVersion(): Promise<string> {
  // package.json sits two levels up from dist/index.js (dist/ -> package root).
  const pkgUrl = new URL("../package.json", import.meta.url);
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(pkgUrl, "utf-8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

export async function main(rawArgv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(rawArgv);
  } catch (err) {
    if (err instanceof InvalidProfileNameError || err instanceof ArgvError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (parsed.command === "help" || parsed.global.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (parsed.command === "version") {
    process.stdout.write((await readVersion()) + "\n");
    return 0;
  }

  // `profile` subcommands manage the profile system itself, so they don't
  // need (or want) network resolution to run first.
  if (parsed.command === "profile") {
    // `delete` + `save` + `restore` + `import` shell out to docker/tar; wire
    // exec lazily so the other subcommands (list/use/current) don't pay for
    // the child_process import when not needed.
    const cp = await import("node:child_process");
    const util = await import("node:util");
    const execAsync = util.promisify(cp.exec);
    try {
      return await runProfile(parsed.profile!, {
        write: (line) => process.stdout.write(line),
        warn: (line) => process.stderr.write(line),
        exec: async (cmd) => {
          // 64 MB buffer comes from master's profile-save/restore work — tar
          // outputs can spill past the default 1 MB. profile delete's docker
          // compose down output is much smaller; the larger ceiling is
          // harmless there.
          const r = await execAsync(cmd, { maxBuffer: 64 * 1024 * 1024 });
          return { stdout: String(r.stdout), stderr: String(r.stderr) };
        },
        execWithEnv: async (cmd, opts) => {
          const r = await execAsync(cmd, {
            maxBuffer: 64 * 1024 * 1024,
            env: opts?.env,
          });
          return { stdout: String(r.stdout), stderr: String(r.stderr) };
        },
        // Gap 12: wire fetch so cmdCreate's daemon-route fallback can POST
        // /profile-create when local docker is missing (OpenClaw container
        // case) or `--use-daemon` was passed.
        fetch: globalThis.fetch,
      });
    } catch (err) {
      if (
        err instanceof ProfileCommandError ||
        err instanceof ProfileImportCommandError ||
        err instanceof ProfileSaveError ||
        err instanceof ProfileRestoreError ||
        err instanceof ProfileQuitError ||
        err instanceof ProfileResumeError ||
        err instanceof ProfileFixError ||
        err instanceof ProfileFixPairingsError ||
        err instanceof ProfileSnapshotOverlayError ||
        err instanceof PortAllocationError ||
        err instanceof InvalidProfileNameError ||
        err instanceof NoProfileResolvedError ||
        err instanceof ImplicitDefaultBlockedError ||
        err instanceof SessionConfigError
      ) {
        process.stderr.write(`error: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }

  if (parsed.command === "daemon") {
    try {
      return await runDaemon(parsed.daemon!, {
        write: (line) => process.stdout.write(line),
        warn: (line) => process.stderr.write(line),
      });
    } catch (err) {
      if (err instanceof DaemonCommandError) {
        process.stderr.write(`error: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }

  if (parsed.command === "fork") {
    const cp = await import("node:child_process");
    const util = await import("node:util");
    const execAsync = util.promisify(cp.exec);
    try {
      return await runFork(parsed.fork!, {
        exec: async (cmd) => {
          const r = await execAsync(cmd);
          return {
            stdout: String(r.stdout),
            stderr: String(r.stderr),
          };
        },
        write: (line) => process.stdout.write(line),
        warn: (line) => process.stderr.write(line),
      });
    } catch (err) {
      if (
        err instanceof ForkError ||
        err instanceof PortAllocationError ||
        err instanceof InvalidProfileNameError
      ) {
        process.stderr.write(`error: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }

  let config;
  try {
    config = resolveConfig({ profile: parsed.global.profile });
  } catch (err) {
    if (
      err instanceof InvalidProfileNameError ||
      err instanceof ImplicitDefaultBlockedError
    ) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  switch (parsed.command) {
    case "talk": {
      let message: string;
      try {
        message = await resolveTalkMessage(parsed.talk!, {
          stdinHasPipedContent,
          readStdin: () => readStdinCapped(process.stdin, TALK_STDIN_LIMIT_BYTES),
        });
      } catch (err) {
        if (err instanceof ArgvError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 2;
        }
        throw err;
      }
      const result = await runTalk(
        { message, sender: parsed.talk!.sender },
        config,
        {
          fetch: globalThis.fetch,
          write: (chunk) => process.stdout.write(chunk),
          warn: (line) => process.stderr.write(line),
        },
      );
      if (result.graduationLocked) {
        // v25 driver-silence-during-test: the pre-flight check found the
        // graduation test in flight. Refuse to deliver the player message
        // — driver coaching during the test taints the graduation. The
        // AI completes the test on her own, OR self-invokes /abort-test
        // via /bin/send, OR an operator can rescue with `arianna abort-
        // test <profile>` for sandbox-locked vessels.
        const attempt = result.graduationLocked.attemptCount
          ? ` (attempt ${result.graduationLocked.attemptCount})`
          : "";
        process.stderr.write(
          `graduation test in flight${attempt} — host messaging is locked. ` +
            `AI must complete the test, /bin/send /abort-test (AI self-recovery), ` +
            `or operator can run \`arianna abort-test\` for a wedged vessel. ` +
            `Use \`arianna events --follow\` to watch for graduation_lockout_ended.\n`,
        );
        return 75; // EX_TEMPFAIL — same exit class as the existing busy gate
      }
      if (result.status === 409) {
        // Disambiguate Filo composing vs real player work in flight. The
        // Filo path (interaction_paused) holds the chat lock for seconds
        // while Filo's external_message gets typed and the AI replies —
        // there's no real work to retry, the caller just needs to wait for
        // `arianna events` to surface `interaction_resumed`. The legacy
        // "vessel busy — try again" string is preserved when pausedBy is
        // absent or "player" (older vessel, or actual player concurrency).
        const msg =
          result.pausedBy === "filo"
            ? "vessel paused — Filo is composing, wait for interaction_resumed and retry\n"
            : "vessel busy — try again\n";
        process.stderr.write(msg);
        return 75; // EX_TEMPFAIL
      }
      // Trailing newline so the prompt lands on its own line.
      if (result.responseText && !result.responseText.endsWith("\n")) {
        process.stdout.write("\n");
      }
      return 0;
    }
    case "bootstrap": {
      // Wire exec lazily — bootstrap auto-ups the docker compose stack when
      // it's not already running (canary acb7b292 fix). The dispatcher pays
      // the child_process import cost only when bootstrap is the active
      // subcommand.
      const cp = await import("node:child_process");
      const util = await import("node:util");
      const execAsync = util.promisify(cp.exec);
      try {
        return await runBootstrap(
          config,
          {
            fetch: globalThis.fetch,
            write: (line) => process.stdout.write(line),
            warn: (line) => process.stderr.write(line),
            exec: async (cmd, opts) => {
              const r = await execAsync(cmd, {
                maxBuffer: 64 * 1024 * 1024,
                env: opts?.env,
              });
              return { stdout: String(r.stdout), stderr: String(r.stderr) };
            },
          },
          parsed.bootstrap ?? {},
        );
      } catch (err) {
        if (err instanceof BootstrapCommandError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 1;
        }
        if (err instanceof VesselUnreachableError) {
          // Cold-start probe budget exhausted, or transport failure after the
          // compose-up succeeded. Print the actionable message instead of
          // letting the bin/arianna.js top-level handler surface a misleading
          // bare `error: fetch failed` (canary-003, Sif's run, 2026-05-09).
          process.stderr.write(`error: ${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    case "events": {
      const ac = new AbortController();
      const onSig = () => ac.abort();
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);
      try {
        await runEvents(parsed.events!, config, {
          fetch: globalThis.fetch,
          write: (line) => process.stdout.write(line),
          onParseError: (raw) =>
            process.stderr.write(`warn: bad SSE payload: ${raw}\n`),
          signal: ac.signal,
        });
        return 0;
      } catch (err) {
        if ((err as Error).name === "AbortError") return 0;
        throw err;
      } finally {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
      }
    }
    case "manifesto": {
      try {
        return await runManifesto(parsed.manifesto!, config, {
          fetch: globalThis.fetch,
          write: (line) => process.stdout.write(line),
        });
      } catch (err) {
        if (err instanceof ManifestoCommandError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    case "map": {
      try {
        return runMap(parsed.map!, config, {
          write: (line) => process.stdout.write(line),
        });
      } catch (err) {
        if (err instanceof MapCommandError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    case "switch": {
      // Wire exec lazily so the personalization pre-check (Iko revival fix,
      // 2026-05-09) can shell out to docker without forcing the import on
      // every CLI invocation.
      const cp = await import("node:child_process");
      const util = await import("node:util");
      const execAsync = util.promisify(cp.exec);
      try {
        return await runSwitch(parsed.switch!, config, {
          fetch: globalThis.fetch,
          write: (line) => process.stdout.write(line),
          warn: (line) => process.stderr.write(line),
          exec: async (cmd) => {
            const r = await execAsync(cmd, { maxBuffer: 1024 * 1024 });
            return { stdout: String(r.stdout), stderr: String(r.stderr) };
          },
        });
      } catch (err) {
        if (err instanceof SwitchCommandError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    case "graduate": {
      try {
        return await runGraduate(parsed.graduate!, config, {
          fetch: globalThis.fetch,
          write: (line) => process.stdout.write(line),
        });
      } catch (err) {
        if (err instanceof GraduateNotReadyError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 3; // distinct exit code so callers can detect "not ready" vs other failures
        }
        if (err instanceof GraduateCommandError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    case "status": {
      try {
        return await runStatus(config, {
          fetch: globalThis.fetch,
          write: (line) => process.stdout.write(line),
        });
      } catch (err) {
        if (err instanceof StatusCommandError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    case "abort-test": {
      try {
        await runAbortTest(config, {
          fetch: globalThis.fetch,
          write: (line) => process.stdout.write(line),
          warn: (line) => process.stderr.write(line),
        });
        // Idempotent success: both "actually aborted" and "nothing was in
        // flight" return 0, matching Unix convention for an operation that
        // ensures a state. Scripts that need to differentiate the two
        // cases parse the stdout line (or the JSON shape on the wire).
        // EX_TEMPFAIL would mis-signal "retry later" for the no-op case.
        return 0;
      } catch (err) {
        if (err instanceof AbortTestError) {
          process.stderr.write(`error: ${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
  }
}

// bin/arianna.js calls main() explicitly. We don't auto-invoke here so that
// the module is also safely importable from tests and other JS consumers.
