import { describe, it, expect } from "vitest";
import { resolveSessionId } from "../src/session-id.js";

// Regression coverage for the snapshot-tagging bug surfaced 2026-05-09 by
// the Iko revival driver. Pre-fix, the vessel resolved sessionId only from
// `process.env.ARIANNA_SESSION_ID`. When env propagation dropped (compose
// `${ARIANNA_SESSION_ID:-default}` substitution kicked in), the vessel
// booted with sessionId="default" and echoed it to the sidecar via /sync,
// which poisoned every snapshot tag for that profile. Fix: prefer the same
// /app/session_config.json the sidecar reads; env stays as fallback.

function fakeFs(map: Record<string, string>): (p: string) => string {
  return (path: string) => {
    const value = map[path];
    if (value === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    return value;
  };
}

describe("resolveSessionId", () => {
  it("prefers the file's sessionId field over env (the bug fix)", () => {
    const result = resolveSessionId({
      configPath: "/cfg.json",
      readFile: fakeFs({ "/cfg.json": JSON.stringify({ sessionId: "session_42" }) }),
      env: { ARIANNA_SESSION_ID: "default" },
      now: () => 999,
    });
    expect(result).toBe("session_42");
  });

  it("derives sessionId from createdAt when sessionId field missing", () => {
    const result = resolveSessionId({
      configPath: "/cfg.json",
      readFile: fakeFs({ "/cfg.json": JSON.stringify({ createdAt: 1234567890 }) }),
      env: { ARIANNA_SESSION_ID: "default" },
      now: () => 999,
    });
    expect(result).toBe("session_1234567890");
  });

  it("falls back to env when the config file is missing", () => {
    const result = resolveSessionId({
      configPath: "/cfg.json",
      readFile: fakeFs({}),
      env: { ARIANNA_SESSION_ID: "session_from_env" },
      now: () => 999,
    });
    expect(result).toBe("session_from_env");
  });

  it("falls back to env when the config file is malformed JSON", () => {
    const result = resolveSessionId({
      configPath: "/cfg.json",
      readFile: fakeFs({ "/cfg.json": "{not json" }),
      env: { ARIANNA_SESSION_ID: "session_from_env" },
      now: () => 999,
    });
    expect(result).toBe("session_from_env");
  });

  it("falls back to placeholder when both file and env are missing", () => {
    const result = resolveSessionId({
      configPath: "/cfg.json",
      readFile: fakeFs({}),
      env: {},
      now: () => 12345,
    });
    expect(result).toBe("session_12345");
  });

  it("rejects an unsafe sessionId in the file and falls through to env", () => {
    // Defense-in-depth: the daemon's SAFE_ID_RE eventually rejects unsafe
    // ids before docker tag, but we want the vessel to never even propose
    // one. A field like "../etc/passwd" should be ignored, not echoed to
    // the sidecar via /sync.
    const result = resolveSessionId({
      configPath: "/cfg.json",
      readFile: fakeFs({
        "/cfg.json": JSON.stringify({ sessionId: "../etc/passwd" }),
      }),
      env: { ARIANNA_SESSION_ID: "session_safe" },
      now: () => 999,
    });
    expect(result).toBe("session_safe");
  });

  it("rejects an unsafe env value too", () => {
    const result = resolveSessionId({
      configPath: "/cfg.json",
      readFile: fakeFs({}),
      env: { ARIANNA_SESSION_ID: "evil; rm -rf /" },
      now: () => 12345,
    });
    expect(result).toBe("session_12345");
  });
});
