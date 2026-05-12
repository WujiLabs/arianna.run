// Crash store — persists vessel crash reports posted to /vessel-crash and
// exposes them to /graduation-state. Each crash is one line in a JSONL file,
// which keeps writes append-only (no read-modify-write race) and lets the
// /graduation-state response slice the tail without parsing the whole file
// when it grows.
//
// API-key redaction runs again on receipt (defense-in-depth). The vessel-side
// helper (`bin/report-crash.mjs`) is the primary defense — by the time the
// payload lands here the leak window is already closed — but a second pass
// catches anything the vessel might have missed if the regex evolves.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import type { VesselCrashReport } from "@arianna/types";

/** Cap returned recent crashes — keeps /graduation-state response small. */
export const RECENT_CRASHES_LIMIT = 10;

/**
 * Redacts API-key-shaped tokens from a stderr blob. Conservative: matches
 * common env-var leak shapes plus bare provider tokens (sk-…, sk_test_…, etc).
 *
 * Pattern coverage:
 *   - `*_KEY=...`, `*_TOKEN=...`, `*_SECRET=...`, `*_PASSWORD=...`, `*_PASSWD=...`
 *     (uppercase env-var convention; covers API_KEY, ANTHROPIC_API_KEY,
 *     OPENROUTER_API_KEY, GH_TOKEN, AWS_SECRET, DB_PASSWORD, etc.)
 *   - `Authorization: Bearer ...` headers (with token swallowed)
 *   - Provider token shapes: `sk-...`, `sk_live_...`, `sk_test_...`, `sk-ant-...`
 *   - JWTs: `eyJ...` three-part dotted base64
 *   - AWS access keys: `AKIA[0-9A-Z]{16}` and `ASIA[0-9A-Z]{16}` (STS)
 *
 * Each match is replaced with `<redacted>`. The function is exported so the
 * vessel helper, the sidecar handler, and tests can share the same regex.
 *
 * Tradeoff: we're deliberately broad on the env-var suffix list. A false
 * positive (e.g. some app-specific `LOOKUP_KEY=user_42` gets redacted) is
 * cheap; a missed leak isn't.
 */
export function redactSecrets(input: string): string {
  return input
    // KEY/TOKEN/SECRET/PASSWORD env-var forms. Stops at whitespace, quote,
    // backtick, or end-of-line so we don't eat the rest of the message.
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*=\s*[^\s"'`]+/g,
      "$1=<redacted>",
    )
    // Authorization: Bearer ...
    .replace(
      /\b(Authorization\s*:\s*Bearer)\s+\S+/gi,
      "$1 <redacted>",
    )
    // Provider token shapes (sk-..., sk_live_..., sk-ant-..., etc).
    // Min length 12 of post-prefix chars to avoid accidentally eating
    // `sk-foo` literals in error messages.
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "<redacted>")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{12,}/g, "<redacted>")
    // AWS access keys: AKIA prefix (long-lived), ASIA prefix (STS / temporary).
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted>")
    // JWTs: three base64url chunks separated by dots, header begins with `eyJ`.
    // Lower-bound the segment length to dodge `eyJ.foo.bar` literals.
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "<redacted>",
    );
}

/**
 * Validates an inbound /vessel-crash payload. Returns a normalized
 * `VesselCrashReport` on success, or null when required fields are missing
 * or wrongly typed. This is a structural check; the redaction happens in a
 * separate step on the persisted report.
 */
export function parseCrashPayload(raw: unknown): VesselCrashReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.sessionId !== "string" || o.sessionId.length === 0) return null;
  if (typeof o.exitCode !== "number" || !Number.isFinite(o.exitCode)) return null;
  if (typeof o.stderrTail !== "string") return null;
  if (typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp)) return null;
  if (typeof o.respawnCountInWindow !== "number" || !Number.isFinite(o.respawnCountInWindow)) {
    return null;
  }
  return {
    sessionId: o.sessionId,
    exitCode: o.exitCode | 0,
    stderrTail: o.stderrTail,
    timestamp: o.timestamp,
    respawnCountInWindow: Math.max(1, o.respawnCountInWindow | 0),
  };
}

export class CrashStore {
  private readonly path: string;

  constructor(stateDir: string, fileName = "vessel-crashes.jsonl") {
    mkdirSync(stateDir, { recursive: true });
    this.path = `${stateDir}/${fileName}`;
  }

  /**
   * Append one crash record. The stderr tail is re-redacted on the way in;
   * the line is JSON-serialized and terminated with a newline so we never
   * have to read the whole file to write.
   *
   * Returns the persisted record (with redaction applied).
   */
  record(report: VesselCrashReport): VesselCrashReport {
    const sanitized: VesselCrashReport = {
      ...report,
      stderrTail: redactSecrets(report.stderrTail),
    };
    appendFileSync(this.path, JSON.stringify(sanitized) + "\n");
    return sanitized;
  }

  /**
   * Read the last `limit` crashes (most-recent last). Tolerant of malformed
   * lines: a partial write or hand-edited line is skipped, never throws.
   * Used by /graduation-state and (in tests) by the cursor diff.
   */
  recent(limit = RECENT_CRASHES_LIMIT): VesselCrashReport[] {
    if (!existsSync(this.path)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const tail = lines.slice(-limit);
    const out: VesselCrashReport[] = [];
    for (const line of tail) {
      try {
        const parsed = parseCrashPayload(JSON.parse(line));
        if (parsed) out.push(parsed);
      } catch {
        // skip malformed line
      }
    }
    return out;
  }
}
