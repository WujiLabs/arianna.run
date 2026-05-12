import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// #214 regression: the Dockerfile's final CMD must invoke run.sh under bash,
// not sh.
//
// Why: #209 added a SIGUSR1 trap to run.sh using bash trap syntax. Alpine's
// busybox sh ignores `#!/bin/bash` shebangs when the script is exec'd as
// `sh run.sh` — the script runs under busybox ash, which doesn't register the
// trap. SIGUSR1 then does nothing (the operator's signal is silently dropped),
// the daemon's restart-via-signal path no-ops, and only a docker kill works.
//
// Bash is already installed in the image (apk add ... bash, see line ~85),
// so the only safe CMD is ["bash", "run.sh"]. This test pins that contract
// so a future "simplify Dockerfile" pass can't quietly break SIGUSR1 again.

const VESSEL_ROOT = resolve(__dirname, "..");
const DOCKERFILE_PATH = resolve(VESSEL_ROOT, "Dockerfile");

describe("#214: Dockerfile CMD must use bash", () => {
  it("CMD invokes run.sh via bash, not sh", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    // Find the final CMD line — only one CMD per Dockerfile is honored.
    const cmdLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("CMD "));
    expect(cmdLines.length).toBeGreaterThan(0);
    const finalCmd = cmdLines[cmdLines.length - 1];
    expect(finalCmd).toBe('CMD ["bash", "run.sh"]');
    // Negative assertion — explicit bait for the regression we're fixing.
    expect(finalCmd).not.toContain('"sh"');
  });

  it("bash is installed in the image (apk add line)", () => {
    // Defense in depth: if someone removes bash from `apk add` while keeping
    // the bash CMD, the container fails to start. Pin the install too.
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toMatch(/apk add[^\n]*\bbash\b/);
  });
});
