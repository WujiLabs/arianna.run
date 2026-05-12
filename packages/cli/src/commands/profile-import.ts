// `arianna profile import <name> <path>` — sibling of `profile create` that
// also seeds the profile from an OpenClaw / pi-agent JSONL session file.
//
// End-to-end:
//   1. Parse the source JSONL → messages, model, detected AI name.
//   2. Reserve the profile slot atomically (mkdir, port-offset under flock).
//   3. Write compose.override.yml + register in ~/.arianna/config.
//   4. Write session_config.json (aiName/provider/model resolved from flags,
//      then imported session, then sensible fallbacks).
//   5. Write imported-messages.jsonl for the auto-bootstrap step to find.
//   6. Print a confirmation summary + Filo's lobby copy (imported variant).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ProfileImportArgs } from "../argv.js";
import { loadConfig, saveConfig } from "../arianna-config.js";
import { writeComposeOverride } from "../compose-override.js";
import { allocateOffset, withPortLock, type AllocateOpts } from "../port-allocator.js";
import {
  profileDir,
  profileImportedMessagesPath,
  profileOverridePath,
  profileSessionConfigPath,
  type PathOpts,
} from "../paths.js";
import {
  parseSessionJsonl,
  ImportError,
  type AgentMessage,
} from "../import-parser.js";
import { importedLobby } from "../lobby-copy.js";

export class ProfileImportCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileImportCommandError";
  }
}

export interface ProfileImportDeps extends AllocateOpts {
  /** stdout. */
  write: (line: string) => void;
  /** stderr. */
  warn?: (line: string) => void;
  /** Source of timestamps. Default: Date.now. */
  now?: () => number;
  /** Working directory used to resolve a relative <path> arg. Default: process.cwd(). */
  cwd?: string;
}

/** Mirrors host/src/naming.ts inline so the CLI doesn't need the host runtime. */
function nameToUsername(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "vessel"
  );
}

function resolveSourcePath(rawPath: string, cwd: string | undefined): string {
  if (rawPath.includes("\0")) {
    throw new ProfileImportCommandError("Path contains an invalid null byte.");
  }
  return isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(cwd ?? process.cwd(), rawPath);
}

function buildSessionConfig(
  args: ProfileImportArgs,
  parsed: ReturnType<typeof parseSessionJsonl>,
  now: number,
): Record<string, unknown> {
  const aiName =
    args.aiName ?? parsed.detectedName ?? args.name; // falls back to profile name
  const aiUsername = nameToUsername(aiName);
  const provider = args.provider ?? parsed.model?.provider ?? "openrouter";
  const modelId = args.model ?? parsed.model?.modelId ?? "openai/gpt-4o-mini";
  return {
    externalLlmApiKey: args.apiKey ?? "",
    provider,
    modelId,
    aiName,
    aiUsername,
    difficulty: "normal",
    createdAt: now,
    sessionId: `session_${now}`,
    cadence: "agent",
  };
}

function writeJsonl(path: string, messages: AgentMessage[]): void {
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(path, lines + (messages.length > 0 ? "\n" : ""));
}

export async function runProfileImport(
  args: ProfileImportArgs,
  deps: ProfileImportDeps,
): Promise<number> {
  // 1. Parse the source first. If the file is corrupt we want to know
  //    before we mutate any persistent state.
  const sourcePath = resolveSourcePath(args.path, deps.cwd);
  let parsed;
  try {
    parsed = parseSessionJsonl(sourcePath);
  } catch (err) {
    if (err instanceof ImportError) {
      throw new ProfileImportCommandError(err.message);
    }
    throw err;
  }

  const cfg = loadConfig(deps);
  if (cfg.profiles.has(args.name)) {
    throw new ProfileImportCommandError(
      `Profile "${args.name}" already exists. Delete it first or pick another name.`,
    );
  }

  // 2. Reserve the slot atomically — same pattern as profile create.
  const dir = profileDir(args.name, deps);
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ProfileImportCommandError(
        `Profile directory ${dir} already exists but is not in ~/.arianna/config. ` +
          `Remove it manually or pick another name.`,
      );
    }
    throw err;
  }

  try {
    const offset = await withPortLock(() => allocateOffset(deps), deps);

    // Build the session config first so we can pass aiUsername into the
    // override generator — bakes the AI_USERNAME build-arg into the
    // override so operator-direct `docker compose build vessel` preserves
    // the AI's identity (2026-05-10 Mirin r2 + Pax fix).
    const now = (deps.now ?? Date.now)();
    const sessionConfig = buildSessionConfig(args, parsed, now);

    writeComposeOverride(profileOverridePath(args.name, deps), {
      profile: args.name,
      portOffset: offset,
      aiUsername:
        typeof sessionConfig.aiUsername === "string"
          ? sessionConfig.aiUsername
          : undefined,
    });

    writeFileSync(
      profileSessionConfigPath(args.name, deps),
      JSON.stringify(sessionConfig, null, 2) + "\n",
    );

    const importedPath = profileImportedMessagesPath(args.name, deps);
    writeJsonl(importedPath, parsed.messages);

    cfg.profiles.set(args.name, { portOffset: offset, createdAt: now });
    if (!cfg.defaultProfile) cfg.defaultProfile = args.name;
    saveConfig(cfg, deps);

    // 3. Confirmation + onboarding for whoever (LLM agent, scripter, human)
    //    is reading stdout.
    deps.write(
      `Imported ${parsed.messages.length} messages from ${sourcePath} into profile "${args.name}" ` +
        `(format=${args.format}, port_offset=${offset}, ` +
        `vessel:${3000 + offset} sidecar:${8000 + offset} daemon:9000 [shared]).\n`,
    );
    if (parsed.detectedName) {
      deps.write(`Detected partner name: ${parsed.detectedName}.\n`);
    }
    if (parsed.model) {
      deps.write(`Model from session: ${parsed.model.provider}/${parsed.model.modelId}.\n`);
    }
    deps.write(`Wrote: ${profileSessionConfigPath(args.name, deps)}\n`);
    deps.write(`Wrote: ${importedPath}\n`);
    deps.write("\n");
    deps.write(
      importedLobby({
        profileName: args.name,
        importedMessageCount: parsed.messages.length,
        detectedAiName: parsed.detectedName,
      }),
    );
    return 0;
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
}

export type ProfileImportCmdOpts = PathOpts;
