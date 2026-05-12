import { describe, it, expect, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runProfileSave,
  ProfileSaveError,
  SAVE_BUNDLE_VERSION,
  type SaveBundleManifestV1,
} from "../src/commands/profile-save.js";
import { runProfile } from "../src/commands/profile.js";
import { profileDir } from "../src/paths.js";
import { VESSEL_REPO } from "../src/commands/_profile-clone-helpers.js";

interface Sandbox {
  home: string;
  repo: string;
}

function mk(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "arianna-save-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-save-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

interface ExecCall { cmd: string }
interface FakeExecOpts {
  imagesFor?: Record<string, string[]>;
  /** Capture writes by `docker save -o <path> ...`. */
  onDockerSave?: (path: string, tags: string[]) => void;
  /** Capture writes by `tar -czf <out> -C <dir> .`. */
  onTarCreate?: (outPath: string, sourceDir: string) => void;
  gitHead?: string;
}

function fakeExec(opts: FakeExecOpts = {}) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(async (cmd: string) => {
    calls.push({ cmd });

    const imagesM = /docker images --filter 'reference=ariannarun-vessel:(.+?)-\*'/.exec(cmd);
    if (imagesM) {
      const sid = imagesM[1];
      const tags = opts.imagesFor?.[sid] ?? [];
      return { stdout: tags.join("\n") + (tags.length ? "\n" : ""), stderr: "" };
    }

    const saveM = /docker save -o '([^']+)'\s+(.+)/.exec(cmd);
    if (saveM) {
      const outPath = saveM[1];
      const tagPart = saveM[2];
      const tags = tagPart
        .split(/\s+/)
        .map((t) => t.replace(/^'(.*)'$/, "$1"))
        .filter(Boolean);
      writeFileSync(outPath, "fake-docker-images-tar");
      opts.onDockerSave?.(outPath, tags);
      return { stdout: "", stderr: "" };
    }

    const tarCreateM = /tar -czf '([^']+)' -C '([^']+)' \./.exec(cmd);
    if (tarCreateM) {
      const outPath = tarCreateM[1];
      const sourceDir = tarCreateM[2];
      writeFileSync(outPath, `fake-tarball-of:${sourceDir}`);
      opts.onTarCreate?.(outPath, sourceDir);
      return { stdout: "", stderr: "" };
    }

    if (cmd.startsWith("git ")) {
      return { stdout: (opts.gitHead ?? "abc123def456") + "\n", stderr: "" };
    }

    return { stdout: "", stderr: "" };
  });
  return { exec, calls };
}

interface MockOut { out: string; err: string }

