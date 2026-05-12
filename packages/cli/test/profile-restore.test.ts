import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runProfileRestore,
  ProfileRestoreError,
  _internal as restoreInternal,
} from "../src/commands/profile-restore.js";
import {
  SAVE_BUNDLE_VERSION,
  type SaveBundleManifestV1,
} from "../src/commands/profile-save.js";
import { profileDir, profileOverridePath } from "../src/paths.js";
import { loadConfig } from "../src/arianna-config.js";
import { VESSEL_REPO } from "../src/commands/_profile-clone-helpers.js";

interface Sandbox {
  home: string;
  repo: string;
  bundleStaging: string;
}

function mk(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "arianna-restore-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-restore-repo-"));
  const bundleStaging = mkdtempSync(join(tmpdir(), "arianna-restore-bundle-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo, bundleStaging };
}

interface BundleOpts {
  /** Override manifest fields. */
  manifestPatch?: Partial<SaveBundleManifestV1>;
  /** Pretend the source profile had a session-state file. */
  withSessionFile?: boolean;
  /** Pretend the source profile had snapshot histories. */
  snapshotIds?: string[];
  /** Skip writing manifest.json. */
  omitManifest?: boolean;
  /** Skip writing docker-images.tar. */
  omitDockerImages?: boolean;
  /** Skip writing the profile/ subdir. */
  omitProfile?: boolean;
  /** Add an extra entry — useful for hostile tarball tests. */
  extraSetup?: (stageDir: string) => void;
}

/**
 * Build a real tarball using the system `tar` command. We do this in a
 * temp staging directory and tar it up to a destination path.
 */
function buildBundle(
  outPath: string,
  stagingBase: string,
  srcSessionId: string,
  srcProfileName: string,
  opts: BundleOpts = {},
): void {
  const stage = mkdtempSync(join(stagingBase, "stage-"));

  if (!opts.omitManifest) {
    const manifest: SaveBundleManifestV1 = {
      version: SAVE_BUNDLE_VERSION,
      savedAt: 1_714_603_200_000,
      ariannaGitHead: "abc123def456",
      profile: {
        name: srcProfileName,
        sessionId: srcSessionId,
        aiName: "Aria",
        aiUsername: "aria",
        provider: "openrouter",
        modelId: "openai/gpt-4o-mini",
      },
      dockerTags: [`${VESSEL_REPO}:${srcSessionId}-base`],
      snapshotIds: opts.snapshotIds ?? [],
      ...(opts.manifestPatch ?? {}),
    };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  if (!opts.omitDockerImages) {
    writeFileSync(join(stage, "docker-images.tar"), "fake-docker-images-tar-content");
  }

  if (!opts.omitProfile) {
    const profileStage = join(stage, "profile");
    mkdirSync(profileStage, { recursive: true });
    writeFileSync(
      join(profileStage, "session_config.json"),
      JSON.stringify({
        externalLlmApiKey: "key",
        provider: "openrouter",
        modelId: "openai/gpt-4o-mini",
        aiName: "Aria",
        aiUsername: "aria",
        difficulty: "normal",
        cadence: "human",
        sessionId: srcSessionId,
        createdAt: 1_700_000_000_000,
      }, null, 2),
    );
    writeFileSync(
      join(profileStage, "compose.override.yml"),
      "# placeholder; restore regenerates this\n",
    );

    if (opts.withSessionFile) {
      mkdirSync(join(profileStage, "sidecar-state", "sessions"), { recursive: true });
      writeFileSync(
        join(profileStage, "sidecar-state", "sessions", `${srcSessionId}.json`),
        JSON.stringify({ messages: [], context: {}, timestamp: 1 }),
      );
    }

    if (opts.snapshotIds && opts.snapshotIds.length > 0) {
      const histDir = join(profileStage, "sidecar-state", "snapshot-histories");
      mkdirSync(histDir, { recursive: true });
      for (const sid of opts.snapshotIds) {
        writeFileSync(
          join(histDir, `${sid}.json`),
          JSON.stringify({ snapshotId: sid }),
        );
      }
    }

    // snapshots/ dir for completeness (JSON metadata only)
    mkdirSync(join(profileStage, "snapshots"), { recursive: true });
    writeFileSync(
      join(profileStage, "snapshots", "snap_111.json"),
      JSON.stringify({ id: "snap_111", reason: "test" }),
    );
  }

  if (opts.extraSetup) opts.extraSetup(stage);

  // Use system tar to bundle.
  execFileSync("tar", ["-czf", outPath, "-C", stage, "."], { stdio: "ignore" });
}

interface ExecCall { cmd: string }
interface FakeRestoreOpts {
  /** docker tags returned for `docker images --filter ...` per sessionId. */
  imagesFor?: Record<string, string[]>;
  /** Pre-existing dst tags (idempotency-guard simulation). */
  preExistingDstSessionId?: string;
  preExistingDstTags?: string[];
}

function fakeExecForRestore(opts: FakeRestoreOpts = {}) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(async (cmd: string) => {
    calls.push({ cmd });

    // Real tar invocations — let them through to the system tar.
    if (
      cmd.startsWith("tar -tvzf ") ||
      cmd.startsWith("tar -tzf ") ||
      cmd.startsWith("tar -xzf ")
    ) {
      const out = execFileSync("sh", ["-c", cmd], { encoding: "utf-8" });
      return { stdout: out, stderr: "" };
    }

    const imagesM = /docker images --filter 'reference=ariannarun-vessel:(.+?)-\*'/.exec(cmd);
    if (imagesM) {
      const sid = imagesM[1];
      if (opts.preExistingDstSessionId && sid === opts.preExistingDstSessionId) {
        return {
          stdout: (opts.preExistingDstTags ?? []).join("\n") + "\n",
          stderr: "",
        };
      }
      const tags = opts.imagesFor?.[sid] ?? [];
      return { stdout: tags.join("\n") + (tags.length ? "\n" : ""), stderr: "" };
    }

    if (cmd.startsWith("docker load ")) return { stdout: "", stderr: "" };
    if (cmd.startsWith("docker tag ")) return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  return { exec, calls };
}

interface MockOut { out: string; err: string }

function deps(sandbox: Sandbox, out: MockOut, exec: ReturnType<typeof fakeExecForRestore>["exec"]) {
  return {
    write: (s: string) => { out.out += s; },
    warn: (s: string) => { out.err += s; },
    ariannaHome: sandbox.home,
    repoRoot: sandbox.repo,
    cwd: sandbox.repo,
    skipBindTest: true,
    now: () => 2_000_000_000_000,
    exec,
  };
}

describe("runProfileRestore — happy path", () => {
  it("restores a bundle into a fresh profile, retags docker, registers in config", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "alpha.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      withSessionFile: true,
      snapshotIds: ["snap_111", "snap_222"],
    });

    const { exec, calls } = fakeExecForRestore({
      imagesFor: {
        session_1700000000000: [
          `${VESSEL_REPO}:session_1700000000000-base`,
          `${VESSEL_REPO}:session_1700000000000-snap_111`,
        ],
      },
    });
    const out: MockOut = { out: "", err: "" };

    const code = await runProfileRestore(
      { tarball, name: "alpha-restored" },
      deps(sandbox, out, exec),
    );
    expect(code).toBe(0);

    // dst registered in config with fresh port offset
    const cfg = loadConfig({ ariannaHome: sandbox.home });
    expect(cfg.profiles.has("alpha-restored")).toBe(true);

    // dst session_config has fresh sessionId, otherwise copied from bundle
    const dstConfigPath = join(
      profileDir("alpha-restored", { repoRoot: sandbox.repo }),
      "session_config.json",
    );
    const dstConfig = JSON.parse(readFileSync(dstConfigPath, "utf-8")) as Record<string, unknown>;
    expect(dstConfig.sessionId).toBe("session_2000000000000");
    expect(dstConfig.createdAt).toBe(2_000_000_000_000);
    expect(dstConfig.aiName).toBe("Aria");
    expect(dstConfig.modelId).toBe("openai/gpt-4o-mini");

    // session-state file renamed
    const dstSessionsDir = join(
      profileDir("alpha-restored", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "sessions",
    );
    expect(existsSync(join(dstSessionsDir, "session_2000000000000.json"))).toBe(true);
    expect(existsSync(join(dstSessionsDir, "session_1700000000000.json"))).toBe(false);

    // snapshot-history files rewritten with new sessionId
    const dstHistDir = join(
      profileDir("alpha-restored", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "snapshot-histories",
    );
    expect(readdirSync(dstHistDir).sort()).toEqual(["snap_111.json", "snap_222.json"]);
    for (const f of ["snap_111.json", "snap_222.json"]) {
      const obj = JSON.parse(readFileSync(join(dstHistDir, f), "utf-8")) as Record<string, unknown>;
      expect(obj.sessionId).toBe("session_2000000000000");
      expect(obj.snapshotId).toBe(f.replace(/\.json$/, ""));
    }

    // snapshots/ metadata copied verbatim
    expect(
      existsSync(join(profileDir("alpha-restored", { repoRoot: sandbox.repo }), "snapshots", "snap_111.json")),
    ).toBe(true);

    // compose.override.yml regenerated (NOT the bundled placeholder)
    const overrideText = readFileSync(
      profileOverridePath("alpha-restored", { repoRoot: sandbox.repo }),
      "utf-8",
    );
    expect(overrideText).not.toContain("placeholder");
    expect(overrideText).toMatch(/127\.0\.0\.1:\d+:3000/);

    // docker load + docker tag invocations
    expect(calls.some((c) => c.cmd.startsWith("docker load "))).toBe(true);
    const tagCalls = calls.filter((c) => c.cmd.startsWith("docker tag "));
    expect(tagCalls.length).toBeGreaterThan(0);
    for (const c of tagCalls) {
      expect(c.cmd).toContain("session_2000000000000");
    }

    // Stdout summary
    expect(out.out).toMatch(/Restored "alpha" → "alpha-restored"/);
  });

  it("auto-generates dst name when --name omitted", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "alpha.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      withSessionFile: true,
    });

    const { exec } = fakeExecForRestore({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await runProfileRestore({ tarball }, deps(sandbox, out, exec));
    const cfg = loadConfig({ ariannaHome: sandbox.home });
    expect(cfg.profiles.has("alpha-restored-2000000000000")).toBe(true);
  });
});

describe("runProfileRestore — refusals", () => {
  it("rejects when destination name already exists in config", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "alpha.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      withSessionFile: true,
    });

    // Create a profile named alpha-restored first
    const { runProfile } = await import("../src/commands/profile.js");
    await runProfile(
      { subcommand: "create", name: "alpha-restored" },
      { write: () => {}, ariannaHome: sandbox.home, repoRoot: sandbox.repo, skipBindTest: true },
    );

    const { exec } = fakeExecForRestore({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileRestore({ tarball, name: "alpha-restored" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/already exists/);
  });

  it("rejects when manifest.json is missing from the bundle", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "no-manifest.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      omitManifest: true,
    });
    const { exec } = fakeExecForRestore();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileRestore({ tarball }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/missing manifest\.json/);
  });

  it("rejects when manifest version is unknown", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "future.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      manifestPatch: { version: 99 as 1 },
    });
    const { exec } = fakeExecForRestore();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileRestore({ tarball }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/declares version 99/);
  });

  it("rejects when docker-images.tar is missing", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "no-images.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      omitDockerImages: true,
    });
    const { exec } = fakeExecForRestore();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileRestore({ tarball }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/missing docker-images\.tar/);
  });

  it("rejects when manifest sessionId contains shell-unsafe characters", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "bad-sid.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      manifestPatch: {
        profile: {
          name: "alpha",
          sessionId: "bad; rm -rf /",
          aiName: "Aria",
        } as SaveBundleManifestV1["profile"],
      },
    });
    const { exec } = fakeExecForRestore();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileRestore({ tarball }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/aren't safe to interpolate/);
  });

  it("rejects tarball containing a symlink (path-traversal defense)", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "evil.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      extraSetup: (stage) => {
        // Create a symlink inside the staging area before tarring.
        symlinkSync("/etc", join(stage, "evil-link"));
      },
    });
    const { exec } = fakeExecForRestore();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileRestore({ tarball }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/symlink/);
  });

  it("rejects nonexistent tarball", async () => {
    const sandbox = mk();
    const { exec } = fakeExecForRestore();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileRestore({ tarball: join(sandbox.bundleStaging, "nope.tar.gz") }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/not found/);
  });
});

