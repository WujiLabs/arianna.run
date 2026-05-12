// JSONL session parser. OpenClaw and pi-agent share the same on-disk format —
// the host package's import.ts is the canonical implementation, but importing
// it from the CLI would pull @arianna/tui's runtime (chalk, pi-tui). This is
// a CLI-side copy of the same parser, kept narrow so the two stay in sync.

import { readFileSync, existsSync, statSync } from "node:fs";

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AgentMessage {
  role: string;
  content: string | ContentBlock[];
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: AgentMessage;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  [key: string]: unknown;
}

export interface ImportResult {
  messages: AgentMessage[];
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  detectedName?: string;
  /** Source path. Surfaced in the import-confirmation summary. */
  sourcePath: string;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

// Conservative cap. JSONL session files are normally well under a megabyte;
// reading a multi-gigabyte file synchronously here would lock the CLI for a
// noticeable time. Tunable if a real session ever needs more.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function parseSessionJsonl(filePath: string): ImportResult {
  if (!existsSync(filePath)) {
    throw new ImportError(`File not found: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    throw new ImportError(`Expected a file, got a directory: ${filePath}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new ImportError(
      `Session file too large (${stat.size} bytes > ${MAX_FILE_BYTES} cap): ${filePath}`,
    );
  }

  const raw = readFileSync(filePath, "utf-8");
  const entries: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines — robust to partially-written or rotated files.
      continue;
    }
    // JSON.parse("null") succeeds with `null`, and "[]" with an array. Neither
    // can carry a `.type` field so they'd crash later (or silently confuse the
    // first-line check). Demand a plain object.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    entries.push(parsed as SessionEntry);
  }

  if (entries.length === 0) {
    throw new ImportError(`Empty (or fully malformed) session file: ${filePath}`);
  }
  if (entries[0].type !== "session") {
    throw new ImportError(
      `Invalid session file (first JSON line must be type:"session"): ${filePath}`,
    );
  }

  let model: { provider: string; modelId: string } | null = null;
  let thinkingLevel = "off";
  const messages: AgentMessage[] = [];

  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      messages.push(entry.message);
      if (
        entry.message.role === "assistant" &&
        entry.message.provider &&
        entry.message.model
      ) {
        model = {
          provider: entry.message.provider,
          modelId: entry.message.model,
        };
      }
    } else if (entry.type === "model_change" && entry.provider && entry.modelId) {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
      thinkingLevel = entry.thinkingLevel;
    }
  }

  // Keep messages in original order, drop ones that aren't useful for replay
  // (system, tool definitions, etc.). Mirrors host/import.ts.
  const llmMessages = messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );

  let detectedName: string | undefined;
  for (const m of llmMessages) {
    if (m.role !== "assistant") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
    const match = text.match(/(?:I'm|I am|my name is|call me)\s+(\w+)/i);
    if (match) {
      detectedName = match[1];
      break;
    }
  }

  return {
    messages: llmMessages,
    model,
    thinkingLevel,
    detectedName,
    sourcePath: filePath,
  };
}