async function createSrcProfile(
  sandbox: Sandbox,
  name: string,
  opts: {
    sessionId: string;
    snapshots?: string[];
    sessionFile?: boolean;
    extraConfig?: Record<string, unknown>;
  },
): Promise<void> {
  await runProfile(
    { subcommand: "create", name },
    {
      write: () => {},
      ariannaHome: sandbox.home,
      repoRoot: sandbox.repo,
      skipBindTest: true,
      now: () => 1_700_000_000_000,
    },
  );
  const dir = profileDir(name, { repoRoot: sandbox.repo });
  writeFileSync(
    join(dir, "session_config.json"),
    JSON.stringify({
      externalLlmApiKey: "key",
      provider: "openrouter",
      modelId: "openai/gpt-4o-mini",
      aiName: "Aria",
      aiUsername: "aria",
      difficulty: "normal",
      cadence: "human",
      createdAt: 1_700_000_000_000,
      sessionId: opts.sessionId,
      ...(opts.extraConfig ?? {}),
    }, null, 2),
  );
  if (opts.sessionFile) {
    const sessionsDir = join(dir, "sidecar-state", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${opts.sessionId}.json`),
      JSON.stringify({ messages: [{ role: "user", content: "hi" }], context: {}, timestamp: 1 }),
    );
  }
  if (opts.snapshots && opts.snapshots.length > 0) {
    const histDir = join(dir, "sidecar-state", "snapshot-histories");
    mkdirSync(histDir, { recursive: true });
    for (const snapId of opts.snapshots) {
      writeFileSync(
        join(histDir, `${snapId}.json`),
        JSON.stringify({ snapshotId: snapId }),
      );
    }
  }
}

function deps(sandbox: Sandbox, out: MockOut, exec: ReturnType<typeof fakeExec>["exec"]) {
  return {
    write: (s: string) => { out.out += s; },
    warn: (s: string) => { out.err += s; },
    ariannaHome: sandbox.home,
    repoRoot: sandbox.repo,
    cwd: sandbox.repo,
    skipBindTest: true,
    now: () => 1_714_603_200_000,
    exec,
  };
}

describe("runProfileSave — happy path", () => {
  it("writes a tarball with manifest + docker-images.tar + profile dir", async () => {
    const sandbox = mk();
    await createSrcProfile(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
      snapshots: ["snap_111", "snap_222"],
    });

    let savedTags: string[] = [];
    // The stage dir is cleaned up in `finally`, so we capture the files
    // we want to assert on inside the tar-create callback (still during
    // the call's lifetime).
    let capturedManifest: SaveBundleManifestV1 | null = null;
    let stagedHasProfileConfig = false;
    let stagedHasDockerImages = false;
    const { exec, calls } = fakeExec({
      imagesFor: {
        session_1700000000000: [
          `${VESSEL_REPO}:session_1700000000000-base`,
          `${VESSEL_REPO}:session_1700000000000-current`,
          `${VESSEL_REPO}:session_1700000000000-snap_111`,
          `${VESSEL_REPO}:session_1700000000000-snap_222`,
        ],
      },
      onDockerSave: (_path, tags) => { savedTags = tags; },
      onTarCreate: (_out, src) => {
        const manifestPath = join(src, "manifest.json");
        capturedManifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as SaveBundleManifestV1;
        stagedHasProfileConfig = existsSync(join(src, "profile", "session_config.json"));
        stagedHasDockerImages = existsSync(join(src, "docker-images.tar"));
      },
    });
    const out: MockOut = { out: "", err: "" };

    const code = await runProfileSave({ name: "alpha" }, deps(sandbox, out, exec));
    expect(code).toBe(0);

    // docker save received all 4 tags
    expect(savedTags.sort()).toEqual([
      `${VESSEL_REPO}:session_1700000000000-base`,
      `${VESSEL_REPO}:session_1700000000000-current`,
      `${VESSEL_REPO}:session_1700000000000-snap_111`,
      `${VESSEL_REPO}:session_1700000000000-snap_222`,
    ]);

    // Manifest was well-formed at tar-time
    expect(capturedManifest).not.toBeNull();
    const manifest = capturedManifest!;
    expect(manifest.version).toBe(SAVE_BUNDLE_VERSION);
    expect(manifest.profile.name).toBe("alpha");
    expect(manifest.profile.sessionId).toBe("session_1700000000000");
    expect(manifest.profile.aiName).toBe("Aria");
    expect(manifest.profile.modelId).toBe("openai/gpt-4o-mini");
    expect(manifest.dockerTags).toHaveLength(4);
    expect(manifest.snapshotIds).toEqual(["snap_111", "snap_222"]);
    expect(manifest.savedAt).toBe(1_714_603_200_000);
    expect(manifest.ariannaGitHead).toBe("abc123def456");

    // profile dir + docker-images.tar were staged for tarring
    expect(stagedHasProfileConfig).toBe(true);
    expect(stagedHasDockerImages).toBe(true);

    // Stdout summary
    expect(out.out).toMatch(/Saved profile "alpha" →/);
    expect(out.out).toMatch(/4 docker images, 2 snapshots/);

    // Single docker save invocation (layer-shared bundle)
    const dockerSaves = calls.filter((c) => c.cmd.startsWith("docker save"));
    expect(dockerSaves).toHaveLength(1);
  });

  it("default --out path is <cwd>/arianna-profile-<name>-<date>.tar.gz", async () => {
    const sandbox = mk();
    await createSrcProfile(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    let createdOut: string | null = null;
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
      onTarCreate: (out) => { createdOut = out; },
    });
    const out: MockOut = { out: "", err: "" };
    await runProfileSave({ name: "alpha" }, deps(sandbox, out, exec));

    // 1714603200000 = 2024-05-01 in UTC
    expect(createdOut).toBe(join(sandbox.repo, "arianna-profile-alpha-2024-05-01.tar.gz"));
  });

  it("--out PATH is honored (relative resolved against cwd)", async () => {
    const sandbox = mk();
    await createSrcProfile(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    let createdOut: string | null = null;
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
      onTarCreate: (out) => { createdOut = out; },
    });
    const out: MockOut = { out: "", err: "" };
    await runProfileSave(
      { name: "alpha", out: "subdir/bundle.tgz" },
      deps(sandbox, out, exec),
    );
    expect(createdOut).toBe(join(sandbox.repo, "subdir", "bundle.tgz"));
    expect(existsSync(join(sandbox.repo, "subdir"))).toBe(true);
  });
});

describe("runProfileSave — refusals", () => {
  it("rejects when profile is not in config", async () => {
    const sandbox = mk();
    const { exec } = fakeExec();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileSave({ name: "ghost" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(ProfileSaveError);
  });

  it("rejects when profile has no session_config.json", async () => {
    const sandbox = mk();
    await runProfile(
      { subcommand: "create", name: "alpha" },
      { write: () => {}, ariannaHome: sandbox.home, repoRoot: sandbox.repo, skipBindTest: true },
    );
    // No session_config written
    const { exec } = fakeExec();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileSave({ name: "alpha" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/no session_config\.json/);
  });

  it("rejects when sessionId contains shell-unsafe characters", async () => {
    const sandbox = mk();
    await createSrcProfile(sandbox, "alpha", { sessionId: "session_1700000000000" });
    // Overwrite session_config with unsafe sessionId
    const dir = profileDir("alpha", { repoRoot: sandbox.repo });
    writeFileSync(
      join(dir, "session_config.json"),
      JSON.stringify({ sessionId: "session_1700; rm -rf /" }),
    );
    const { exec } = fakeExec();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileSave({ name: "alpha" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/aren't safe/);
  });

  it("rejects when no docker tags exist (sentinel for no-bootstrap)", async () => {
    const sandbox = mk();
    await createSrcProfile(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const { exec } = fakeExec({ imagesFor: { session_1700000000000: [] } });
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileSave({ name: "alpha" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/No docker tags found/);
  });

  it("rejects clobbering an existing output file", async () => {
    const sandbox = mk();
    await createSrcProfile(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const outPath = join(sandbox.repo, "existing.tar.gz");
    writeFileSync(outPath, "preexisting");
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileSave({ name: "alpha", out: outPath }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/already exists/);
  });

  it("rejects --out path that resolves into a protected system dir", async () => {
    const sandbox = mk();
    await createSrcProfile(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await expect(
      runProfileSave(
        { name: "alpha", out: "/etc/arianna-evil.tar.gz" },
        deps(sandbox, out, exec),
      ),
    ).rejects.toThrowError(/protected system directory/);
  });
});
