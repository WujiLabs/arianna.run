// Mandatory regression tests from the master eng-review test plan
// (~/.gstack/projects/arianna.run/cosimodw-master-eng-review-test-plan-20260506-222443.md).
//
// IRON RULE: any future change that breaks one of these must surface in CI
// before landing. The four mandatory regressions:
//
//   R1  Profile name `../foo` rejected — path-traversal blocked at the
//       CLI argv-parse boundary; same class as commit 3bcb2da.
//   R2  Daemon endpoint accepts `?profile=` param — refactor preserves
//       all existing snapshot/restore/session-delete behaviour.
//   R3  Daemon binds 127.0.0.1, NOT 0.0.0.0 — closes the
//       CLAUDE.md-documented unauth-on-public-iface known limitation.
//   R4  `arianna fork` rewrites sessionId in snapshot-histories — forked
//       profile reads only its own snapshots, not source's.
//
// R2 + R3 live in packages/host/test/regressions.test.ts (host package
// owns the daemon source). R1 + R4 live here in the cli package.

import { describe, it, expect, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgv } from "../src/argv.js";
import { isValidProfileName, InvalidProfileNameError } from "../src/profile.js";
import { runFork, VESSEL_REPO } from "../src/commands/fork.js";
import { runProfile } from "../src/commands/profile.js";
import { profileDir } from "../src/paths.js";

// ── R1: path-traversal in profile name ────────────────────────────────

describe("R1 — profile name regex blocks path traversal and shell injection", () => {
  // Each of these would, if accepted, give a path-traversal vector through
  // workspace/profiles/{name}/... or a shell-injection vector via
  // interpolation into docker / git / npm commands.
  const traversalAttempts = [
    "../foo",
    "../../etc/passwd",
    "..",
    "..-",
    "/etc/passwd",
    "/foo",
    "foo/../bar",
    "foo/bar",
    ".\\foo",
    "..\\foo",
    "foo bar",
    "foo;rm -rf /",
    "foo`whoami`",
    "$(whoami)",
    "foo|true",
    "foo>out",
    "foo<in",
    "foo&bg",
  ];

  for (const attempt of traversalAttempts) {
    it(`rejects ${JSON.stringify(attempt)}`, () => {
      expect(isValidProfileName(attempt)).toBe(false);
    });
  }

  it("argv parser surfaces the rejection as InvalidProfileNameError", () => {
    expect(() => parseArgv(["--profile", "../foo", "talk", "hi"])).toThrowError(
      InvalidProfileNameError,
    );
    expect(() => parseArgv(["profile", "create", "../foo"])).toThrowError(
      InvalidProfileNameError,
    );
    expect(() => parseArgv(["fork", "alpha", "../foo"])).toThrowError(
      InvalidProfileNameError,
    );
    expect(() => parseArgv(["fork", "../foo", "beta"])).toThrowError(
      InvalidProfileNameError,
    );
  });
});

// ── R4: fork rewrites sessionId in snapshot-histories ─────────────────

describe("R4 — arianna fork rewrites sessionId in snapshot-histories", () => {
  function mk() {
    const home = mkdtempSync(join(tmpdir(), "arianna-r4-home-"));
    const repo = mkdtempSync(join(tmpdir(), "arianna-r4-repo-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
    return { home, repo };
  }

  it("each snap_*.json in src is copied to dst with sessionId set to dstSessionId, src untouched", async () => {
    const { home, repo } = mk();

    // 1. Set up source profile via the real `arianna profile create`.
    await runProfile(
      { subcommand: "create", name: "alpha" },
      {
        write: () => {},
        ariannaHome: home,
        repoRoot: repo,
        skipBindTest: true,
      },
    );
    const srcDir = profileDir("alpha", { repoRoot: repo });
    const srcSessionId = "session_1700000000000";
    writeFileSync(
      join(srcDir, "session_config.json"),
      JSON.stringify({
        externalLlmApiKey: "k",
        provider: "openrouter",
        modelId: "openai/gpt-4o-mini",
        aiName: "Aria",
        aiUsername: "aria",
        difficulty: "normal",
        createdAt: 1_700_000_000_000,
        sessionId: srcSessionId,
      }),
    );
    // Snapshot histories in the current (compact, no sessionId) format.
    const histDir = join(srcDir, "sidecar-state", "snapshot-histories");
    mkdirSync(histDir, { recursive: true });
    for (const id of ["snap_a", "snap_b", "snap_c"]) {
      writeFileSync(join(histDir, `${id}.json`), JSON.stringify({ snapshotId: id }));
    }

    // 2. Run fork with a deterministic dst sessionId.
    const dstSessionId = "session_2000000000000";
    const fakeExec = vi.fn(async (cmd: string) => {
      if (cmd.includes("docker images") && cmd.includes(srcSessionId)) {
        return { stdout: `${VESSEL_REPO}:${srcSessionId}-base\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await runFork(
      { src: "alpha", dst: "beta" },
      {
        write: () => {},
        ariannaHome: home,
        repoRoot: repo,
        skipBindTest: true,
        now: () => 2_000_000_000_000,
        exec: fakeExec,
      },
    );

    // 3. Verify each snap_*.json in dst has sessionId rewritten.
    const dstHistDir = join(
      profileDir("beta", { repoRoot: repo }),
      "sidecar-state",
      "snapshot-histories",
    );
    expect(existsSync(dstHistDir)).toBe(true);
    const dstFiles = readdirSync(dstHistDir).sort();
    expect(dstFiles).toEqual(["snap_a.json", "snap_b.json", "snap_c.json"]);
    for (const f of dstFiles) {
      const obj = JSON.parse(readFileSync(join(dstHistDir, f), "utf-8")) as Record<string, unknown>;
      expect(obj.sessionId).toBe(dstSessionId);
      expect(obj.sessionId).not.toBe(srcSessionId);
      // The full {snapshotId, sessionId} shape is what the daemon's
      // restore path expects; lock down both fields so a future change
      // can't drop snapshotId silently while still rewriting sessionId.
      expect(obj.snapshotId).toBe(f.replace(/\.json$/, ""));
    }

    // 4. Source untouched: src snap files still have no sessionId.
    for (const id of ["snap_a", "snap_b", "snap_c"]) {
      const srcObj = JSON.parse(
        readFileSync(join(histDir, `${id}.json`), "utf-8"),
      ) as Record<string, unknown>;
      expect(srcObj).toEqual({ snapshotId: id });
    }
  });
});
