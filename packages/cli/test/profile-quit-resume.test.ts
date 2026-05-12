import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProfile } from "../src/commands/profile.js";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-qr-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-qr-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

interface Capture {
  out: string;
  err: string;
}

interface ExecCall {
  cmd: string;
  env?: NodeJS.ProcessEnv;
}

interface ExecResponse {
  stdout?: string;
  stderr?: string;
  /** Throw with this message instead of returning. */
  error?: string;
}

/**
 * Build an exec fake that pattern-matches the cmd against `responses` and
 * records every call. First match wins; unmatched cmds return empty stdout.
 */
function makeExec(
  calls: ExecCall[],
  responses: Array<{ match: RegExp; response: ExecResponse }> = [],
) {
  return async (cmd: string) => {
    calls.push({ cmd });
    for (const { match, response } of responses) {
      if (match.test(cmd)) {
        if (response.error) throw new Error(response.error);
        return {
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
        };
      }
    }
    return { stdout: "", stderr: "" };
  };
}

function makeExecWithEnv(
  calls: ExecCall[],
  responses: Array<{ match: RegExp; response: ExecResponse }> = [],
) {
  return async (cmd: string, opts?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, env: opts?.env });
    for (const { match, response } of responses) {
      if (match.test(cmd)) {
        if (response.error) throw new Error(response.error);
        return {
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
        };
      }
    }
    return { stdout: "", stderr: "" };
  };
}

function depsFor(home: string, repo: string, cap: Capture, extra: object = {}) {
  return {
    write: (s: string) => {
      cap.out += s;
    },
    warn: (s: string) => {
      cap.err += s;
    },
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

// -----------------------------------------------------------------
// profile quit
// -----------------------------------------------------------------

describe("profile quit", () => {
  it("calls docker compose stop with the profile-aware compose command", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    const code = await runProfile(
      { subcommand: "quit", quitArgs: { name: "alpha", yes: true } },
      depsFor(home, repo, cap, {
        exec: makeExec(calls, [
          { match: /ps --services --filter status=running/, response: { stdout: "vessel\nsidecar\n" } },
        ]),
      }),
    );

    expect(code).toBe(0);
    // First call is the running-services probe.
    expect(calls[0].cmd).toContain("docker compose -p arianna-alpha");
    expect(calls[0].cmd).toContain("-f docker-compose.yml");
    expect(calls[0].cmd).toContain("workspace/profiles/alpha/compose.override.yml");
    expect(calls[0].cmd).toContain("ps --services --filter status=running");
    // Second call is the actual stop with timeout.
    expect(calls[1].cmd).toContain("docker compose -p arianna-alpha");
    expect(calls[1].cmd).toContain("stop -t 10");
    expect(cap.out).toMatch(/Profile "alpha" stopped/);
    expect(cap.out).toMatch(/profile resume/);
  });

  it("is idempotent: prints already-stopped and exits 0 when no services running", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    const code = await runProfile(
      { subcommand: "quit", quitArgs: { name: "alpha", yes: true } },
      depsFor(home, repo, cap, {
        // ps returns empty → no running services
        exec: makeExec(calls, [
          { match: /ps --services --filter status=running/, response: { stdout: "" } },
        ]),
      }),
    );

    expect(code).toBe(0);
    // Only the ps probe; no stop call.
    expect(calls).toHaveLength(1);
    expect(cap.out).toMatch(/already stopped/);
  });

  it("prompts for confirmation when --yes is omitted in interactive mode", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];
    const prompts: string[] = [];

    const code = await runProfile(
      { subcommand: "quit", quitArgs: { name: "alpha", yes: false } },
      depsFor(home, repo, cap, {
        isTTY: () => true,
        prompt: async (label: string) => {
          prompts.push(label);
          return "y";
        },
        exec: makeExec(calls, [
          { match: /ps --services --filter status=running/, response: { stdout: "vessel\n" } },
        ]),
      }),
    );

    expect(code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/Quit profile "alpha"/);
    expect(prompts[0]).toMatch(/Conversation state preserved/);
    // Confirmed → proceed to stop.
    expect(calls.some((c) => c.cmd.includes("stop -t 10"))).toBe(true);
  });

  it("aborts when user answers 'n'", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    const code = await runProfile(
      { subcommand: "quit", quitArgs: { name: "alpha", yes: false } },
      depsFor(home, repo, cap, {
        isTTY: () => true,
        prompt: async () => "n",
        exec: makeExec(calls),
      }),
    );

    expect(code).toBe(1);
    expect(cap.out).toMatch(/Aborted/);
    expect(calls).toHaveLength(0);
  });

  it("refuses non-TTY without --yes", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    await expect(
      runProfile(
        { subcommand: "quit", quitArgs: { name: "alpha", yes: false } },
        depsFor(home, repo, cap, {
          isTTY: () => false,
          exec: makeExec(calls),
        }),
      ),
    ).rejects.toThrowError(/non-TTY/);
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown profile (no config entry, no workspace dir)", async () => {
    const { home, repo } = mk();

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    await expect(
      runProfile(
        { subcommand: "quit", quitArgs: { name: "ghost", yes: true } },
        depsFor(home, repo, cap, { exec: makeExec(calls) }),
      ),
    ).rejects.toThrowError(/No such profile/);
  });

  it("attempts the stop when ps probe fails (does not silently report 'already stopped')", async () => {
    // Regression: an earlier draft used the empty-string default for
    // runningServices when ps threw, leading to a misleading "already
    // stopped" exit-0 even when docker was offline. The fix should make
    // ps-failure fall through to the stop attempt — `stop` on a
    // never-started project is a no-op anyway.
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    const code = await runProfile(
      { subcommand: "quit", quitArgs: { name: "alpha", yes: true } },
      depsFor(home, repo, cap, {
        exec: makeExec(calls, [
          { match: /ps --services --filter status=running/, response: { error: "Cannot connect to the Docker daemon" } },
          { match: /stop -t 10/, response: { stdout: "" } },
        ]),
      }),
    );

    expect(code).toBe(0);
    // Both calls were made — we did NOT short-circuit to "already stopped".
    expect(calls.some((c) => c.cmd.includes("ps --services"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("stop -t 10"))).toBe(true);
    expect(cap.out).not.toMatch(/already stopped/);
    expect(cap.out).toMatch(/Profile "alpha" stopped/);
    expect(cap.err).toMatch(/warn: docker compose ps/);
  });

  it("returns 1 when docker compose stop fails", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    const code = await runProfile(
      { subcommand: "quit", quitArgs: { name: "alpha", yes: true } },
      depsFor(home, repo, cap, {
        exec: makeExec(calls, [
          { match: /ps --services --filter status=running/, response: { stdout: "vessel\n" } },
          { match: /stop -t 10/, response: { error: "docker daemon not running" } },
        ]),
      }),
    );

    expect(code).toBe(1);
    expect(cap.err).toMatch(/docker compose stop failed/);
  });
});

