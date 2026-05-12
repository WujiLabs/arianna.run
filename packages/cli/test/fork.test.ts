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

import { runFork, ForkError, VESSEL_REPO } from "../src/commands/fork.js";
import { runProfile } from "../src/commands/profile.js";
import {
  ariannaConfigPath,
  profileDir,
  profileOverridePath,
} from "../src/paths.js";
import { loadConfig } from "../src/arianna-config.js";

interface Sandbox {
  home: string;
  repo: string;
}

function mk(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "arianna-fork-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-fork-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

interface ExecCall {
  cmd: string;
}

interface FakeExecOpts {
  /** Map of full commands → stdout for `docker images --filter ...` lookups. */
  imagesFor?: Record<string, string[]>;
  /** Tags that should be reported as already existing for a destination sessionId. */
  preExistingDstTags?: string[];
  /** If provided, dst sessionId for which we should claim tags exist. */
  preExistingDstSessionId?: string;
}

function fakeExec(opts: FakeExecOpts = {}) {
  const calls: ExecCall[] = [];

  const exec = vi.fn(async (cmd: string) => {
    calls.push({ cmd });

    // docker images --filter 'reference=ariannarun-vessel:{sid}-*' --format ...
    const m = /docker images --filter 'reference=ariannarun-vessel:([^-]+(?:_[^-]+)?(?:-[^*]+)?)-\*'/.exec(cmd)
      ?? /docker images --filter 'reference=ariannarun-vessel:(.+?)-\*'/.exec(cmd);
    if (m) {
      const sid = m[1];
      if (opts.preExistingDstSessionId && sid === opts.preExistingDstSessionId) {
        return {
          stdout: (opts.preExistingDstTags ?? []).join("\n") + "\n",
          stderr: "",
        };
      }
      const tags = opts.imagesFor?.[sid] ?? [];
      return { stdout: tags.join("\n") + (tags.length ? "\n" : ""), stderr: "" };
    }

    if (cmd.startsWith("docker tag ")) {
      return { stdout: "", stderr: "" };
    }

    return { stdout: "", stderr: "" };
  });

  return { exec, calls };
}

interface MockOut {
  out: string;
  err: string;
}

function deps(
  sandbox: Sandbox,
  out: MockOut,
  exec: ReturnType<typeof fakeExec>["exec"],
  extra: Partial<Parameters<typeof runFork>[1]> = {},
) {
  return {
    write: (s: string) => { out.out += s; },
    warn: (s: string) => { out.err += s; },
    ariannaHome: sandbox.home,
    repoRoot: sandbox.repo,
    skipBindTest: true,
    now: () => 2_000_000_000_000, // pinned ms timestamp for deterministic dst sessionId
    exec,
    ...extra,
  } as Parameters<typeof runFork>[1];
}

async function createSrc(
  sandbox: Sandbox,
  name: string,
  opts: {
    sessionId: string;
    snapshots?: string[];
    sessionFile?: boolean;
    extraConfig?: Record<string, unknown>;
  },
): Promise<void> {
  // Use the real `profile create` to set up the config + override file, then
  // hand-craft session_config.json + sidecar-state under the profile dir.
  const out: MockOut = { out: "", err: "" };
  await runProfile(
    { subcommand: "create", name },
    {
      write: (s) => { out.out += s; },
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
      // Current sidecar format: just `{ snapshotId }` — no sessionId field.
      writeFileSync(
        join(histDir, `${snapId}.json`),
        JSON.stringify({ snapshotId: snapId }),
      );
    }
  }
}

describe("runFork — happy path", () => {
  it("creates dst with expected files, retags docker, registers in config", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
      snapshots: ["snap_111", "snap_222", "snap_333"],
    });

    const { exec, calls } = fakeExec({
      imagesFor: {
        session_1700000000000: [
          `${VESSEL_REPO}:session_1700000000000-base`,
          `${VESSEL_REPO}:session_1700000000000-current`,
          `${VESSEL_REPO}:session_1700000000000-snap_111`,
          `${VESSEL_REPO}:session_1700000000000-snap_222`,
          `${VESSEL_REPO}:session_1700000000000-snap_333`,
        ],
      },
    });
    const out: MockOut = { out: "", err: "" };

    const code = await runFork(
      { src: "alpha", dst: "beta" },
      deps(sandbox, out, exec),
    );
    expect(code).toBe(0);

    // Config: dst registered, src untouched.
    const cfg = loadConfig({ ariannaHome: sandbox.home });
    expect(cfg.profiles.has("alpha")).toBe(true);
    expect(cfg.profiles.has("beta")).toBe(true);
    expect(cfg.defaultProfile).toBe("alpha"); // src remains default

    // dst session_config has new sessionId + new createdAt; other fields preserved.
    const dstConfig = JSON.parse(
      readFileSync(
        join(profileDir("beta", { repoRoot: sandbox.repo }), "session_config.json"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(dstConfig.sessionId).toBe("session_2000000000000");
    expect(dstConfig.createdAt).toBe(2_000_000_000_000);
    expect(dstConfig.aiName).toBe("Aria");
    expect(dstConfig.aiUsername).toBe("aria");
    expect(dstConfig.cadence).toBe("human");
    expect(dstConfig.provider).toBe("openrouter");

    // Override file exists with shifted port.
    expect(existsSync(profileOverridePath("beta", { repoRoot: sandbox.repo }))).toBe(true);

    // Sessions: filename is the dst sessionId, content unchanged.
    const dstSessionsDir = join(
      profileDir("beta", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "sessions",
    );
    expect(existsSync(join(dstSessionsDir, "session_2000000000000.json"))).toBe(true);

    // Snapshot histories: each rewritten with sessionId field set to dst.
    const dstHistDir = join(
      profileDir("beta", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "snapshot-histories",
    );
    const dstHistFiles = readdirSync(dstHistDir).sort();
    expect(dstHistFiles).toEqual(["snap_111.json", "snap_222.json", "snap_333.json"]);
    for (const f of dstHistFiles) {
      const raw = readFileSync(join(dstHistDir, f), "utf-8");
      // Compact format matches the sidecar's writeSnapshotPairingAtomic output.
      expect(raw).not.toContain("\n");
      const obj = JSON.parse(raw) as Record<string, unknown>;
      expect(obj.sessionId).toBe("session_2000000000000");
      expect(obj.snapshotId).toBe(f.replace(/\.json$/, ""));
    }

    // Docker tag calls: one per src tag, all targeting dst sessionId.
    const tagCalls = calls.filter((c) => c.cmd.startsWith("docker tag "));
    expect(tagCalls).toHaveLength(5);
    for (const c of tagCalls) {
      expect(c.cmd).toMatch(/-> ?$|session_2000000000000-/);
      expect(c.cmd).toContain("session_2000000000000");
    }
    expect(tagCalls.some((c) => c.cmd === `docker tag ${VESSEL_REPO}:session_1700000000000-base ${VESSEL_REPO}:session_2000000000000-base`)).toBe(true);

    // Stdout summary
    expect(out.out).toMatch(/Forked "alpha" → "beta"/);
    expect(out.out).toMatch(/retagged 5 docker images, copied 3 snapshot histories/);
  });

  it("source profile is untouched (no rmi, src files unchanged)", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
      snapshots: ["snap_111"],
    });

    const srcDir = profileDir("alpha", { repoRoot: sandbox.repo });
    const srcConfigBefore = readFileSync(join(srcDir, "session_config.json"), "utf-8");
    const srcSessionBefore = readFileSync(
      join(srcDir, "sidecar-state", "sessions", "session_1700000000000.json"),
      "utf-8",
    );
    const srcHistBefore = readFileSync(
      join(srcDir, "sidecar-state", "snapshot-histories", "snap_111.json"),
      "utf-8",
    );

    const { exec, calls } = fakeExec({
      imagesFor: {
        session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`],
      },
    });
    const out: MockOut = { out: "", err: "" };
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec));

    expect(readFileSync(join(srcDir, "session_config.json"), "utf-8")).toBe(srcConfigBefore);
    expect(
      readFileSync(join(srcDir, "sidecar-state", "sessions", "session_1700000000000.json"), "utf-8"),
    ).toBe(srcSessionBefore);
    expect(
      readFileSync(join(srcDir, "sidecar-state", "snapshot-histories", "snap_111.json"), "utf-8"),
    ).toBe(srcHistBefore);

    // No `docker rmi` calls anywhere.
    expect(calls.some((c) => c.cmd.includes("docker rmi"))).toBe(false);
  });

  it("handles 0 snapshot histories cleanly", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec));
    expect(out.out).toMatch(/copied 0 snapshot histories/);
  });

  it("handles 1 snapshot history (singular)", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
      snapshots: ["snap_111"],
    });
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec));
    expect(out.out).toMatch(/copied 1 snapshot history\b/);
  });

  it("session state file is optional (skips silently when absent)", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: false,
    });
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec));
    // Sessions dir was created (mkdir -p) but is empty.
    const dstSessionsDir = join(
      profileDir("beta", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "sessions",
    );
    expect(readdirSync(dstSessionsDir)).toEqual([]);
  });
});

describe("runFork — conflicts", () => {
  it("rejects when dst already in ~/.arianna/config", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    // Create beta first via the normal flow.
    await runProfile(
      { subcommand: "create", name: "beta" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await expect(
      runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(ForkError);
  });

  it("rejects when dst dir exists outside the registry", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    // Pre-existing untracked profile dir for "beta".
    mkdirSync(profileDir("beta", { repoRoot: sandbox.repo }), { recursive: true });

    const { exec } = fakeExec();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/already exists/);
  });

  it("rejects when src is not in config", async () => {
    const sandbox = mk();
    const { exec } = fakeExec();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runFork({ src: "ghost", dst: "beta" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/Source profile "ghost" not in/);
  });

  it("rejects when src has no session_config.json", async () => {
    const sandbox = mk();
    // Register in config without writing session_config.
    await runProfile(
      { subcommand: "create", name: "alpha" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );
    const { exec } = fakeExec();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/has no session_config\.json/);
  });

  it("rejects when src has no docker tags (sentinel for forgotten launch)", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const { exec } = fakeExec({ imagesFor: { session_1700000000000: [] } });
    const out: MockOut = { out: "", err: "" };
    await expect(
      runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/No docker tags found/);
  });

  it("rejects when dst sessionId already has docker tags (idempotency guard)", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    // Pre-stage tags for the freshly-minted dst sessionId.
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
      preExistingDstSessionId: "session_2000000000000",
      preExistingDstTags: [`${VESSEL_REPO}:session_2000000000000-base`],
    });
    const out: MockOut = { out: "", err: "" };
    await expect(
      runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/refusing to overwrite/);
  });

  it("rejects when src and dst names match", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const { exec } = fakeExec();
    const out: MockOut = { out: "", err: "" };
    await expect(
      runFork({ src: "alpha", dst: "alpha" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/must differ/);
  });

  it("doesn't leave an orphaned dstDir behind when src validation fails", async () => {
    const sandbox = mk();
    // alpha is registered but has no session_config.json — fork must fail
    // src validation, and the dst directory must NOT be left behind.
    const out: MockOut = { out: "", err: "" };
    await runProfile(
      { subcommand: "create", name: "alpha" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );
    // (no session_config.json written for alpha)

    const { exec } = fakeExec();
    await expect(
      runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/has no session_config\.json/);

    expect(existsSync(profileDir("beta", { repoRoot: sandbox.repo }))).toBe(false);

    // And a re-run with the same dst name (after we fix the src) succeeds —
    // i.e. the failed first attempt didn't block retry.
    writeFileSync(
      join(profileDir("alpha", { repoRoot: sandbox.repo }), "session_config.json"),
      JSON.stringify({ sessionId: "session_1700000000000" }),
    );
    const { exec: exec2 } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec2));
    expect(existsSync(profileDir("beta", { repoRoot: sandbox.repo }))).toBe(true);
  });

  it("rejects src sessionId containing shell-unsafe characters", async () => {
    const sandbox = mk();
    // Hand-craft a profile whose session_config.json has an unsafe sessionId.
    // (We bypass createSrc here because the unsafe string would also be
    // interpreted as a path component when writing the session-state file.)
    const out: MockOut = { out: "", err: "" };
    await runProfile(
      { subcommand: "create", name: "alpha" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );
    const dir = profileDir("alpha", { repoRoot: sandbox.repo });
    writeFileSync(
      join(dir, "session_config.json"),
      JSON.stringify({
        externalLlmApiKey: "key",
        provider: "openrouter",
        modelId: "openai/gpt-4o-mini",
        aiName: "Aria",
        aiUsername: "aria",
        difficulty: "normal",
        createdAt: 1_700_000_000_000,
        sessionId: "session_1700000000000; rm -rf /tmp/x",
      }),
    );

    const { exec } = fakeExec();
    await expect(
      runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec)),
    ).rejects.toThrowError(/contains characters that aren't safe/);
  });
});

describe("runFork — port allocation", () => {
  it("picks a non-colliding offset given existing src offset", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec));

    const cfg = loadConfig({ ariannaHome: sandbox.home });
    const alpha = cfg.profiles.get("alpha")!;
    const beta = cfg.profiles.get("beta")!;
    expect(beta.portOffset).not.toBe(alpha.portOffset);

    // Verify the override file uses the same offset as registered.
    const overrideText = readFileSync(
      profileOverridePath("beta", { repoRoot: sandbox.repo }),
      "utf-8",
    );
    expect(overrideText).toMatch(new RegExp(`127\\.0\\.0\\.1:${3000 + beta.portOffset}:3000`));
  });
});

describe("runFork — forward-compat sessionId rewrite", () => {
  it("rewrites an existing sessionId field in snapshot-histories (future format)", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    // Hand-write a future-format history file with sessionId already populated.
    const histDir = join(
      profileDir("alpha", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "snapshot-histories",
    );
    mkdirSync(histDir, { recursive: true });
    writeFileSync(
      join(histDir, "snap_999.json"),
      JSON.stringify({ snapshotId: "snap_999", sessionId: "session_1700000000000" }),
    );

    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec));

    const dstHistFile = join(
      profileDir("beta", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "snapshot-histories",
      "snap_999.json",
    );
    const dst = JSON.parse(readFileSync(dstHistFile, "utf-8")) as Record<string, unknown>;
    expect(dst.sessionId).toBe("session_2000000000000");
    expect(dst.snapshotId).toBe("snap_999");
  });

  it("skips snapshot-histories whose sessionId references a foreign session", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const histDir = join(
      profileDir("alpha", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "snapshot-histories",
    );
    mkdirSync(histDir, { recursive: true });
    writeFileSync(
      join(histDir, "snap_foreign.json"),
      JSON.stringify({ snapshotId: "snap_foreign", sessionId: "session_OTHER" }),
    );
    writeFileSync(
      join(histDir, "snap_local.json"),
      JSON.stringify({ snapshotId: "snap_local" }),
    );

    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec));

    const dstHistDir = join(
      profileDir("beta", { repoRoot: sandbox.repo }),
      "sidecar-state",
      "snapshot-histories",
    );
    expect(readdirSync(dstHistDir).sort()).toEqual(["snap_local.json"]);
  });
});

describe("argv-level validation", () => {
  it("the CLI registry path is unchanged for forks (config has both profiles after a fork)", async () => {
    const sandbox = mk();
    await createSrc(sandbox, "alpha", {
      sessionId: "session_1700000000000",
      sessionFile: true,
    });
    const { exec } = fakeExec({
      imagesFor: { session_1700000000000: [`${VESSEL_REPO}:session_1700000000000-base`] },
    });
    const out: MockOut = { out: "", err: "" };
    await runFork({ src: "alpha", dst: "beta" }, deps(sandbox, out, exec));
    const text = readFileSync(ariannaConfigPath({ ariannaHome: sandbox.home }), "utf-8");
    expect(text).toMatch(/\[profile alpha\]/);
    expect(text).toMatch(/\[profile beta\]/);
  });
});
