import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProfileCommandError,
  runProfile,
} from "../src/commands/profile.js";
import {
  ariannaConfigPath,
  profileDir,
  profileOverridePath,
} from "../src/paths.js";
import { loadConfig, saveConfig } from "../src/arianna-config.js";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-cmd-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-cmd-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

interface MockDeps {
  out: string;
  err: string;
}

function deps(home: string, repo: string, mock: MockDeps, extra: Partial<Parameters<typeof runProfile>[1]> = {}) {
  return {
    write: (s: string) => { mock.out += s; },
    warn: (s: string) => { mock.err += s; },
    ariannaHome: home,
    repoRoot: repo,
    skipBindTest: true,
    now: () => 1714603200000,
    // Force local-route by default — tests cover the local-create flow. The
    // daemon-route tests (Gap 12) override this with a probe that throws to
    // simulate a docker-less environment (OpenClaw container case).
    dockerProbe: () => { /* docker --version succeeds */ },
    ...extra,
  } as Parameters<typeof runProfile>[1];
}

describe("arianna profile create", () => {
  it("creates a workspace dir, writes compose.override.yml, registers in ~/.arianna/config", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };

    const code = await runProfile({ subcommand: "create", name: "alpha" }, deps(home, repo, out));
    expect(code).toBe(0);

    // Workspace artifact written.
    const overridePath = profileOverridePath("alpha", { repoRoot: repo });
    expect(existsSync(overridePath)).toBe(true);
    expect(readFileSync(overridePath, "utf-8")).toMatch(/127\.0\.0\.1:3000:3000/);

    // Config registered.
    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.profiles.get("alpha")).toEqual({ portOffset: 0, createdAt: 1714603200000 });

    // First profile becomes default.
    expect(cfg.defaultProfile).toBe("alpha");

    expect(out.out).toMatch(/Created profile "alpha"/);
  });

  it("subsequent profile creates pick the next free offset and don't override default", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };

    await runProfile({ subcommand: "create", name: "alpha" }, deps(home, repo, out));
    await runProfile({ subcommand: "create", name: "beta" }, deps(home, repo, out));

    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.profiles.get("alpha")?.portOffset).toBe(0);
    expect(cfg.profiles.get("beta")?.portOffset).toBe(1);
    // Default stays alpha (the first one).
    expect(cfg.defaultProfile).toBe("alpha");

    // Beta override has the shifted ports.
    const betaPath = profileOverridePath("beta", { repoRoot: repo });
    expect(readFileSync(betaPath, "utf-8")).toMatch(/127\.0\.0\.1:3001:3000/);
  });

  it("rejects creating an existing profile", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    await runProfile({ subcommand: "create", name: "alpha" }, deps(home, repo, out));
    await expect(
      runProfile({ subcommand: "create", name: "alpha" }, deps(home, repo, out)),
    ).rejects.toThrowError(ProfileCommandError);
  });

  it("refuses if the directory exists but config doesn't list it", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    const dir = profileDir("orphan", { repoRoot: repo });
    // Pre-existing untracked profile dir — we don't want to overwrite it.
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
    mkdirSync(dir, { recursive: true });
    await expect(
      runProfile({ subcommand: "create", name: "orphan" }, deps(home, repo, out)),
    ).rejects.toThrowError(/already exists/);
  });
});

