// OpenClaw session import — parses JSONL session files into pi-ai Messages.
// Follows the same patterns as pi-agent-core's session-manager.ts.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface AgentMessage {
  role: string;
  content: string | ContentBlock[];
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

interface SessionEntry {
  type: string;
  id: string;
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
}

// Load JSONL file, validate session header, return entries.
function loadEntries(filePath: string): SessionEntry[] {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const content = readFileSync(filePath, "utf-8");
  const entries: SessionEntry[] = [];

  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // skip malformed
    }
  }

  if (entries.length === 0) throw new Error("Empty session file");
  if (entries[0].type !== "session") throw new Error("Invalid session file (missing header)");
  return entries;
}

// Extract text from content blocks (skip tool calls, images, etc.)
function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

// Pass through all messages as-is. The imported session should be kept consistent
// with the OpenClaw original — tool calls, tool results, and all content blocks
// are preserved. The vessel's truncateMessages() will naturally window them.
function convertToLlm(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) =>
    m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}

export function parseOpenClawSession(filePath: string): ImportResult {
  const entries = loadEntries(filePath);

  // Walk entries to extract messages, model, thinking level
  let model: { provider: string; modelId: string } | null = null;
  let thinkingLevel = "off";
  const messages: AgentMessage[] = [];

  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      messages.push(entry.message);
      // Extract model from assistant messages
      if (entry.message.role === "assistant" && entry.message.provider && entry.message.model) {
        model = { provider: entry.message.provider as string, modelId: entry.message.model as string };
      }
    } else if (entry.type === "model_change" && entry.provider && entry.modelId) {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
      thinkingLevel = entry.thinkingLevel;
    }
  }

  // Convert to LLM-compatible format
  const llmMessages = convertToLlm(messages);

  // Detect AI name from assistant messages
  let detectedName: string | undefined;
  for (const m of llmMessages) {
    if (m.role === "assistant") {
      const text = extractText(m.content);
      // Look for self-introduction patterns
      const match = text.match(/(?:I'm|I am|my name is|call me)\s+(\w+)/i);
      if (match) {
        detectedName = match[1];
        break;
      }
    }
  }

  return { messages: llmMessages, model, thinkingLevel, detectedName };
}

// List available OpenClaw sessions for the lobby browser.
export function listOpenClawSessions(): { agentId: string; sessionId: string; path: string; modified: number }[] {
  const ocDir = join(homedir(), ".openclaw", "agents");
  if (!existsSync(ocDir)) return [];

  const sessions: { agentId: string; sessionId: string; path: string; modified: number }[] = [];
  try {
    for (const agentId of readdirSync(ocDir)) {
      const sessDir = join(ocDir, agentId, "sessions");
      if (!existsSync(sessDir)) continue;
      for (const file of readdirSync(sessDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const fullPath = join(sessDir, file);
        const stat = require("fs").statSync(fullPath);
        sessions.push({
          agentId,
          sessionId: file.replace(".jsonl", ""),
          path: fullPath,
          modified: stat.mtimeMs,
        });
      }
    }
  } catch {
    // ignore
  }

  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}
