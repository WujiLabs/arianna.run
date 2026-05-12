// E2E round-trip test for `arianna profile save` → `arianna profile restore`.
//
// Uses a real docker daemon and the real system tar — the only mocks are the
// arianna config + profile dir paths (we point them at a temp sandbox so the
// test doesn't pollute `~/.arianna/config` or the dev workspace).
//
// Skipped when docker isn't available, so contributors without docker can
// still run `pnpm test`. CI environments that exercise this skill should
// have docker installed.

import { describe, it, expect, beforeAll } from "vitest";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProfile } from "../src/commands/profile.js";
import { profileDir } from "../src/paths.js";
import { loadConfig } from "../src/arianna-config.js";
import { VESSEL_REPO } from "../src/commands/_profile-clone-helpers.js";

const execAsync = promisify(execCb);

let dockerAvailable = false;

beforeAll(async () => {
  try {
    await execAsync("docker info", { timeout: 5_000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
});

const itDocker = (name: string, fn: () => Promise<void>) => {
  it(name, async () => {
    if (!dockerAvailable) {
      console.log(`[skip ${name}] docker not available`);
      return;
    }
    await fn();
  }, 60_000);
};

const E2E_TAG_PREFIX = "session_e2e_save_restore_";

interface ExecResult { stdout: string; stderr: string; }
type ExecFn = (cmd: string) => Promise<ExecResult>;

const realExec: ExecFn = async (cmd) => {
  const r = await execAsync(cmd, { maxBuffer: 64 * 1024 * 1024 });
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
};

async function setupDockerImage(sessionId: string): Promise<void> {
  // Pull a tiny base image and tag it as the vessel image.
  // hello-world is ~13KB; alpine:3 is ~7MB. Use hello-world for speed.
  await realExec("docker pull hello-world:latest");
  await realExec(`docker tag hello-world:latest ${VESSEL_REPO}:${sessionId}-base`);
  await realExec(`docker tag hello-world:latest ${VESSEL_REPO}:${sessionId}-current`);
}

async function cleanupDockerImage(sessionId: string): Promise<void> {
  // Best-effort untag; we don't `docker rmi` the underlying image since
  // hello-world might be in use by other tests.
  try {
    await realExec(`docker rmi ${VESSEL_REPO}:${sessionId}-base 2>/dev/null || true`);
  } catch { /* noop */ }
  try {
    await realExec(`docker rmi ${VESSEL_REPO}:${sessionId}-current 2>/dev/null || true`);
  } catch { /* noop */ }
}

async function cleanupRetagged(prefix: string): Promise<void> {
  // List tags matching prefix and untag them.
  try {
    const r = await realExec(
      `docker images --filter 'reference=${VESSEL_REPO}:${prefix}*' --format '{{.Repository}}:{{.Tag}}'`,
    );
    const tags = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const t of tags) {
      try { await realExec(`docker rmi ${t} 2>/dev/null || true`); } catch { /* noop */ }
    }
  } catch { /* noop */ }
}

describe("profile save → profile restore round-trip (docker)", () => {
  itDocker("save then restore reproduces the profile under a new name", async () => {
    const home = mkdtempSync(join(tmpdir(), "arianna-e2e-home-"));
    const repo = mkdtempSync(join(tmpdir(), "arianna-e2e-repo-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}");

    // Use a unique sessionId so concurrent test runs don't step on each
    // other's docker tags.
    const sessionId = `${E2E_TAG_PREFIX}${Date.now()}`;

    try {
      await setupDockerImage(sessionId);

      // Create a source profile.
      await runProfile(
        { subcommand: "create", name: "alpha" },
        { write: () => {}, ariannaHome: home, repoRoot: repo, skipBindTest: true },
      );
      // Hand-craft session_config.json with our sessionId so save can find
      // the docker tags.
      const srcDir = profileDir("alpha", { repoRoot: repo });
      writeFileSync(
        join(srcDir, "session_config.json"),
        JSON.stringify({
          externalLlmApiKey: "key",
          provider: "openrouter",
          modelId: "openai/gpt-4o-mini",
          aiName: "Aria",
          aiUsername: "aria",
          difficulty: "normal",
          cadence: "human",
          createdAt: 1_700_000_000_000,
          sessionId,
        }, null, 2),
      );
      // Add a session-state file + one snapshot history.
      mkdirSync(join(srcDir, "sidecar-state", "sessions"), { recursive: true });
      writeFileSync(
        join(srcDir, "sidecar-state", "sessions", `${sessionId}.json`),
        JSON.stringify({ messages: [{ role: "user", content: "hi" }], context: {}, timestamp: 1 }),
      );
      mkdirSync(join(srcDir, "sidecar-state", "snapshot-histories"), { recursive: true });
      writeFileSync(
        join(srcDir, "sidecar-state", "snapshot-histories", "snap_111.json"),
        JSON.stringify({ snapshotId: "snap_111" }),
      );

      // Save.
      const out = { out: "", err: "" };
      const tarballPath = join(home, "bundle.tar.gz");
      const writeFn = (s: string) => { out.out += s; };
      const warnFn = (s: string) => { out.err += s; };

      const saveCode = await runProfile(
        { subcommand: "save", saveArgs: { name: "alpha", out: tarballPath } },
        {
          write: writeFn, warn: warnFn,
          ariannaHome: home, repoRoot: repo, cwd: home, skipBindTest: true,
          exec: realExec,
        },
      );
      expect(saveCode).toBe(0);
      expect(existsSync(tarballPath)).toBe(true);

      // Restore under a new name.
      const restoreCode = await runProfile(
        { subcommand: "restore", restoreArgs: { tarball: tarballPath, name: "alpha-revived" } },
        {
          write: writeFn, warn: warnFn,
          ariannaHome: home, repoRoot: repo, cwd: home, skipBindTest: true,
          exec: realExec,
        },
      );
      expect(restoreCode).toBe(0);

      // Verify dst registered.
      const cfg = loadConfig({ ariannaHome: home });
      expect(cfg.profiles.has("alpha-revived")).toBe(true);

      // Verify dst session_config has fresh sessionId.
      const dstConfigRaw = readFileSync(
        join(profileDir("alpha-revived", { repoRoot: repo }), "session_config.json"),
        "utf-8",
      );
      const dstConfig = JSON.parse(dstConfigRaw) as Record<string, unknown>;
      expect(typeof dstConfig.sessionId).toBe("string");
      expect(dstConfig.sessionId).not.toBe(sessionId);
      expect(String(dstConfig.sessionId).startsWith("session_")).toBe(true);

      // Verify dst session-state file uses fresh sessionId.
      const dstSessionsDir = join(
        profileDir("alpha-revived", { repoRoot: repo }),
        "sidecar-state",
        "sessions",
      );
      const sessionFiles = readdirSync(dstSessionsDir);
      expect(sessionFiles).toHaveLength(1);
      expect(sessionFiles[0]).toBe(`${dstConfig.sessionId}.json`);

      // Verify dst snapshot-history rewritten with new sessionId.
      const dstHistDir = join(
        profileDir("alpha-revived", { repoRoot: repo }),
        "sidecar-state",
        "snapshot-histories",
      );
      const histFiles = readdirSync(dstHistDir);
      expect(histFiles).toContain("snap_111.json");
      const histObj = JSON.parse(
        readFileSync(join(dstHistDir, "snap_111.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(histObj.sessionId).toBe(dstConfig.sessionId);

      // Verify docker tags in dst sessionId namespace exist.
      const tagList = await realExec(
        `docker images --filter 'reference=${VESSEL_REPO}:${dstConfig.sessionId}-*' --format '{{.Repository}}:{{.Tag}}'`,
      );
      const dstTags = tagList.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      expect(dstTags.length).toBeGreaterThanOrEqual(1);
      // Source tags should still exist (save is non-destructive).
      const srcTagList = await realExec(
        `docker images --filter 'reference=${VESSEL_REPO}:${sessionId}-*' --format '{{.Repository}}:{{.Tag}}'`,
      );
      const srcTags = srcTagList.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      expect(srcTags.length).toBeGreaterThanOrEqual(1);

      // Cleanup retagged dst tags.
      await cleanupRetagged(String(dstConfig.sessionId));
    } finally {
      try { await cleanupDockerImage(sessionId); } catch { /* noop */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
      try { rmSync(repo, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});