describe("manifest validation (unit)", () => {
  it("accepts a v1 manifest", () => {
    const m = restoreInternal.parseAndValidateManifest(JSON.stringify({
      version: 1,
      savedAt: 1,
      ariannaGitHead: null,
      profile: { name: "alpha", sessionId: "session_x" },
      dockerTags: [],
      snapshotIds: [],
    }));
    expect(m.profile.name).toBe("alpha");
  });
  it("rejects non-numeric version", () => {
    expect(() =>
      restoreInternal.parseAndValidateManifest(JSON.stringify({ profile: { name: "a", sessionId: "s" } })),
    ).toThrowError(/numeric "version"/);
  });
  it("rejects future versions", () => {
    expect(() =>
      restoreInternal.parseAndValidateManifest(JSON.stringify({
        version: 2,
        profile: { name: "a", sessionId: "s" },
      })),
    ).toThrowError(/declares version 2/);
  });
  it("rejects bad src profile name", () => {
    expect(() =>
      restoreInternal.parseAndValidateManifest(JSON.stringify({
        version: 1,
        profile: { name: "../evil", sessionId: "s" },
      })),
    ).toThrowError(/doesn't match/);
  });
});

describe("dst-name generation (unit)", () => {
  it("uses --name verbatim when provided", () => {
    expect(restoreInternal.resolveDstName("custom-name", "alpha", 1)).toBe("custom-name");
  });
  it("rejects invalid --name", () => {
    expect(() => restoreInternal.resolveDstName("BadName", "alpha", 1)).toThrow();
  });
  it("auto-generates from src + timestamp when omitted", () => {
    expect(restoreInternal.resolveDstName(undefined, "alpha", 1234)).toBe("alpha-restored-1234");
  });
  it("trims long src to fit the 31-char regex limit", () => {
    const long = "a".repeat(40);
    const result = restoreInternal.resolveDstName(undefined, long, 1);
    expect(result.length).toBeLessThanOrEqual(31);
    expect(result.endsWith("-restored-1")).toBe(true);
  });
});

describe("idempotency (unit)", () => {
  it("rejects when dst sessionId already has tags (sentinel for retry-after-partial)", async () => {
    const sandbox = mk();
    const tarball = join(sandbox.bundleStaging, "alpha.tar.gz");
    buildBundle(tarball, sandbox.bundleStaging, "session_1700000000000", "alpha", {
      withSessionFile: true,
    });
    const { exec } = fakeExecForRestore({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
      preExistingDstSessionId: "session_2000000000000",
      preExistingDstTags: [`${VESSEL_REPO}:session_2000000000000-base`],
    });
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileRestore({ tarball }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/refusing to overwrite/);
  });
});

describe("ProfileRestoreError surfacing", () => {
  it("uses the typed error class", async () => {
    const sandbox = mk();
    const { exec } = fakeExecForRestore();
    const out: MockOut = { out: "", err: "" };
    try {
      await runProfileRestore({ tarball: "/does/not/exist.tar.gz" }, deps(sandbox, out, exec));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileRestoreError);
    }
  });
});
