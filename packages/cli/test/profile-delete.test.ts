import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProfile } from "../src/commands/profile.js";
import { ariannaConfigPath, profileDir } from "../src/paths.js";
import { loadConfig } from "../src/arianna-config.js";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-del-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-del-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

interface Capture {
  out: string;
  err: string;
}

interface ExecCall { cmd: string; }

function depsFor(home: string, repo: string, cap: Capture, extra: object = {}) {
  return {
    write: (s: string) => { cap.out += s; },
    warn: (s: string) => { cap.err += s; },
    ariannaHome: home,
    repoRoot: repo,
    skipBindTest: true,
    now: () => 1714603200000,
    isTTY: () => false,
    env: {} as NodeJS.ProcessEnv,
    ...extra,
  } as Parameters<typeof runProfile>[1];
}

async function createProfile(name: string, home: string, repo: string) {
  const cap: Capture = { out: "", err: "" };
  await runProfile(
    { subcommand: "create", name, create: {} },
    depsFor(home, repo, cap),
  );
}

describe("profile delete", () => {
  it("removes the workspace dir, config entry, and runs docker compose down", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);
    await createProfile("beta", home, repo); // so default isn't alpha when we delete it

    // Re-point default away from alpha so we can delete it without --force.
    const cfgBefore = loadConfig({ ariannaHome: home });
    cfgBefore.defaultProfile = "beta";
    const { saveConfig } = await import("../src/arianna-config.js");
    saveConfig(cfgBefore, { ariannaHome: home });

    const cap: Capture = { out: "", err: "" };
    const execCalls: ExecCall[] = [];

    const code = await runProfile(
      {
        subcommand: "delete",
        name: "alpha",
        deleteFlags: { force: false, skipDocker: false, yes: true },
      },
      depsFor(home, repo, cap, {
        exec: async (cmd: string) => {
          execCalls.push({ cmd });
          return { stdout: "", stderr: "" };
        },
      }),
    );

    expect(code).toBe(0);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe(
      "docker compose -p arianna-alpha down --rmi all -v --remove-orphans",
    );

    // Filesystem
    expect(existsSync(profileDir("alpha", { repoRoot: repo }))).toBe(false);
    // Config
    const cfgAfter = loadConfig({ ariannaHome: home });
    expect(cfgAfter.profiles.has("alpha")).toBe(false);
    expect(cfgAfter.profiles.has("beta")).toBe(true);
    // Output summary
    expect(cap.out).toMatch(/Deleted profile "alpha"/);
    expect(cap.out).toMatch(/docker compose project arianna-alpha/);
    expect(cap.out).toMatch(/workspace\/profiles\/alpha\//);
    expect(cap.out).toMatch(/profile alpha\] section/);
  });

  it("clears defaultProfile when deleting the current default with --force", async () => {
    const { home, repo } = mk();
    await createProfile("only", home, repo);

    const cap: Capture = { out: "", err: "" };
    await runProfile(
      {
        subcommand: "delete",
        name: "only",
        deleteFlags: { force: true, skipDocker: true, yes: true },
      },
      depsFor(home, repo, cap),
    );
    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.profiles.has("only")).toBe(false);
    expect(cfg.defaultProfile).toBeNull();
  });

  it("refuses to delete the default profile without --force", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "delete",
          name: "alpha",
          deleteFlags: { force: false, skipDocker: true, yes: true },
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrowError(/configured default/);
  });

  it("refuses to delete 'default' when the .no-default-allowed sentinel exists", async () => {
    const { home, repo } = mk();
    // Manually register `default` in config so the entry-existence check passes.
    const { saveConfig } = await import("../src/arianna-config.js");
    saveConfig(
      {
        defaultProfile: null,
        profiles: new Map([["default", { portOffset: 0, createdAt: 1 }]]),
      },
      { ariannaHome: home },
    );
    // Plant the sentinel.
    const sentinelDir = profileDir("default", { repoRoot: repo });
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, ".no-default-allowed"), "");

    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "delete",
          name: "default",
          deleteFlags: { force: false, skipDocker: true, yes: true },
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrowError(/no-default-allowed/);
  });

  it("--force overrides the default-profile guard", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const code = await runProfile(
      {
        subcommand: "delete",
        name: "alpha",
        deleteFlags: { force: true, skipDocker: true, yes: true },
      },
      depsFor(home, repo, cap),
    );
    expect(code).toBe(0);
  });

  it("non-TTY without --yes refuses (avoids accidental rm in CI)", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);
    await createProfile("beta", home, repo);
    // Move default off alpha
    const { saveConfig } = await import("../src/arianna-config.js");
    const cfg = loadConfig({ ariannaHome: home });
    cfg.defaultProfile = "beta";
    saveConfig(cfg, { ariannaHome: home });

    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "delete",
          name: "alpha",
          deleteFlags: { force: false, skipDocker: true, yes: false },
        },
        depsFor(home, repo, cap, { isTTY: () => false }),
      ),
    ).rejects.toThrowError(/non-TTY/);
  });

  it("survives docker compose down failure (warns + continues)", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);
    await createProfile("beta", home, repo);
    const { saveConfig } = await import("../src/arianna-config.js");
    const cfg = loadConfig({ ariannaHome: home });
    cfg.defaultProfile = "beta";
    saveConfig(cfg, { ariannaHome: home });

    const cap: Capture = { out: "", err: "" };
    const code = await runProfile(
      {
        subcommand: "delete",
        name: "alpha",
        deleteFlags: { force: false, skipDocker: false, yes: true },
      },
      depsFor(home, repo, cap, {
        exec: async () => { throw new Error("docker daemon not running"); },
      }),
    );
    expect(code).toBe(0);
    expect(cap.err).toMatch(/warn: docker compose down/);
    expect(existsSync(profileDir("alpha", { repoRoot: repo }))).toBe(false);
    const cfgAfter = loadConfig({ ariannaHome: home });
    expect(cfgAfter.profiles.has("alpha")).toBe(false);
  });

  it("--skip-docker omits the exec call entirely", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);
    await createProfile("beta", home, repo);
    const { saveConfig } = await import("../src/arianna-config.js");
    const cfg = loadConfig({ ariannaHome: home });
    cfg.defaultProfile = "beta";
    saveConfig(cfg, { ariannaHome: home });

    const cap: Capture = { out: "", err: "" };
    const execCalls: ExecCall[] = [];

    await runProfile(
      {
        subcommand: "delete",
        name: "alpha",
        deleteFlags: { force: false, skipDocker: true, yes: true },
      },
      depsFor(home, repo, cap, {
        exec: async (cmd: string) => {
          execCalls.push({ cmd });
          return { stdout: "", stderr: "" };
        },
      }),
    );
    expect(execCalls).toHaveLength(0);
    expect(cap.out).toMatch(/skipped docker compose down/);
  });

  it("rejects when nothing to delete", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "delete",
          name: "ghost",
          deleteFlags: { force: false, skipDocker: true, yes: true },
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrowError(/not in.*config/);
  });

  it("name validation prevents shell-metachar interpolation", async () => {
    // The argv parser is the first line of defence — confirm runProfile
    // also rejects a hand-rolled bad name (defense in depth for callers
    // that bypass argv).
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    await expect(
      runProfile(
        {
          subcommand: "delete",
          // Cast through unknown — we're intentionally testing the runtime guard.
          name: "alpha; rm -rf /tmp" as string,
          deleteFlags: { force: false, skipDocker: true, yes: true },
        },
        depsFor(home, repo, cap),
      ),
    ).rejects.toThrow();
  });

  it("config file no longer contains the deleted profile", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);
    await createProfile("beta", home, repo);
    const { saveConfig } = await import("../src/arianna-config.js");
    const cfg = loadConfig({ ariannaHome: home });
    cfg.defaultProfile = "beta";
    saveConfig(cfg, { ariannaHome: home });

    const cap: Capture = { out: "", err: "" };
    await runProfile(
      {
        subcommand: "delete",
        name: "alpha",
        deleteFlags: { force: false, skipDocker: true, yes: true },
      },
      depsFor(home, repo, cap),
    );
    const text = readFileSync(ariannaConfigPath({ ariannaHome: home }), "utf-8");
    expect(text).not.toMatch(/\[profile alpha\]/);
    expect(text).toMatch(/\[profile beta\]/);
  });
});