// Gap 12 (validation agent abf126be, 2026-05-09): when local docker is
// missing (OpenClaw container case) `arianna profile create` must POST to
// the daemon's /profile-create endpoint instead of writing files locally.
// The daemon owns the host filesystem; the container only writes its own
// ~/.arianna/config so subsequent `arianna talk` resolves the right
// port_offset.
describe("arianna profile create — daemon-route fallback", () => {
  function dockerlessProbe(): () => void {
    return () => {
      throw new Error("docker: command not found");
    };
  }

  it("POSTs /profile-create when local docker is missing and writes the local config from the response", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };

    let posted: { url: string; method: string } | null = null;
    const fetcher: typeof globalThis.fetch = (async (url: string, init: RequestInit) => {
      posted = { url, method: String(init.method) };
      return new Response(
        JSON.stringify({
          ok: true,
          name: "alpha",
          portOffset: 5,
          vesselPort: 3005,
          sidecarPort: 8005,
          daemonPort: 9000,
          profileDir: "/host/repo/workspace/profiles/alpha",
          composeOverride: "/host/repo/workspace/profiles/alpha/compose.override.yml",
          isDefault: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const code = await runProfile(
      { subcommand: "create", name: "alpha" },
      deps(home, repo, out, {
        dockerProbe: dockerlessProbe(),
        fetch: fetcher,
        daemonUrl: "http://host.docker.internal:9000",
      }),
    );
    expect(code).toBe(0);

    // The daemon got POSTed with the right path.
    expect(posted).not.toBeNull();
    expect(posted!.method.toUpperCase()).toBe("POST");
    expect(posted!.url).toMatch(/\/profile-create\?name=alpha$/);

    // No local file writes for the profile dir or override — the daemon owns
    // those on the host filesystem.
    expect(existsSync(profileDir("alpha", { repoRoot: repo }))).toBe(false);
    expect(existsSync(profileOverridePath("alpha", { repoRoot: repo }))).toBe(false);

    // Local ~/.arianna/config IS written so subsequent `arianna talk`
    // resolves the profile to the daemon-allocated port.
    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.profiles.get("alpha")?.portOffset).toBe(5);
    expect(cfg.defaultProfile).toBe("alpha");

    expect(out.out).toMatch(/Created profile "alpha" via daemon/);
    expect(out.out).toMatch(/port_offset=5 vessel:3005 sidecar:8005/);
  });

  it("--use-daemon forces the daemon route even when local docker is available", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };

    let called = false;
    const fetcher: typeof globalThis.fetch = (async () => {
      called = true;
      return new Response(
        JSON.stringify({ ok: true, name: "beta", portOffset: 0, isDefault: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const code = await runProfile(
      { subcommand: "create", name: "beta", create: { useDaemon: true } },
      deps(home, repo, out, {
        // dockerProbe returns success — local docker IS available, but
        // --use-daemon overrides the auto-detect.
        fetch: fetcher,
      }),
    );
    expect(code).toBe(0);
    expect(called).toBe(true);
    expect(existsSync(profileOverridePath("beta", { repoRoot: repo }))).toBe(false);
  });

  it("surfaces daemon error response with code hint", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };

    const fetcher: typeof globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: "Profile already exists in ~/.arianna/config", code: "profile-exists" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    await expect(
      runProfile(
        { subcommand: "create", name: "alpha" },
        deps(home, repo, out, {
          dockerProbe: dockerlessProbe(),
          fetch: fetcher,
        }),
      ),
    ).rejects.toThrowError(/code=profile-exists/);
  });

  it("rejects --provider/--model/--api-key flags on the daemon route", async () => {
    // Session-config flag passing isn't supported on the daemon route — the
    // daemon endpoint is intentionally minimal. Operators are pointed at
    // `arianna profile import` for follow-up.
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };

    await expect(
      runProfile(
        {
          subcommand: "create",
          name: "alpha",
          create: { provider: "anthropic", model: "claude-x", apiKey: "k", aiName: "Vex" },
        },
        deps(home, repo, out, {
          dockerProbe: dockerlessProbe(),
          fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch,
        }),
      ),
    ).rejects.toThrowError(/can't be used with daemon-route profile create/);
  });

  it("daemon-unreachable error includes ARIANNA_DAEMON_URL hint", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };

    const fetcher: typeof globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      runProfile(
        { subcommand: "create", name: "alpha" },
        deps(home, repo, out, {
          dockerProbe: dockerlessProbe(),
          fetch: fetcher,
          daemonUrl: "http://host.docker.internal:9000",
        }),
      ),
    ).rejects.toThrowError(/ARIANNA_DAEMON_URL to override/);
  });
});

