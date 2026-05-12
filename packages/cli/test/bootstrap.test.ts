import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureBootstrapped, resolveProfileSeedPaths, VesselUnreachableError } from "../src/bootstrap.js";
import { runBootstrap, BootstrapCommandError } from "../src/commands/bootstrap.js";
import { resolveConfig } from "../src/config.js";
import { buildFiloPreludeText } from "../src/filo-prelude.js";
import { isLocalDockerAvailable } from "../src/compose-up.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-boot-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-boot-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

describe("ensureBootstrapped", () => {
  it("is a no-op when /status reports bootstrapped:true", async () => {
    let bootstrapCalls = 0;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: true, aiName: "x" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        bootstrapCalls++;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await ensureBootstrapped(
      resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false }),
      { fetch: fetch as never },
    );

    expect(result.alreadyBootstrapped).toBe(true);
    expect(result.bootstrapped).toBe(false);
    expect(bootstrapCalls).toBe(0);
  });

  it("POSTs /bootstrap with imported messages from imported-messages.jsonl when present", async () => {
    const { home, repo } = mk();
    const profileDir = join(repo, "workspace", "profiles", "alpha");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "imported-messages.jsonl"),
      [
        JSON.stringify({ role: "user", content: "hi" }),
        JSON.stringify({ role: "assistant", content: "hello" }),
        "",
        "{not-json}", // malformed line — must be skipped, not crash
      ].join("\n"),
    );
    // Register the profile in ~/.arianna/config so resolveConfig picks it up.
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 0\n",
    );

    const calls: { url: string; body?: string }[] = [];
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push({ url: u, body: init?.body as string | undefined });
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "x" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await ensureBootstrapped(
      resolveConfig({ env: {}, ariannaHome: home, repoRoot: repo, allowImplicitDefault: false }),
      { fetch: fetch as never, pathOpts: { ariannaHome: home, repoRoot: repo } },
    );

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessageCount).toBe(2);

    const bootstrapCall = calls.find((c) => c.url.endsWith("/bootstrap"));
    expect(bootstrapCall).toBeTruthy();
    const body = JSON.parse(bootstrapCall!.body!);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe("hi");
  });

  it("idempotency: a second runBootstrap call after a successful one is a no-op (uses /status)", async () => {
    let isBootstrapped = false;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: isBootstrapped, aiName: "x" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        isBootstrapped = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const writes1: string[] = [];
    const writes2: string[] = [];
    const cfg = resolveConfig({ env: {}, ariannaHome: ISOLATED_ARIANNA_HOME, allowImplicitDefault: false });

    const code1 = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes1.push(l),
    });
    const code2 = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes2.push(l),
    });

    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(writes1.join("")).toMatch(/Bootstrapped vessel/);
    // Second call: vessel /status reports bootstrapped:true → "already
    // bootstrapped" message, no second POST /bootstrap call.
    expect(writes2.join("")).toMatch(/already bootstrapped/);

    const bootstrapPosts = fetch.mock.calls.filter((c) => {
      const u = typeof c[0] === "string" ? c[0] : (c[0] as URL).toString();
      return u.endsWith("/bootstrap");
    });
    expect(bootstrapPosts).toHaveLength(1);
  });

  it("falls back to legacy workspace/imported-messages.jsonl when default profile is not registered", async () => {
    const { home, repo } = mk();
    // Register no profiles. resolveProfile in implicit-default mode returns
    // name="default" but ~/.arianna/config has no [profile default] section,
    // so resolveProfileSeedPaths must fall back to legacy paths.
    const paths = resolveProfileSeedPaths(
      { profile: "default" },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(paths.importedMessagesPath).toBe(
      join(repo, "workspace", "imported-messages.jsonl"),
    );
    expect(paths.sessionConfigPath).toBe(
      join(repo, "workspace", "session_config.json"),
    );
  });

  it("uses profile-aware paths when default IS registered", async () => {
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = default\n\n[profile default]\nport_offset = 0\n",
    );
    const paths = resolveProfileSeedPaths(
      { profile: "default" },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(paths.importedMessagesPath).toBe(
      join(repo, "workspace", "profiles", "default", "imported-messages.jsonl"),
    );
  });
});

