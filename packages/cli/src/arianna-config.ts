import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import { ariannaConfigPath, type PathOpts } from "./paths.js";
import { assertValidProfileName } from "./profile.js";

export interface ProfileEntry {
  /** 0..99. Maps to vessel:3000+N, sidecar:8000+N, daemon:9000+N. */
  portOffset: number;
  /** unix ms. Informational only. */
  createdAt?: number;
}

export interface AriannaConfig {
  /** Default profile name, or null when no default is set. */
  defaultProfile: string | null;
  /** Map of profile name → entry. Iteration order matches insertion order. */
  profiles: Map<string, ProfileEntry>;
}

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
const KV_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const COMMENT_RE = /^\s*[#;]/;

// Parses our slice of the AWS-CLI config format:
//
//   [default]
//   profile = alpha
//
//   [profile alpha]
//   port_offset = 0
//   created_at = 1714603200000
//
// Unknown sections and keys are tolerated (skipped); we don't aim for a
// general INI parser, just the subset we own.
export function parseConfig(text: string): AriannaConfig {
  const cfg: AriannaConfig = { defaultProfile: null, profiles: new Map() };
  let section: { kind: "default" | "profile" | "other"; name?: string } = { kind: "other" };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || COMMENT_RE.test(line)) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      const header = sectionMatch[1].trim();
      if (header === "default") {
        section = { kind: "default" };
      } else if (header.startsWith("profile ")) {
        const name = header.slice("profile ".length).trim();
        if (!name) {
          section = { kind: "other" };
          continue;
        }
        // Tolerate an invalid name in an existing config rather than throwing
        // — but skip its entries so we don't expose them through the resolver.
        try {
          assertValidProfileName(name);
          if (!cfg.profiles.has(name)) cfg.profiles.set(name, { portOffset: 0 });
          section = { kind: "profile", name };
        } catch {
          section = { kind: "other" };
        }
      } else {
        section = { kind: "other" };
      }
      continue;
    }

    const kvMatch = KV_RE.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const value = kvMatch[2];

    if (section.kind === "default" && key === "profile") {
      // Validate but don't throw — bad value just clears the default.
      try {
        cfg.defaultProfile = assertValidProfileName(value);
      } catch {
        cfg.defaultProfile = null;
      }
    } else if (section.kind === "profile" && section.name) {
      const entry = cfg.profiles.get(section.name)!;
      if (key === "port_offset") {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0 && n <= 99) entry.portOffset = n;
      } else if (key === "created_at") {
        const n = Number(value);
        if (Number.isInteger(n) && n > 0) entry.createdAt = n;
      }
    }
  }

  return cfg;
}

export function serializeConfig(cfg: AriannaConfig): string {
  const lines: string[] = [];
  lines.push("[default]");
  if (cfg.defaultProfile) {
    lines.push(`profile = ${cfg.defaultProfile}`);
  }
  for (const [name, entry] of cfg.profiles) {
    lines.push("");
    lines.push(`[profile ${name}]`);
    lines.push(`port_offset = ${entry.portOffset}`);
    if (entry.createdAt) lines.push(`created_at = ${entry.createdAt}`);
  }
  return lines.join("\n") + "\n";
}

export function loadConfig(opts: PathOpts = {}): AriannaConfig {
  const path = ariannaConfigPath(opts);
  if (!existsSync(path)) {
    return { defaultProfile: null, profiles: new Map() };
  }
  return parseConfig(readFileSync(path, "utf-8"));
}

// Atomic write: tmpfile + rename. Avoids torn reads if a second process
// grabs the file mid-update.
export function saveConfig(cfg: AriannaConfig, opts: PathOpts = {}): void {
  const path = ariannaConfigPath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, serializeConfig(cfg));
  renameSync(tmp, path);
}