describe("arianna profile use", () => {
  it("sets the default profile", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    await runProfile({ subcommand: "create", name: "alpha" }, deps(home, repo, out));
    await runProfile({ subcommand: "create", name: "beta" }, deps(home, repo, out));
    out.out = "";

    await runProfile({ subcommand: "use", name: "beta" }, deps(home, repo, out));
    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.defaultProfile).toBe("beta");
    expect(out.out).toMatch(/Default profile set to "beta"/);
  });

  it("rejects unknown profiles", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    await expect(
      runProfile({ subcommand: "use", name: "ghost" }, deps(home, repo, out)),
    ).rejects.toThrowError(ProfileCommandError);
  });
});

describe("arianna profile list", () => {
  it("prints '(no profiles)' when config is empty", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    await runProfile({ subcommand: "list" }, deps(home, repo, out));
    expect(out.out).toMatch(/no profiles/);
  });

  it("renders a table with port columns and default marker", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    await runProfile({ subcommand: "create", name: "alpha" }, deps(home, repo, out));
    await runProfile({ subcommand: "create", name: "beta" }, deps(home, repo, out));
    out.out = "";

    await runProfile({ subcommand: "list" }, deps(home, repo, out));
    expect(out.out).toMatch(/alpha\s+0\s+3000\s+8000\s+9000 \(shared\)\s+\*/);
    expect(out.out).toMatch(/beta\s+1\s+3001\s+8001\s+9000 \(shared\)/);
  });
});

describe("arianna profile current", () => {
  it("prints the resolved profile and source", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    await runProfile({ subcommand: "create", name: "alpha" }, deps(home, repo, out));
    out.out = "";
    await runProfile(
      { subcommand: "current" },
      deps(home, repo, out, { env: {} }),
    );
    expect(out.out).toMatch(/^alpha\t\(source: config-default\)/);
  });

  it("falls back to implicit-default and tags the source", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    // No profiles configured — implicit-default kicks in.
    await runProfile(
      { subcommand: "current" },
      deps(home, repo, out, { env: {} }),
    );
    expect(out.out).toMatch(/^default\t\(source: implicit-default\)/);
  });

  it("reports a clear message when sentinel blocks implicit-default", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    const sentinelDir = profileDir("default", { repoRoot: repo });
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, ".no-default-allowed"), "");
    await runProfile(
      { subcommand: "current" },
      deps(home, repo, out, { env: {} }),
    );
    expect(out.out).toMatch(/no profile resolved.*\.no-default-allowed/);
  });
});

describe("integration: write then read", () => {
  it("config written by `create` is what `list` and `current` see", async () => {
    const { home, repo } = mk();
    const out: MockDeps = { out: "", err: "" };
    await runProfile({ subcommand: "create", name: "alpha" }, deps(home, repo, out));

    // Direct config inspection — the format on disk matters since downstream
    // worktrees and a future install.sh will want to scan it.
    const text = readFileSync(ariannaConfigPath({ ariannaHome: home }), "utf-8");
    expect(text).toMatch(/\[default\]/);
    expect(text).toMatch(/profile = alpha/);
    expect(text).toMatch(/\[profile alpha\]/);
    expect(text).toMatch(/port_offset = 0/);
    expect(text).toMatch(/created_at = 1714603200000/);

    // Roundtrip via saveConfig overwriting cleanly.
    const cfg = loadConfig({ ariannaHome: home });
    cfg.profiles.set("manual", { portOffset: 50 });
    saveConfig(cfg, { ariannaHome: home });
    const reloaded = loadConfig({ ariannaHome: home });
    expect(reloaded.profiles.get("manual")?.portOffset).toBe(50);
  });
});