describe("runBootstrap --seed-from-jsonl", () => {
  it("parses an OpenClaw / pi-coding-agent JSONL session and POSTs its messages to /bootstrap", async () => {
    const { home, repo } = mk();
    // Register a fresh profile with no existing seed file.
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = beta\n\n[profile beta]\nport_offset = 0\n",
    );
    mkdirSync(join(repo, "workspace", "profiles", "beta"), { recursive: true });

    const calls: { url: string; body?: string }[] = [];
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push({ url: u, body: init?.body as string | undefined });
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "x" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(
      cfg,
      {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
      },
      { seedFromJsonl: join(FIXTURES_DIR, "openclaw-session.jsonl") },
    );

    expect(code).toBe(0);

    // The seed JSONL was written to disk under the profile.
    const seedPath = join(
      repo,
      "workspace",
      "profiles",
      "beta",
      "imported-messages.jsonl",
    );
    expect(existsSync(seedPath)).toBe(true);
    const seedRaw = readFileSync(seedPath, "utf-8");
    const seedLines = seedRaw.split("\n").filter((l) => l.length > 0);
    // Fixture has 4 user/assistant entries (model_change is filtered out).
    expect(seedLines).toHaveLength(4);

    // The vessel /bootstrap call carried those 4 messages.
    const bootstrapCall = calls.find((c) => c.url.endsWith("/bootstrap"));
    expect(bootstrapCall).toBeTruthy();
    const body = JSON.parse(bootstrapCall!.body!);
    expect(body.messages).toHaveLength(4);
    // Content-block array shape preserved (assistant message in fixture has
    // content as an array of pi-ai blocks).
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
    expect(Array.isArray(body.messages[1].content)).toBe(true);

    // Operator-facing summary on stdout.
    const out = writes.join("");
    expect(out).toMatch(/Seeded 4 messages/);
    expect(out).toMatch(/Bootstrapped vessel with 4 imported messages/);
  });

  it("refuses to clobber an existing seed file", async () => {
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = beta\n\n[profile beta]\nport_offset = 0\n",
    );
    const profileDir = join(repo, "workspace", "profiles", "beta");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "imported-messages.jsonl"),
      JSON.stringify({ role: "user", content: "earlier seed" }) + "\n",
    );

    const fetch = vi.fn(async () => {
      throw new Error("vessel fetch should not be reached when seed conflicts");
    });

    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    await expect(
      runBootstrap(
        cfg,
        {
          fetch: fetch as never,
          write: () => {},
          pathOpts: { ariannaHome: home, repoRoot: repo },
        },
        { seedFromJsonl: join(FIXTURES_DIR, "openclaw-session.jsonl") },
      ),
    ).rejects.toBeInstanceOf(BootstrapCommandError);
  });

  it("when vessel is already bootstrapped, writes seed to disk but warns it won't take effect until the next fresh bootstrap", async () => {
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = beta\n\n[profile beta]\nport_offset = 0\n",
    );
    mkdirSync(join(repo, "workspace", "profiles", "beta"), { recursive: true });

    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: true, aiName: "asha" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(
      cfg,
      {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
      },
      { seedFromJsonl: join(FIXTURES_DIR, "openclaw-session.jsonl") },
    );

    expect(code).toBe(0);
    const seedPath = join(
      repo,
      "workspace",
      "profiles",
      "beta",
      "imported-messages.jsonl",
    );
    expect(existsSync(seedPath)).toBe(true);
    expect(writes.join("")).toMatch(/already bootstrapped/);
    expect(writes.join("")).toMatch(/seed written to disk but not applied/);
  });

  it("auto-ups the docker compose stack when nothing is running, then bootstraps the vessel", async () => {
    // Regression for canary acb7b292: previously the driver had to manually
    // `docker compose -p arianna-canary-001 -f ... up -d` after `arianna
    // profile create` and before `arianna bootstrap`. Now bootstrap probes
    // for running services, finds none, runs `up -d` itself, then proceeds.
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = canary-test\n\n[profile canary-test]\nport_offset = 7\n",
    );
    mkdirSync(join(repo, "workspace", "profiles", "canary-test"), {
      recursive: true,
    });
    writeFileSync(
      join(repo, "workspace", "profiles", "canary-test", "session_config.json"),
      JSON.stringify({
        aiUsername: "echo",
        aiName: "Echo",
        externalLlmApiKey: "k-stub",
        provider: "anthropic",
        modelId: "claude-opus-4-7",
        sessionId: "sess-xyz",
      }),
    );

    const execCalls: { cmd: string; env?: NodeJS.ProcessEnv }[] = [];
    let stackUp = false;
    const exec = vi.fn(
      async (cmd: string, opts?: { env?: NodeJS.ProcessEnv }) => {
        execCalls.push({ cmd, env: opts?.env });
        if (cmd.includes("ps --services --filter status=running")) {
          // First call: stack down (empty stdout). After `up -d`, services
          // would be running, but bootstrap only probes once.
          return { stdout: stackUp ? "vessel\nsidecar\n" : "", stderr: "" };
        }
        if (cmd.includes(" up -d")) {
          stackUp = true;
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected exec ${cmd}`);
      },
    );

    let vesselUp = false;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      // Vessel comes online only after `up -d` ran (stackUp flipped).
      if (!stackUp) throw new TypeError("fetch failed");
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: vesselUp, aiName: "Echo" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        vesselUp = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
      exec,
      // Force the local-docker route so this test is deterministic regardless
      // of whether the host running it has docker installed (CI without docker
      // would otherwise auto-fall-back to the daemon route and reject our
      // exec-based assertions).
      dockerProbe: () => {},
    });

    expect(code).toBe(0);

    // Verify the compose command targets the right profile / project / files.
    const psCall = execCalls.find((c) =>
      c.cmd.includes("ps --services --filter status=running"),
    );
    expect(psCall).toBeTruthy();
    expect(psCall!.cmd).toContain("docker compose -p arianna-canary-test");
    expect(psCall!.cmd).toContain(
      "-f workspace/profiles/canary-test/compose.override.yml",
    );

    const upCall = execCalls.find((c) => c.cmd.includes(" up -d"));
    expect(upCall).toBeTruthy();
    expect(upCall!.cmd).toContain("docker compose -p arianna-canary-test");
    expect(upCall!.cmd).toContain(" up -d --remove-orphans");
    // Env from session_config.json was threaded into the up command.
    expect(upCall!.env?.AI_USERNAME).toBe("echo");
    expect(upCall!.env?.API_KEY).toBe("k-stub");
    expect(upCall!.env?.ARIANNA_SESSION_ID).toBe("sess-xyz");
    expect(upCall!.env?.ARIANNA_VESSEL_TAG).toBe("sess-xyz-current");

    // Bootstrap fetched /status + POSTed /bootstrap after the stack came up.
    const statusCall = fetch.mock.calls.find((c) =>
      (typeof c[0] === "string" ? c[0] : (c[0] as URL).toString()).endsWith(
        "/status",
      ),
    );
    const bootstrapCall = fetch.mock.calls.find((c) =>
      (typeof c[0] === "string" ? c[0] : (c[0] as URL).toString()).endsWith(
        "/bootstrap",
      ),
    );
    expect(statusCall).toBeTruthy();
    expect(bootstrapCall).toBeTruthy();

    expect(writes.join("")).toMatch(/Bringing up docker compose stack/);
    expect(writes.join("")).toMatch(/Bootstrapped vessel/);
  });

  it("skips `up -d` when the stack is already running (operators see no new behavior)", async () => {
    // Existing operators who already had `docker compose up -d` running
    // before invoking `arianna bootstrap` shouldn't see any new behavior
    // (no extra log lines, no spurious recreate). Probe finds running
    // services and short-circuits.
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = warm\n\n[profile warm]\nport_offset = 0\n",
    );
    mkdirSync(join(repo, "workspace", "profiles", "warm"), { recursive: true });

    const execCalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.includes("ps --services --filter status=running")) {
        return { stdout: "vessel\nsidecar\n", stderr: "" };
      }
      throw new Error(`unexpected exec ${cmd} (up -d should NOT run)`);
    });

    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: true, aiName: "x" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
      exec,
      dockerProbe: () => {}, // force local route for determinism
    });

    expect(code).toBe(0);
    // Only the probe ran; no `up -d` call, no extra log lines about bringing
    // the stack up.
    expect(execCalls).toHaveLength(1);
    expect(writes.join("")).not.toMatch(/Bringing up docker compose stack/);
    expect(writes.join("")).toMatch(/already bootstrapped/);
  });

  it("surfaces an actionable error when `docker compose up -d` itself fails", async () => {
    // Path B failure surface: if the auto-up path can't bring up the stack
    // (docker daemon not running, port collision, build failure), bootstrap
    // wraps the head of the compose error in a BootstrapCommandError that
    // names the project and the canonical command to retry directly.
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = bust\n\n[profile bust]\nport_offset = 0\n",
    );
    mkdirSync(join(repo, "workspace", "profiles", "bust"), { recursive: true });

    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("ps --services --filter status=running")) {
        return { stdout: "", stderr: "" };
      }
      if (cmd.includes(" up -d")) {
        throw new Error(
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        );
      }
      throw new Error(`unexpected exec ${cmd}`);
    });

    const fetch = vi.fn(async () => {
      throw new Error("fetch should not be reached when up -d fails");
    });

    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    await expect(
      runBootstrap(cfg, {
        fetch: fetch as never,
        write: () => {},
        pathOpts: { ariannaHome: home, repoRoot: repo },
        exec,
        dockerProbe: () => {}, // force local route for determinism
      }),
    ).rejects.toMatchObject({
      name: "BootstrapCommandError",
      message: expect.stringMatching(/docker compose up -d failed for project arianna-bust/),
    });
  });

  it("rejects a missing seed source path before mutating any state", async () => {
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = beta\n\n[profile beta]\nport_offset = 0\n",
    );

    const fetch = vi.fn(async () => {
      throw new Error("fetch should not be reached when source path is missing");
    });

    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    await expect(
      runBootstrap(
        cfg,
        {
          fetch: fetch as never,
          write: () => {},
          pathOpts: { ariannaHome: home, repoRoot: repo },
        },
        { seedFromJsonl: "/no/such/file.jsonl" },
      ),
    ).rejects.toBeInstanceOf(BootstrapCommandError);

    // Profile dir should not have been touched.
    const seedPath = join(
      repo,
      "workspace",
      "profiles",
      "beta",
      "imported-messages.jsonl",
    );
    expect(existsSync(seedPath)).toBe(false);
  });
});

describe("runBootstrap auto-injects the Filo prelude", () => {
  // Default behavior: a fresh `arianna bootstrap` writes the canonical Filo
  // opening box into imported-messages.jsonl so headless incubations match
  // the TUI flow. Surfaced by canary acb7b292 (Lume run, 2026-05-09): CLI
  // bootstrap was waking the AI as a generic stock assistant because the
  // prelude was TUI-only.

  function setupProfile(opts: { aiName?: string | null } = { aiName: "Lume" }): {
    home: string;
    repo: string;
    seedPath: string;
    sessionConfigPath: string;
  } {
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = beta\n\n[profile beta]\nport_offset = 0\n",
    );
    const profileDir = join(repo, "workspace", "profiles", "beta");
    mkdirSync(profileDir, { recursive: true });
    const sessionConfigPath = join(profileDir, "session_config.json");
    if (opts.aiName !== null && opts.aiName !== undefined) {
      writeFileSync(
        sessionConfigPath,
        JSON.stringify({
          externalLlmApiKey: "test-key",
          provider: "google",
          modelId: "gemini-2.5-flash",
          aiName: opts.aiName,
          aiUsername: opts.aiName.toLowerCase(),
          difficulty: "normal",
          createdAt: 1700000000000,
          sessionId: "session_1700000000000",
        }),
      );
    }
    return {
      home,
      repo,
      seedPath: join(profileDir, "imported-messages.jsonl"),
      sessionConfigPath,
    };
  }

  function makeBootstrapFetch(): {
    fetch: ReturnType<typeof vi.fn>;
    calls: { url: string; body?: string }[];
  } {
    const calls: { url: string; body?: string }[] = [];
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push({ url: u, body: init?.body as string | undefined });
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "Lume" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    return { fetch, calls };
  }

  it("writes the canonical Filo prelude to imported-messages.jsonl on a fresh bootstrap", async () => {
    const { home, repo, seedPath } = setupProfile({ aiName: "Lume" });
    const { fetch, calls } = makeBootstrapFetch();
    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
    });

    expect(code).toBe(0);

    // The seed file is on disk with exactly the canonical prelude.
    expect(existsSync(seedPath)).toBe(true);
    const seedRaw = readFileSync(seedPath, "utf-8").trim();
    const lines = seedRaw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const msg = JSON.parse(lines[0]);
    expect(msg.role).toBe("user");
    expect(msg.sender).toBe("external");
    expect(msg.content).toBe(buildFiloPreludeText("Lume"));

    // The vessel /bootstrap call carried it through.
    const bootstrapCall = calls.find((c) => c.url.endsWith("/bootstrap"));
    expect(bootstrapCall).toBeTruthy();
    const body = JSON.parse(bootstrapCall!.body!);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe(buildFiloPreludeText("Lume"));

    expect(writes.join("")).toMatch(/Auto-injected Filo opening prelude for "Lume"/);
  });

  it("does NOT inject when --no-prelude is passed", async () => {
    const { home, repo, seedPath } = setupProfile({ aiName: "Lume" });
    const { fetch, calls } = makeBootstrapFetch();
    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(
      cfg,
      {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
      },
      { noPrelude: true },
    );

    expect(code).toBe(0);
    expect(existsSync(seedPath)).toBe(false);
    expect(writes.join("")).not.toMatch(/Auto-injected/);
    expect(writes.join("")).toMatch(/blank canvas/);

    // Vessel /bootstrap still called, but with empty messages.
    const bootstrapCall = calls.find((c) => c.url.endsWith("/bootstrap"));
    expect(bootstrapCall).toBeTruthy();
    const body = JSON.parse(bootstrapCall!.body!);
    expect(body.messages).toEqual([]);
  });

  it("does NOT inject when imported-messages.jsonl already exists (e.g. profile import ran first)", async () => {
    const { home, repo, seedPath } = setupProfile({ aiName: "Lume" });
    // Pre-existing seed file from `arianna profile import`.
    const preExisting = JSON.stringify({ role: "user", content: "earlier seed" });
    writeFileSync(seedPath, preExisting + "\n");

    const { fetch } = makeBootstrapFetch();
    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
    });

    expect(code).toBe(0);
    // File preserved byte-equal — no clobber, no append.
    expect(readFileSync(seedPath, "utf-8")).toBe(preExisting + "\n");
    expect(writes.join("")).not.toMatch(/Auto-injected/);
  });

  it("does NOT inject when --seed-from-jsonl is provided (the seed wins)", async () => {
    const { home, repo, seedPath } = setupProfile({ aiName: "Lume" });
    const { fetch } = makeBootstrapFetch();
    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(
      cfg,
      {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
      },
      { seedFromJsonl: join(FIXTURES_DIR, "openclaw-session.jsonl") },
    );

    expect(code).toBe(0);
    // Seed file contains the OpenClaw session messages, NOT the prelude.
    const seedRaw = readFileSync(seedPath, "utf-8").trim();
    expect(seedRaw).not.toContain("I'm Filo. I talk in boxes like this one.");
    expect(writes.join("")).not.toMatch(/Auto-injected/);
    expect(writes.join("")).toMatch(/Seeded \d+ messages/);
  });

  it("warns and skips when session_config.json has no aiName", async () => {
    const { home, repo, seedPath } = setupProfile({ aiName: null });
    const { fetch } = makeBootstrapFetch();
    const writes: string[] = [];
    const warns: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      warn: (l) => warns.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
    });

    expect(code).toBe(0);
    expect(existsSync(seedPath)).toBe(false);
    expect(warns.join("")).toMatch(/Filo prelude skipped — no aiName/);
  });

  it("threads the AI name from session_config.json into the prelude (not from /status)", async () => {
    const { home, repo, seedPath } = setupProfile({ aiName: "Mira" });
    // Make /status return a DIFFERENT name so we can prove the source is
    // session_config.json, not the vessel response.
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "GenericAssistant" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
    });

    const seedRaw = readFileSync(seedPath, "utf-8").trim();
    const msg = JSON.parse(seedRaw);
    expect(msg.content).toContain("Mira. You're awake.");
    expect(msg.content).not.toContain("GenericAssistant");
  });

  it("a second runBootstrap call after a successful one is a no-op (vessel reports bootstrapped, no double-inject)", async () => {
    const { home, repo, seedPath } = setupProfile({ aiName: "Lume" });

    let isBootstrapped = false;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: isBootstrapped, aiName: "Lume" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        isBootstrapped = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const writes1: string[] = [];
    const writes2: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes1.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
    });
    expect(writes1.join("")).toMatch(/Auto-injected/);

    // Capture the seed file contents after the first run; the second run
    // must not modify it.
    const firstSeed = readFileSync(seedPath, "utf-8");

    await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes2.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
    });

    expect(writes2.join("")).toMatch(/already bootstrapped/);
    expect(writes2.join("")).not.toMatch(/Auto-injected/);
    expect(readFileSync(seedPath, "utf-8")).toBe(firstSeed);
  });
});

describe("isLocalDockerAvailable", () => {
  // Docker-detection probe used by ensureComposeUp to decide between the
  // local-route (`docker compose up -d` direct exec) and the daemon-route
  // fallback (POST /compose-up to the host daemon over HTTP). Test seam is
  // the optional execProbe arg — production passes nothing and gets the real
  // `execSync('docker --version')` probe.

  it("returns true when the probe succeeds (docker on PATH)", () => {
    expect(isLocalDockerAvailable(() => {})).toBe(true);
  });

  it("returns false when the probe throws (docker missing — openclaw container)", () => {
    expect(
      isLocalDockerAvailable(() => {
        throw new Error("docker: command not found");
      }),
    ).toBe(false);
  });
});

describe("runBootstrap daemon-route fallback (no local docker)", () => {
  // Canonical case: `arianna bootstrap` running inside an OpenClaw container.
  // No docker binary on PATH, but the daemon is reachable via
  // host.docker.internal:9000. ensureComposeUp must POST /compose-up to the
  // daemon and let it run docker compose up -d server-side.
  //
  // See packages/cli/src/compose-up.ts (isLocalDockerAvailable +
  // daemonComposeUp) and packages/host/src/daemon.ts (POST /compose-up).

  function setupCanaryProfile() {
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = openclaw-test\n\n[profile openclaw-test]\nport_offset = 0\n",
    );
    mkdirSync(join(repo, "workspace", "profiles", "openclaw-test"), {
      recursive: true,
    });
    writeFileSync(
      join(repo, "workspace", "profiles", "openclaw-test", "session_config.json"),
      JSON.stringify({
        aiUsername: "echo",
        aiName: "Echo",
        externalLlmApiKey: "k-stub",
        provider: "anthropic",
        modelId: "claude-opus-4-7",
        sessionId: "sess-xyz",
      }),
    );
    return { home, repo };
  }

  it("auto-detects missing local docker and POSTs /compose-up to the daemon", async () => {
    const { home, repo } = setupCanaryProfile();

    // Track every fetch — we need to confirm the daemon URL gets the right
    // profile + the vessel /bootstrap follow-up still happens normally.
    const fetchCalls: { url: string; method: string; body?: string }[] = [];
    let composeUpCalled = false;
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      fetchCalls.push({
        url: u,
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
      });
      if (u.includes("/compose-up")) {
        composeUpCalled = true;
        return new Response(
          JSON.stringify({ ok: true, broughtUp: true, alreadyUp: false }),
          { status: 200 },
        );
      }
      if (u.endsWith("/status")) {
        // Vessel comes online only after compose-up landed.
        if (!composeUpCalled) throw new TypeError("fetch failed");
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "Echo" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    // exec is wired (the dispatcher always wires it in production), but the
    // dockerProbe forces "no local docker" so the daemon route is taken and
    // exec is never called.
    const exec = vi.fn(async () => {
      throw new Error(
        "exec must NOT run on the daemon route — caller forced --use-daemon implicitly via probe failure",
      );
    });

    const code = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
      exec,
      dockerProbe: () => {
        throw new Error("docker not on PATH (simulated openclaw container)");
      },
    });

    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();

    // Daemon /compose-up was POSTed with the resolved profile name.
    const composeUpCall = fetchCalls.find((c) => c.url.includes("/compose-up"));
    expect(composeUpCall).toBeTruthy();
    expect(composeUpCall!.method).toBe("POST");
    expect(composeUpCall!.url).toContain("profile=openclaw-test");
    // Default daemon URL is host.docker.internal:9000.
    expect(composeUpCall!.url).toContain("host.docker.internal:9000");

    // Vessel /status + /bootstrap fired afterward (via the profile's vessel URL).
    expect(fetchCalls.some((c) => c.url.endsWith("/bootstrap"))).toBe(true);

    expect(writes.join("")).toMatch(
      /Bringing up docker compose stack for project arianna-openclaw-test via daemon/,
    );
    expect(writes.join("")).toMatch(/Bootstrapped vessel/);
  });

  it("--use-daemon forces the daemon route even when local docker is available", async () => {
    const { home, repo } = setupCanaryProfile();

    let composeUpCalled = false;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/compose-up")) {
        composeUpCalled = true;
        return new Response(
          JSON.stringify({ ok: true, broughtUp: true, alreadyUp: false }),
          { status: 200 },
        );
      }
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "Echo" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const exec = vi.fn(async () => {
      throw new Error("exec must NOT run when --use-daemon is set");
    });

    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(
      cfg,
      {
        fetch: fetch as never,
        write: () => {},
        pathOpts: { ariannaHome: home, repoRoot: repo },
        exec,
        // Probe says docker IS available — but useDaemon overrides.
        dockerProbe: () => {},
      },
      { useDaemon: true },
    );

    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(composeUpCalled).toBe(true);
  });

  it("ARIANNA_DAEMON_URL overrides the default daemon endpoint", async () => {
    const { home, repo } = setupCanaryProfile();

    const fetchCalls: string[] = [];
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      fetchCalls.push(u);
      if (u.includes("/compose-up")) {
        return new Response(
          JSON.stringify({ ok: true, broughtUp: true, alreadyUp: false }),
          { status: 200 },
        );
      }
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "Echo" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    await runBootstrap(cfg, {
      fetch: fetch as never,
      write: () => {},
      pathOpts: { ariannaHome: home, repoRoot: repo },
      env: { ARIANNA_DAEMON_URL: "http://my.daemon.host:1234" },
      dockerProbe: () => {
        throw new Error("no docker");
      },
    });

    const composeUpCall = fetchCalls.find((u) => u.includes("/compose-up"));
    expect(composeUpCall).toBeTruthy();
    expect(composeUpCall).toContain("http://my.daemon.host:1234");
    expect(composeUpCall).not.toContain("host.docker.internal");
  });

  it("surfaces an actionable error when the daemon /compose-up fails", async () => {
    const { home, repo } = setupCanaryProfile();

    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/compose-up")) {
        return new Response(
          JSON.stringify({
            error: "docker compose up -d failed for project arianna-openclaw-test: port 3000 already in use",
          }),
          { status: 500 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    await expect(
      runBootstrap(cfg, {
        fetch: fetch as never,
        write: () => {},
        pathOpts: { ariannaHome: home, repoRoot: repo },
        dockerProbe: () => {
          throw new Error("no docker");
        },
      }),
    ).rejects.toMatchObject({
      name: "BootstrapCommandError",
      message: expect.stringMatching(/daemon \/compose-up failed/),
    });
  });

  it("surfaces an actionable error when the daemon is unreachable", async () => {
    const { home, repo } = setupCanaryProfile();

    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    await expect(
      runBootstrap(cfg, {
        fetch: fetch as never,
        write: () => {},
        pathOpts: { ariannaHome: home, repoRoot: repo },
        dockerProbe: () => {
          throw new Error("no docker");
        },
      }),
    ).rejects.toMatchObject({
      name: "BootstrapCommandError",
      message: expect.stringMatching(
        /daemon \/compose-up unreachable.*ARIANNA_DAEMON_URL/,
      ),
    });
  });

  // Validation aea28db5 (2026-05-09): from inside an openclaw container,
  // bootstrap was writing the prelude to a path the host daemon never read
  // (cwd-walk found openclaw's docker-compose.yml). The fix: on the daemon
  // route, the CLI sends `{ writePrelude: !noPrelude }` to /compose-up and
  // skips its own local write. The daemon writes server-side.
  describe("daemon-route prelude write (validation aea28db5 fix)", () => {
    it("on the daemon route, the CLI does NOT write the prelude locally — it threads writePrelude:true to /compose-up and the daemon handles it", async () => {
      const { home, repo } = setupCanaryProfile();

      // The local seed path the CLI WOULD write to if it took the local route.
      // After the fix, this path stays empty on the daemon route.
      const localSeedPath = join(
        repo,
        "workspace",
        "profiles",
        "openclaw-test",
        "imported-messages.jsonl",
      );

      const composeUpBodies: string[] = [];
      let composeUpCalled = false;
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/compose-up")) {
          composeUpCalled = true;
          composeUpBodies.push(init?.body as string);
          // Simulate the daemon writing the prelude on its side.
          return new Response(
            JSON.stringify({
              ok: true,
              broughtUp: true,
              alreadyUp: false,
              preludeWritten: true,
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/status")) {
          if (!composeUpCalled) throw new TypeError("fetch failed");
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: false, aiName: "Echo" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const writes: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      const code = await runBootstrap(cfg, {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
        dockerProbe: () => {
          throw new Error("no docker");
        },
      });

      expect(code).toBe(0);

      // CLI did NOT write the local seed file (would have been the failure
      // mode on the openclaw container where the path was wrong).
      expect(existsSync(localSeedPath)).toBe(false);

      // /compose-up was called with `writePrelude: true` so the daemon does
      // the write on its authoritative copy.
      expect(composeUpBodies).toHaveLength(1);
      const body = JSON.parse(composeUpBodies[0]);
      expect(body.writePrelude).toBe(true);

      // Operator-facing message reflects the daemon-side write.
      expect(writes.join("")).toMatch(/Auto-injected Filo opening prelude on daemon side/);
    });

    it("--no-prelude on the daemon route threads writePrelude:false to /compose-up", async () => {
      const { home, repo } = setupCanaryProfile();

      const composeUpBodies: string[] = [];
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/compose-up")) {
          composeUpBodies.push(init?.body as string);
          return new Response(
            JSON.stringify({
              ok: true,
              broughtUp: true,
              alreadyUp: false,
              preludeWritten: false,
              preludeSkipReason: "writePrelude=false",
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/status")) {
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: false, aiName: "Echo" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const writes: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      const code = await runBootstrap(
        cfg,
        {
          fetch: fetch as never,
          write: (l) => writes.push(l),
          pathOpts: { ariannaHome: home, repoRoot: repo },
          dockerProbe: () => {
            throw new Error("no docker");
          },
        },
        { noPrelude: true },
      );

      expect(code).toBe(0);
      const body = JSON.parse(composeUpBodies[0]);
      expect(body.writePrelude).toBe(false);
      // No "Auto-injected" message on either side.
      expect(writes.join("")).not.toMatch(/Auto-injected/);
    });

    it("daemon-route surfaces the ai-name-missing skip reason as a warning so operators can fix session_config.json", async () => {
      const { home, repo } = setupCanaryProfile();

      const fetch = vi.fn(async (url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/compose-up")) {
          return new Response(
            JSON.stringify({
              ok: true,
              broughtUp: true,
              alreadyUp: false,
              preludeWritten: false,
              preludeSkipReason: "ai-name-missing",
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/status")) {
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: false, aiName: "Echo" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const warns: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      await runBootstrap(cfg, {
        fetch: fetch as never,
        write: () => {},
        warn: (l) => warns.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
        dockerProbe: () => {
          throw new Error("no docker");
        },
      });

      expect(warns.join("")).toMatch(/Filo prelude skipped on daemon side — no aiName/);
    });

    it("--seed-from-jsonl on the daemon route still threads writePrelude:false (the seed wins, daemon must not clobber)", async () => {
      // Note: --seed-from-jsonl writes the seed file from the CLI side too
      // (the seed source path is the operator's chosen file, not the profile
      // workspace — that read works even from inside a container). On the
      // daemon route we still need writePrelude:false in the body so the
      // daemon doesn't race the CLI's write and clobber it (the daemon is
      // strict about not clobbering, but belt-and-suspenders).
      const { home, repo } = setupCanaryProfile();

      const composeUpBodies: string[] = [];
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/compose-up")) {
          composeUpBodies.push(init?.body as string);
          return new Response(
            JSON.stringify({
              ok: true,
              broughtUp: true,
              alreadyUp: false,
              preludeWritten: false,
              preludeSkipReason: "writePrelude=false",
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/status")) {
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: false, aiName: "Echo" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      await runBootstrap(
        cfg,
        {
          fetch: fetch as never,
          write: () => {},
          pathOpts: { ariannaHome: home, repoRoot: repo },
          dockerProbe: () => {
            throw new Error("no docker");
          },
        },
        { seedFromJsonl: join(FIXTURES_DIR, "openclaw-session.jsonl") },
      );

      const body = JSON.parse(composeUpBodies[0]);
      expect(body.writePrelude).toBe(false);
    });

    it("local-route still writes the prelude client-side (laptop dev flow unchanged — backwards compat)", async () => {
      // Backwards-compat regression: the laptop dev flow (docker installed
      // locally) must NOT regress. The CLI keeps writing the prelude itself
      // because path resolution against the cwd-walked repo root works fine
      // when the CLI is on the same host as the daemon.
      const { home, repo } = mk();
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "config"),
        "[default]\nprofile = laptop-dev\n\n[profile laptop-dev]\nport_offset = 0\n",
      );
      const profileDir = join(repo, "workspace", "profiles", "laptop-dev");
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(
        join(profileDir, "session_config.json"),
        JSON.stringify({
          aiName: "LaptopBuddy",
          aiUsername: "laptopbuddy",
          sessionId: "sess-laptop",
          provider: "anthropic",
          modelId: "claude-opus-4-7",
          externalLlmApiKey: "k",
        }),
      );

      const seedPath = join(profileDir, "imported-messages.jsonl");

      let stackUp = false;
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes("ps --services --filter status=running")) {
          return { stdout: stackUp ? "vessel\n" : "", stderr: "" };
        }
        if (cmd.includes(" up -d")) {
          stackUp = true;
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected exec ${cmd}`);
      });
      const fetch = vi.fn(async (url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.endsWith("/status")) {
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: false, aiName: "LaptopBuddy" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        // /compose-up should NOT be hit on the local route.
        throw new Error(`unexpected fetch ${u}`);
      });

      const writes: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      const code = await runBootstrap(cfg, {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
        exec,
        dockerProbe: () => {}, // local docker available
      });

      expect(code).toBe(0);
      // Local-route prelude write happened CLIENT-side, with the local-route
      // operator-facing log line ("Auto-injected ... → /path" — note arrow).
      expect(existsSync(seedPath)).toBe(true);
      expect(writes.join("")).toMatch(/Auto-injected Filo opening prelude for "LaptopBuddy"/);
      // Did NOT take the daemon-side path.
      expect(writes.join("")).not.toMatch(/on daemon side/);
    });
  });

  describe("daemon-route vessel /bootstrap forwarding (validation abfd4b13 fix)", () => {
    // After the daemon brings up the stack and writes the prelude, it now
    // ALSO POSTs /bootstrap to vessel itself (the CLI inside an openclaw
    // container can't read the host's imported-messages.jsonl). Then the
    // CLI's ensureBootstrapped step short-circuits on /status.bootstrapped:
    // true — exactly one /bootstrap POST happens in the happy path.

    it("daemon-route happy path: when daemon reports vesselBootstrapped:true, CLI does NOT double-POST /bootstrap", async () => {
      const { home, repo } = setupCanaryProfile();

      let composeUpCalled = false;
      let bootstrapPosts = 0;
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/compose-up")) {
          composeUpCalled = true;
          // Daemon reports it brought the stack up AND bootstrapped vessel
          // server-side (the openclaw container path).
          return new Response(
            JSON.stringify({
              ok: true,
              broughtUp: true,
              alreadyUp: false,
              preludeWritten: true,
              vesselBootstrapped: true,
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/status")) {
          if (!composeUpCalled) throw new TypeError("fetch failed");
          // Daemon already bootstrapped the vessel — /status reflects it.
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: true, aiName: "Echo" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap") && init?.method === "POST") {
          bootstrapPosts++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const writes: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      const code = await runBootstrap(cfg, {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
        dockerProbe: () => {
          throw new Error("no docker");
        },
      });

      expect(code).toBe(0);
      // EXACTLY ZERO direct CLI POSTs to /bootstrap — the daemon did the
      // bootstrap server-side and the CLI now skips ensureBootstrapped
      // entirely when daemon reported vesselBootstrapped:true. (The daemon's
      // own /bootstrap POST goes through the daemon process, not this fetch
      // mock, so we count only what the CLI directly issued.)
      expect(bootstrapPosts).toBe(0);
      expect(writes.join("")).toMatch(/Vessel bootstrapped on daemon side/);
      // Item 2 (validation a09486c9): the redundant "Vessel already
      // bootstrapped — no-op" line that previously followed
      // "Vessel bootstrapped on daemon side." is suppressed. Operator now
      // sees one clear success line, not a "did it work?" duplication.
      expect(writes.join("")).not.toMatch(/already bootstrapped/);
      expect(writes.join("")).not.toMatch(/no-op/);
    });

    it("daemon-route happy path: ensureBootstrapped is skipped (no /status re-probe) when daemon reports vesselBootstrapped:true", async () => {
      // Item 2 / validation a09486c9 (Talin run, 2026-05-09): when
      // /compose-up reports vesselBootstrapped:true, the CLI now skips
      // ensureBootstrapped entirely — operator sees one clear success line,
      // and the CLI doesn't re-probe /status only to print a confusing
      // "no-op" message. This test pins the skip by counting /status hits:
      // one is fine (compose-up's own pre-check inside the daemon goes
      // through the real daemon, not this mock — the only /status the mock
      // sees is whichever the CLI directly issues).
      const { home, repo } = setupCanaryProfile();

      let statusProbes = 0;
      const fetch = vi.fn(async (url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/compose-up")) {
          return new Response(
            JSON.stringify({
              ok: true,
              broughtUp: true,
              alreadyUp: false,
              preludeWritten: true,
              vesselBootstrapped: true,
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/status")) {
          statusProbes++;
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: true, aiName: "Echo" }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const writes: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      const code = await runBootstrap(cfg, {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
        dockerProbe: () => {
          throw new Error("no docker");
        },
      });

      expect(code).toBe(0);
      // ZERO /status probes from the CLI side: ensureBootstrapped (which
      // would have probed) was skipped because daemon owned the bootstrap.
      expect(statusProbes).toBe(0);
      expect(writes.join("")).toMatch(/Vessel bootstrapped on daemon side/);
      expect(writes.join("")).not.toMatch(/already bootstrapped/);
    });

    it("daemon-route fall-back: when daemon's vessel /bootstrap forward fails, CLI's ensureBootstrapped re-attempts (and warns)", async () => {
      const { home, repo } = setupCanaryProfile();

      let composeUpCalled = false;
      let bootstrapPosts = 0;
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/compose-up")) {
          composeUpCalled = true;
          return new Response(
            JSON.stringify({
              ok: true,
              broughtUp: true,
              alreadyUp: false,
              preludeWritten: true,
              vesselBootstrapped: false,
              vesselBootstrapError: "vessel did not become healthy at http://127.0.0.1:3000 within 30s",
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/status")) {
          if (!composeUpCalled) throw new TypeError("fetch failed");
          // Vessel is reachable now but un-bootstrapped (daemon's forward
          // raced cold-start and gave up).
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: false, aiName: "Echo" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap") && init?.method === "POST") {
          bootstrapPosts++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const writes: string[] = [];
      const warns: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      const code = await runBootstrap(cfg, {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        warn: (l) => warns.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
        dockerProbe: () => {
          throw new Error("no docker");
        },
      });

      expect(code).toBe(0);
      // Exactly ONE CLI-side bootstrap POST — the fall-back fired because
      // daemon-side forward was reported failed and /status confirmed
      // vessel was still un-bootstrapped.
      expect(bootstrapPosts).toBe(1);
      expect(warns.join("")).toMatch(/daemon vessel \/bootstrap forward failed/);
      expect(warns.join("")).toMatch(/falling back/);
    });

    it("daemon-route --no-prelude path: daemon still forwards /bootstrap (so CLI doesn't have to)", async () => {
      // --no-prelude means writePrelude:false. The daemon should NOT write a
      // prelude, but it SHOULD still POST /bootstrap to vessel with whatever
      // imported-messages.jsonl contains (probably an empty array — that
      // matches the local-route blank-canvas behavior the CLI would have
      // produced reading its own filesystem).
      const { home, repo } = setupCanaryProfile();

      let composeUpCalled = false;
      let bootstrapPosts = 0;
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/compose-up")) {
          composeUpCalled = true;
          return new Response(
            JSON.stringify({
              ok: true,
              broughtUp: true,
              alreadyUp: false,
              preludeWritten: false,
              preludeSkipReason: "writePrelude=false",
              vesselBootstrapped: true,
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/status")) {
          if (!composeUpCalled) throw new TypeError("fetch failed");
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: true, aiName: "Echo" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap") && init?.method === "POST") {
          bootstrapPosts++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const writes: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      const code = await runBootstrap(
        cfg,
        {
          fetch: fetch as never,
          write: (l) => writes.push(l),
          pathOpts: { ariannaHome: home, repoRoot: repo },
          dockerProbe: () => {
            throw new Error("no docker");
          },
        },
        { noPrelude: true },
      );

      expect(code).toBe(0);
      expect(bootstrapPosts).toBe(0);
      expect(writes.join("")).not.toMatch(/Auto-injected/);
      expect(writes.join("")).toMatch(/Vessel bootstrapped on daemon side/);
    });

    it("local route is unchanged: no daemon vesselBootstrapped path, CLI does its own /bootstrap", async () => {
      // Backwards-compat regression: the laptop dev flow (docker installed
      // locally) MUST NOT regress. The CLI keeps its existing local-route
      // bootstrap behavior (read imported-messages.jsonl client-side, POST
      // to vessel) — the daemon's forwarding logic only kicks in on the
      // daemon route.
      const { home, repo } = mk();
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "config"),
        "[default]\nprofile = laptop-dev\n\n[profile laptop-dev]\nport_offset = 0\n",
      );
      const profileDir = join(repo, "workspace", "profiles", "laptop-dev");
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(
        join(profileDir, "session_config.json"),
        JSON.stringify({
          aiName: "LaptopBuddy",
          aiUsername: "laptopbuddy",
          sessionId: "sess-laptop",
          provider: "anthropic",
          modelId: "claude-opus-4-7",
          externalLlmApiKey: "k",
        }),
      );

      let stackUp = false;
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.includes("ps --services --filter status=running")) {
          return { stdout: stackUp ? "vessel\n" : "", stderr: "" };
        }
        if (cmd.includes(" up -d")) {
          stackUp = true;
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected exec ${cmd}`);
      });

      let bootstrapPosts = 0;
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.endsWith("/status")) {
          return new Response(
            JSON.stringify({ ok: true, bootstrapped: false, aiName: "LaptopBuddy" }),
            { status: 200 },
          );
        }
        if (u.endsWith("/bootstrap") && init?.method === "POST") {
          bootstrapPosts++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        // /compose-up MUST NOT be hit on the local route.
        throw new Error(`unexpected fetch ${u}`);
      });

      const writes: string[] = [];
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: false,
      });

      const code = await runBootstrap(cfg, {
        fetch: fetch as never,
        write: (l) => writes.push(l),
        pathOpts: { ariannaHome: home, repoRoot: repo },
        exec,
        dockerProbe: () => {}, // local docker available
      });

      expect(code).toBe(0);
      // CLI did the /bootstrap POST itself (local-route flow).
      expect(bootstrapPosts).toBe(1);
      expect(writes.join("")).not.toMatch(/Vessel bootstrapped on daemon side/);
      expect(writes.join("")).not.toMatch(/daemon vessel \/bootstrap forward failed/);
    });
  });

  it("daemon route reports already-up state (silent fast-path mirroring local route)", async () => {
    const { home, repo } = setupCanaryProfile();

    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/compose-up")) {
        return new Response(
          JSON.stringify({ ok: true, broughtUp: false, alreadyUp: true }),
          { status: 200 },
        );
      }
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: true, aiName: "Echo" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const writes: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
      dockerProbe: () => {
        throw new Error("no docker");
      },
    });

    expect(code).toBe(0);
    // The "Bringing up..." line is emitted before we know it was alreadyUp;
    // operators see one line either way. The vessel-already-bootstrapped
    // message confirms the rest of the flow short-circuited normally.
    expect(writes.join("")).toMatch(/already bootstrapped/);
  });
});

describe("ensureBootstrapped post-up readiness retry (canary-003 fix)", () => {
  // Regression for canary-003 (Sif's run, 2026-05-09): `arianna bootstrap`
  // printed `error: fetch failed` after a successful compose-up because the
  // post-up POST /bootstrap raced vessel's HTTP bind. Vessel + sidecar were
  // healthy seconds later; only the eager probe blew. The fix: poll /status
  // with backoff until vessel responds (or the budget elapses), then proceed.

  it("retries /status with backoff when vessel hasn't bound yet, then succeeds", async () => {
    // Vessel transport-fails the first 3 probes (cold start) and then comes
    // online. The retry loop should absorb the wait and the bootstrap should
    // succeed silently — no `error: fetch failed` surfaces to stderr.
    let probeCount = 0;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        probeCount++;
        if (probeCount <= 3) throw new TypeError("fetch failed");
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "Sif" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };

    const result = await ensureBootstrapped(
      resolveConfig({
        env: {},
        ariannaHome: ISOLATED_ARIANNA_HOME,
        allowImplicitDefault: false,
      }),
      {
        fetch: fetch as never,
        readyTimeoutMs: 30_000,
        readyIntervalMs: 50,
        sleep,
      },
    );

    expect(result.bootstrapped).toBe(true);
    expect(probeCount).toBe(4); // 1 initial + 3 retries before success
    expect(sleeps.length).toBe(3); // one sleep before each retry
    expect(sleeps.every((ms) => ms === 50)).toBe(true);
  });

  it("throws VesselUnreachableError with an actionable message when the budget elapses", async () => {
    // Vessel never comes online. After the configured budget, ensureBootstrapped
    // should throw a typed error the dispatcher can catch — NOT a bare
    // `TypeError: fetch failed` that would bubble to bin/arianna.js's catch-all
    // and surface the misleading "error: fetch failed" canary-003 hit.
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    // no-op sleep; budget elapses on real wall clock vs Date.now()
    const sleep: (ms: number) => Promise<void> = async () => {};

    await expect(
      ensureBootstrapped(
        resolveConfig({
          env: {},
          ariannaHome: ISOLATED_ARIANNA_HOME,
          allowImplicitDefault: false,
        }),
        {
          fetch: fetch as never,
          readyTimeoutMs: 200, // small budget for the test
          readyIntervalMs: 50,
          sleep,
        },
      ),
    ).rejects.toMatchObject({
      name: "VesselUnreachableError",
      message: expect.stringMatching(/vessel \/status unreachable.*after 200ms/),
    });

    // The error message is the actionable surface — names docker compose logs
    // as the next step rather than the cryptic "fetch failed".
    await expect(
      ensureBootstrapped(
        resolveConfig({
          env: {},
          ariannaHome: ISOLATED_ARIANNA_HOME,
          allowImplicitDefault: false,
        }),
        {
          fetch: fetch as never,
          readyTimeoutMs: 100,
          readyIntervalMs: 25,
          sleep,
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/docker compose .* logs vessel/),
    });
  });

  it("does NOT retry on a 5xx HTTP response — that's a real failure, not a cold-start race", async () => {
    // Distinguishes "vessel not yet bound" (transport error → retry) from
    // "vessel bound but unhealthy" (HTTP error → fail fast). A 503 from a
    // running vessel shouldn't trigger 60 retries over 30 seconds.
    let probeCount = 0;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        probeCount++;
        return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };

    // ensureBootstrapped should treat the 500 as "status not bootstrapped" and
    // proceed to POST /bootstrap (legacy behavior). The fetch mock will throw
    // on /bootstrap because we didn't wire it — but the important assertion is
    // that probeCount stays at 1 (no retry on HTTP error).
    await expect(
      ensureBootstrapped(
        resolveConfig({
          env: {},
          ariannaHome: ISOLATED_ARIANNA_HOME,
          allowImplicitDefault: false,
        }),
        {
          fetch: fetch as never,
          readyTimeoutMs: 30_000,
          readyIntervalMs: 50,
          sleep,
        },
      ),
    ).rejects.toThrow(/unexpected fetch.*\/bootstrap/);

    // The /status 500 didn't trigger a retry loop — probeCount stayed at 1.
    // (The POST /bootstrap path may have its own one-shot retry on transport
    // failure, which is independent of the /status retry behavior under test.)
    expect(probeCount).toBe(1);
  });

  it("succeeds on the first probe when vessel is already up (no extra latency)", async () => {
    // Hot path: vessel is reachable on the first probe. The retry machinery
    // must not introduce any sleep / extra latency.
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/status")) {
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: true, aiName: "x" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };

    const result = await ensureBootstrapped(
      resolveConfig({
        env: {},
        ariannaHome: ISOLATED_ARIANNA_HOME,
        allowImplicitDefault: false,
      }),
      {
        fetch: fetch as never,
        readyTimeoutMs: 30_000,
        readyIntervalMs: 500,
        sleep,
      },
    );

    expect(result.alreadyBootstrapped).toBe(true);
    expect(sleeps).toEqual([]); // no retry needed on the hot path
  });

  it("VesselUnreachableError is re-exported from bootstrap.ts so the dispatcher can catch it", () => {
    // Light type-shape check: a plain Error wouldn't satisfy this, but a
    // class with the right name does. Guards against accidental rename.
    const e = new VesselUnreachableError("test");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("VesselUnreachableError");
    expect(e.message).toBe("test");
  });

  it("runBootstrap surfaces the canary-003 cold-start window cleanly when vessel takes ~1.5s to bind", async () => {
    // End-to-end: simulate Sif's exact flow. compose-up succeeds, vessel
    // takes 3 probe intervals to bind (~150ms), then bootstrap completes
    // and prints "Bootstrapped vessel" — not "error: fetch failed".
    const { home, repo } = mk();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      "[default]\nprofile = canary-003-sim\n\n[profile canary-003-sim]\nport_offset = 10\n",
    );
    mkdirSync(join(repo, "workspace", "profiles", "canary-003-sim"), {
      recursive: true,
    });
    writeFileSync(
      join(repo, "workspace", "profiles", "canary-003-sim", "session_config.json"),
      JSON.stringify({
        aiUsername: "sif",
        aiName: "Sif",
        externalLlmApiKey: "k-stub",
        provider: "anthropic",
        modelId: "claude-opus-4-7",
        sessionId: "sess-sif",
      }),
    );

    let stackUp = false;
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("ps --services --filter status=running")) {
        return { stdout: stackUp ? "vessel\nsidecar\n" : "", stderr: "" };
      }
      if (cmd.includes(" up -d")) {
        stackUp = true;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected exec ${cmd}`);
    });

    let probesAfterUp = 0;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (!stackUp) throw new TypeError("fetch failed");
      if (u.endsWith("/status")) {
        probesAfterUp++;
        // First 3 probes after `up -d` race vessel's HTTP bind — exactly
        // Sif's situation. Then vessel binds and /status returns.
        if (probesAfterUp <= 3) throw new TypeError("fetch failed");
        return new Response(
          JSON.stringify({ ok: true, bootstrapped: false, aiName: "Sif" }),
          { status: 200 },
        );
      }
      if (u.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const writes: string[] = [];
    const warns: string[] = [];
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });

    const code = await runBootstrap(cfg, {
      fetch: fetch as never,
      write: (l) => writes.push(l),
      warn: (l) => warns.push(l),
      pathOpts: { ariannaHome: home, repoRoot: repo },
      exec,
      dockerProbe: () => {}, // local route
      readyTimeoutMs: 5_000,
      readyIntervalMs: 50,
      sleep: async () => {}, // instant in test
    });

    expect(code).toBe(0);
    // The post-up window absorbed silently — no "error:" lines on stderr.
    expect(warns.join("")).not.toMatch(/^error:/m);
    // Bootstrap succeeded with the expected operator-facing message.
    expect(writes.join("")).toMatch(/Bootstrapped vessel/);
  });
});