// -----------------------------------------------------------------
// profile resume
// -----------------------------------------------------------------

describe("profile resume", () => {
  it("calls docker compose start when containers exist (stopped state)", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    // Health probe responder: succeeds immediately.
    const fakeFetch = (async () =>
      ({ ok: true } as unknown as Response)) as typeof globalThis.fetch;

    const code = await runProfile(
      { subcommand: "resume", resumeArgs: { name: "alpha" } },
      depsFor(home, repo, cap, {
        execWithEnv: makeExecWithEnv(calls, [
          { match: /ps -a --format json/, response: { stdout: '{"Name":"vessel"}\n' } },
        ]),
        fetch: fakeFetch,
        sleep: async () => {},
        healthDeadlineMs: 1000,
      }),
    );

    expect(code).toBe(0);
    // First call: ps -a. Second: start. No `up -d`.
    expect(calls[1].cmd).toContain("docker compose -p arianna-alpha");
    expect(calls[1].cmd).toContain(" start");
    expect(calls.some((c) => c.cmd.includes("up -d"))).toBe(false);
    expect(cap.out).toMatch(/Profile "alpha" resumed/);
  });

  it("falls back to docker compose up -d when containers were removed", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    const fakeFetch = (async () =>
      ({ ok: true } as unknown as Response)) as typeof globalThis.fetch;

    const code = await runProfile(
      { subcommand: "resume", resumeArgs: { name: "alpha" } },
      depsFor(home, repo, cap, {
        execWithEnv: makeExecWithEnv(calls, [
          // ps returns empty → containers were removed
          { match: /ps -a --format json/, response: { stdout: "" } },
        ]),
        fetch: fakeFetch,
        sleep: async () => {},
        healthDeadlineMs: 1000,
      }),
    );

    expect(code).toBe(0);
    expect(cap.err).toMatch(/containers for "alpha" were removed; rebuilding/);
    // Second exec call is `up -d`.
    expect(calls[1].cmd).toContain("up -d");
    expect(calls[1].cmd).toContain("--remove-orphans");
  });

  it("returns 1 when sidecar health does not become ready", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    const code = await runProfile(
      { subcommand: "resume", resumeArgs: { name: "alpha" } },
      depsFor(home, repo, cap, {
        execWithEnv: makeExecWithEnv(calls, [
          { match: /ps -a --format json/, response: { stdout: '{"Name":"x"}\n' } },
        ]),
        fetch: fakeFetch,
        sleep: async () => {},
        healthDeadlineMs: 50,
      }),
    );

    expect(code).toBe(1);
    expect(cap.err).toMatch(/sidecar at .* did not become healthy/);
  });

  it("rejects unknown profile", async () => {
    const { home, repo } = mk();
    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    await expect(
      runProfile(
        { subcommand: "resume", resumeArgs: { name: "ghost" } },
        depsFor(home, repo, cap, { execWithEnv: makeExecWithEnv(calls) }),
      ),
    ).rejects.toThrowError(/No such profile/);
  });

  it("refuses the half-state where workspace dir exists but config entry is missing", async () => {
    // Regression: defaulting port_offset to 0 in this state would route
    // the resume to the legacy ports (3000/8000), colliding with whatever
    // single-tenant stack the user has running there. Refuse instead.
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);
    // Wipe the config entry but leave the workspace dir.
    const { saveConfig } = await import("../src/arianna-config.js");
    saveConfig(
      { defaultProfile: null, profiles: new Map() },
      { ariannaHome: home },
    );

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    await expect(
      runProfile(
        { subcommand: "resume", resumeArgs: { name: "alpha" } },
        depsFor(home, repo, cap, { execWithEnv: makeExecWithEnv(calls) }),
      ),
    ).rejects.toThrowError(/no entry in.*config|Cannot determine port_offset/);
    expect(calls).toHaveLength(0);
  });

  it("propagates session_config.json env to docker compose up", async () => {
    const { home, repo } = mk();
    await createProfile("alpha", home, repo);
    // Plant a session_config.json that the resume command should read for env.
    const sessionConfig = {
      aiUsername: "alice",
      aiName: "Alice",
      externalLlmApiKey: "sk-test",
      provider: "openrouter",
      modelId: "openai/gpt-4o-mini",
      sessionId: "session_42",
      difficulty: "normal",
      cadence: "human",
      createdAt: 1,
    };
    writeFileSync(
      join(repo, "workspace", "profiles", "alpha", "session_config.json"),
      JSON.stringify(sessionConfig),
    );

    const cap: Capture = { out: "", err: "" };
    const calls: ExecCall[] = [];

    const fakeFetch = (async () =>
      ({ ok: true } as unknown as Response)) as typeof globalThis.fetch;

    await runProfile(
      { subcommand: "resume", resumeArgs: { name: "alpha" } },
      depsFor(home, repo, cap, {
        execWithEnv: makeExecWithEnv(calls, [
          // No persisted containers → `up -d` path, which is when env matters.
          { match: /ps -a --format json/, response: { stdout: "" } },
        ]),
        fetch: fakeFetch,
        sleep: async () => {},
        healthDeadlineMs: 1000,
      }),
    );

    const upCall = calls.find((c) => c.cmd.includes("up -d"));
    expect(upCall).toBeDefined();
    expect(upCall!.env).toBeDefined();
    expect(upCall!.env!.AI_USERNAME).toBe("alice");
    expect(upCall!.env!.AI_NAME).toBe("Alice");
    expect(upCall!.env!.API_KEY).toBe("sk-test");
    expect(upCall!.env!.PROVIDER).toBe("openrouter");
    expect(upCall!.env!.MODEL_ID).toBe("openai/gpt-4o-mini");
    expect(upCall!.env!.ARIANNA_SESSION_ID).toBe("session_42");
    expect(upCall!.env!.ARIANNA_VESSEL_TAG).toBe("session_42-current");
  });
});
