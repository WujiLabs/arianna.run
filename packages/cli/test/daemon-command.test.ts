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

import {
  DaemonCommandError,
  daemonPidPath,
  resolveDaemonScript,
  runDaemon,
  type DaemonDeps,
  type SpawnedDaemon,
} from "../src/commands/daemon.js";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-daemon-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-daemon-repo-"));
  // resolveDaemonScript expects docker-compose.yml at the repo root (find
  // marker) and either dist/daemon.js or src/daemon.ts at the host package
  // path.
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

interface Capture {
  out: string;
  err: string;
}

function fakeFetch(behavior: "ok" | "bound-no-200" | "down"): typeof globalThis.fetch {
  return (async () => {
    if (behavior === "ok") {
      return new Response("ok", { status: 200 });
    }
    if (behavior === "bound-no-200") {
      return new Response("nope", { status: 500 });
    }
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
}

function deps(
  home: string,
  cap: Capture,
  extra: Partial<DaemonDeps> = {},
): DaemonDeps {
  return {
    write: (s) => { cap.out += s; },
    warn: (s) => { cap.err += s; },
    ariannaHome: home,
    fetch: fakeFetch("down"),
    sleep: () => Promise.resolve(),
    now: () => 0,
    ...extra,
  };
}

describe("daemon status", () => {
  it("reports running when /health is ok and pid file is alive", async () => {
    const { home } = mk();
    writeFileSync(daemonPidPath({ ariannaHome: home }), "12345\n");
    const cap: Capture = { out: "", err: "" };

    const aliveSet = new Set<number>([12345]);
    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fakeFetch("ok"),
        kill: (pid) => {
          if (!aliveSet.has(pid)) {
            const err: NodeJS.ErrnoException = new Error("ESRCH");
            err.code = "ESRCH";
            throw err;
          }
        },
      }),
    );
    expect(code).toBe(0);
    expect(cap.out).toMatch(/pid:\s+12345/);
    expect(cap.out).not.toMatch(/dead/);
    expect(cap.out).toMatch(/health:\s+ok/);
  });

  // Gap 13 (validation agent abf126be, 2026-05-09): a daemon predating the
  // current codebase reported "healthy" via /health, masking that it lacked
  // newer endpoints. `arianna daemon status` now shows version + commit +
  // uptime so operators see staleness immediately.
  it("includes version + commit + uptime when daemon exposes /version", async () => {
    const { home } = mk();
    writeFileSync(daemonPidPath({ ariannaHome: home }), "12345\n");
    const cap: Capture = { out: "", err: "" };

    const fetcher: typeof globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/health")) {
        return new Response("ok", { status: 200 });
      }
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({
            version: "0.0.1",
            commit: "abc1234",
            uptime_ms: 17_165_000, // 4h46m05s — matches the validation-report number
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fetcher,
        kill: () => { /* alive */ },
      }),
    );
    expect(code).toBe(0);
    expect(cap.out).toMatch(/version:\s+0\.0\.1\s+commit=abc1234\s+uptime=4h46m/);
  });

  it("falls back gracefully when daemon predates /version endpoint", async () => {
    // Older daemons that don't expose /version (the canonical staleness case
    // from validation agent abf126be) get a clear "(unavailable)" hint
    // recommending a restart, instead of silently hiding the field.
    const { home } = mk();
    writeFileSync(daemonPidPath({ ariannaHome: home }), "12345\n");
    const cap: Capture = { out: "", err: "" };

    const fetcher: typeof globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/health")) {
        return new Response("ok", { status: 200 });
      }
      // Pre-Gap-13 daemon returns 404 for /version.
      if (url.endsWith("/version")) {
        return new Response("Not found", { status: 404 });
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fetcher,
        kill: () => { /* alive */ },
      }),
    );
    expect(code).toBe(0);
    expect(cap.out).toMatch(/version:\s+\(unavailable.*restart to refresh/);
  });

  it("omits commit field when /version response does not include one", async () => {
    // commit is best-effort — git unavailable + ARIANNA_BUILD_COMMIT unset.
    // The status line should still print version + uptime cleanly without
    // dangling whitespace.
    const { home } = mk();
    writeFileSync(daemonPidPath({ ariannaHome: home }), "12345\n");
    const cap: Capture = { out: "", err: "" };

    const fetcher: typeof globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({ version: "0.0.1", uptime_ms: 65_000 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap, { fetch: fetcher, kill: () => { /* alive */ } }),
    );
    expect(code).toBe(0);
    expect(cap.out).toMatch(/version:\s+0\.0\.1\s+uptime=1m5s/);
    expect(cap.out).not.toMatch(/commit=/);
  });

  it("flags stale pid file when process is dead", async () => {
    const { home } = mk();
    writeFileSync(daemonPidPath({ ariannaHome: home }), "99999\n");
    const cap: Capture = { out: "", err: "" };
    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fakeFetch("down"),
        kill: () => {
          const err: NodeJS.ErrnoException = new Error("ESRCH");
          err.code = "ESRCH";
          throw err;
        },
      }),
    );
    expect(code).toBe(1);
    expect(cap.out).toMatch(/pid:\s+99999.*stale pid file/);
    expect(cap.out).toMatch(/health:\s+not running/);
  });

  it("reports not-running when no pid file and nothing on the port", async () => {
    const { home } = mk();
    const cap: Capture = { out: "", err: "" };
    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap),
    );
    expect(code).toBe(1);
    expect(cap.out).toMatch(/no pid file/);
    expect(cap.out).toMatch(/health:\s+not running/);
  });

  // Validation aea28db5 (2026-05-09): from inside an openclaw container,
  // `arianna daemon status` was hard-coding 127.0.0.1:9000 even when the
  // operator had set ARIANNA_DAEMON_URL=http://host.docker.internal:9000.
  // Loopback inside a container is not the host's daemon → "not running"
  // false negative. Mirrors the env resolution chain compose-up.ts uses.
  it("honors ARIANNA_DAEMON_URL when probing the daemon (openclaw container case)", async () => {
    const { home } = mk();
    const cap: Capture = { out: "", err: "" };

    const seenUrls: string[] = [];
    const fetcher: typeof globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({ version: "0.0.1", uptime_ms: 1000 }),
          { status: 200 },
        );
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fetcher,
        daemonEnv: { ARIANNA_DAEMON_URL: "http://host.docker.internal:9000" },
      }),
    );

    expect(code).toBe(0);
    // Both /health and /version probed against the override URL, NOT loopback.
    expect(seenUrls.every((u) => u.startsWith("http://host.docker.internal:9000/"))).toBe(true);
    // Status dashboard shows the override URL so operators see what they hit.
    expect(cap.out).toMatch(/endpoint:\s+http:\/\/host\.docker\.internal:9000/);
    expect(cap.out).toMatch(/health:\s+ok/);
  });

  it("falls back to 127.0.0.1:9000 when ARIANNA_DAEMON_URL is unset and local docker is available (laptop dev flow)", async () => {
    const { home } = mk();
    const cap: Capture = { out: "", err: "" };

    const seenUrls: string[] = [];
    const fetcher: typeof globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({ version: "0.0.1", uptime_ms: 1000 }),
          { status: 200 },
        );
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fetcher,
        daemonEnv: {}, // no ARIANNA_DAEMON_URL set
        // Pin local-docker-available so this test doesn't depend on whether
        // the host running the tests happens to have docker installed.
        dockerProbe: () => { /* docker present */ },
      }),
    );

    expect(code).toBe(0);
    expect(seenUrls.every((u) => u.startsWith("http://127.0.0.1:9000/"))).toBe(true);
    expect(cap.out).toMatch(/endpoint:\s+http:\/\/127\.0\.0\.1:9000/);
  });

  // Validation a09486c9 (Talin run, 2026-05-09): the env-honoring fix from
  // aea28db5 only worked when the operator had explicitly exported
  // ARIANNA_DAEMON_URL. Inside an openclaw container WITHOUT that env, status
  // still hard-coded loopback and falsely reported "not running". The fix
  // mirrors the auto-swap pattern compose-up.ts (DEFAULT_DAEMON_URL_FOR_CLI)
  // and the vessel/sidecar URL resolution use: env wins; without env, fall
  // back to host.docker.internal when no local docker binary is detected.
  it("auto-swaps to host.docker.internal:9000 when ARIANNA_DAEMON_URL is unset and no local docker (openclaw container case)", async () => {
    const { home } = mk();
    const cap: Capture = { out: "", err: "" };

    const seenUrls: string[] = [];
    const fetcher: typeof globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({ version: "0.0.1", uptime_ms: 1000 }),
          { status: 200 },
        );
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const code = await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fetcher,
        daemonEnv: {}, // no ARIANNA_DAEMON_URL set
        dockerProbe: () => { throw new Error("no docker binary"); },
      }),
    );

    expect(code).toBe(0);
    // Probed against host.docker.internal (NOT loopback) — operator inside
    // the container sees the actual host daemon, not a false negative.
    expect(seenUrls.every((u) => u.startsWith("http://host.docker.internal:9000/"))).toBe(true);
    expect(cap.out).toMatch(/endpoint:\s+http:\/\/host\.docker\.internal:9000/);
    expect(cap.out).toMatch(/health:\s+ok/);
  });

  it("explicit ARIANNA_DAEMON_URL still wins over the auto-swap fallback", async () => {
    // Operator who has exported ARIANNA_DAEMON_URL to point at a custom
    // daemon endpoint shouldn't have the auto-swap silently route them
    // somewhere else just because their machine lacks docker.
    const { home } = mk();
    const cap: Capture = { out: "", err: "" };

    const seenUrls: string[] = [];
    const fetcher: typeof globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({ version: "0.0.1", uptime_ms: 1000 }),
          { status: 200 },
        );
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fetcher,
        daemonEnv: { ARIANNA_DAEMON_URL: "http://my-custom-host:9999" },
        dockerProbe: () => { throw new Error("no docker binary"); },
      }),
    );

    expect(seenUrls.every((u) => u.startsWith("http://my-custom-host:9999/"))).toBe(true);
    expect(cap.out).toMatch(/endpoint:\s+http:\/\/my-custom-host:9999/);
  });

  it("strips trailing slashes from ARIANNA_DAEMON_URL so URL building stays clean", async () => {
    const { home } = mk();
    const cap: Capture = { out: "", err: "" };

    const seenUrls: string[] = [];
    const fetcher: typeof globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({ version: "0.0.1", uptime_ms: 1000 }),
          { status: 200 },
        );
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    await runDaemon(
      { subcommand: "status" },
      deps(home, cap, {
        fetch: fetcher,
        daemonEnv: { ARIANNA_DAEMON_URL: "http://host.docker.internal:9000//" },
      }),
    );

    // No double slash before the path.
    expect(seenUrls.some((u) => u.includes("//health"))).toBe(false);
    expect(seenUrls.some((u) => u.endsWith("/health"))).toBe(true);
  });
});

describe("daemon stop", () => {
  it("no pid file → exit 0 with note", async () => {
    const { home } = mk();
    const cap: Capture = { out: "", err: "" };
    const code = await runDaemon({ subcommand: "stop" }, deps(home, cap));
    expect(code).toBe(0);
    expect(cap.out).toMatch(/no pid file/);
  });

  it("stale pid file → cleans it up and exits 0", async () => {
    const { home } = mk();
    const pidFile = daemonPidPath({ ariannaHome: home });
    writeFileSync(pidFile, "99999\n");
    const cap: Capture = { out: "", err: "" };

    const code = await runDaemon(
      { subcommand: "stop" },
      deps(home, cap, {
        kill: () => {
          const err: NodeJS.ErrnoException = new Error("ESRCH");
          err.code = "ESRCH";
          throw err;
        },
      }),
    );
    expect(code).toBe(0);
    expect(cap.out).toMatch(/stale pid/);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("sends SIGTERM and waits for the pid to disappear", async () => {
    const { home } = mk();
    const pidFile = daemonPidPath({ ariannaHome: home });
    writeFileSync(pidFile, "12345\n");
    const cap: Capture = { out: "", err: "" };

    let alive = true;
    const signals: { pid: number; sig: NodeJS.Signals | 0 }[] = [];
    const code = await runDaemon(
      { subcommand: "stop" },
      deps(home, cap, {
        // Time progresses; after the SIGTERM is "delivered" mark it dead.
        kill: (pid, sig) => {
          signals.push({ pid, sig });
          if (sig === "SIGTERM") {
            alive = false;
            return;
          }
          // sig === 0 is the alive-check
          if (!alive) {
            const err: NodeJS.ErrnoException = new Error("ESRCH");
            err.code = "ESRCH";
            throw err;
          }
        },
      }),
    );
    expect(code).toBe(0);
    expect(signals.find((s) => s.sig === "SIGTERM")?.pid).toBe(12345);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("warns when daemon outlives the timeout", async () => {
    const { home } = mk();
    const pidFile = daemonPidPath({ ariannaHome: home });
    writeFileSync(pidFile, "12345\n");
    const cap: Capture = { out: "", err: "" };
    let t = 0;
    const code = await runDaemon(
      { subcommand: "stop" },
      deps(home, cap, {
        kill: () => { /* never dies */ },
        // Advance time past the 10s stop timeout each call.
        now: () => { t += 6000; return t; },
      }),
    );
    expect(code).toBe(1);
    expect(cap.err).toMatch(/did not exit/);
    // pid file remains because the daemon never confirmed
    expect(existsSync(pidFile)).toBe(true);
  });
});

describe("daemon start", () => {
  function withDaemonScript(repo: string) {
    // Plant a fake compiled daemon so resolveDaemonScript finds it. We don't
    // care about its contents because the spawn is faked.
    const dir = join(repo, "packages", "host", "dist");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "daemon.js");
    writeFileSync(path, "// placeholder");
    return path;
  }

  it("idempotent: returns 0 when health is already ok", async () => {
    const { home, repo } = mk();
    withDaemonScript(repo);
    writeFileSync(daemonPidPath({ ariannaHome: home }), "12345\n");
    const cap: Capture = { out: "", err: "" };
    let spawned = false;
    const code = await runDaemon(
      { subcommand: "start" },
      deps(home, cap, {
        repoRoot: repo,
        fetch: fakeFetch("ok"),
        spawn: () => { spawned = true; return { pid: 99999, unref: () => {} }; },
      }),
    );
    expect(code).toBe(0);
    expect(spawned).toBe(false);
    expect(cap.out).toMatch(/already running/);
  });

  it("refuses if port is bound by something that doesn't /health-200", async () => {
    const { home, repo } = mk();
    withDaemonScript(repo);
    const cap: Capture = { out: "", err: "" };
    await expect(
      runDaemon(
        { subcommand: "start" },
        deps(home, cap, {
          repoRoot: repo,
          fetch: fakeFetch("bound-no-200"),
        }),
      ),
    ).rejects.toThrowError(/Something is listening/);
  });

  it("spawns + writes pid file + waits for /health", async () => {
    const { home, repo } = mk();
    withDaemonScript(repo);
    const cap: Capture = { out: "", err: "" };

    // Switch fetch from "down" → "ok" after the first spawn call so the
    // wait-for-health loop succeeds on the next poll.
    let started = false;
    const spawnFn = (): SpawnedDaemon => {
      started = true;
      return { pid: 23456, unref: () => {} };
    };
    const fetcher: typeof globalThis.fetch = (async () => {
      if (started) return new Response("ok", { status: 200 });
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const code = await runDaemon(
      { subcommand: "start" },
      deps(home, cap, {
        repoRoot: repo,
        fetch: fetcher,
        spawn: spawnFn,
      }),
    );
    expect(code).toBe(0);
    expect(cap.out).toMatch(/daemon started.*pid 23456/);
    expect(readFileSync(daemonPidPath({ ariannaHome: home }), "utf-8").trim()).toBe("23456");
  });

  it("returns 1 + warns when /health never comes up", async () => {
    const { home, repo } = mk();
    withDaemonScript(repo);
    const cap: Capture = { out: "", err: "" };
    let t = 0;
    const code = await runDaemon(
      { subcommand: "start" },
      deps(home, cap, {
        repoRoot: repo,
        fetch: fakeFetch("down"),
        spawn: () => ({ pid: 23456, unref: () => {} }),
        now: () => { t += 16_000; return t; },
      }),
    );
    expect(code).toBe(1);
    expect(cap.err).toMatch(/did not respond/);
  });
});

describe("daemon lock", () => {
  function withDaemonScript(repo: string) {
    const dir = join(repo, "packages", "host", "dist");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "daemon.js");
    writeFileSync(path, "// placeholder");
    return path;
  }

  it("releases the lockfile after a successful start", async () => {
    const { home, repo } = mk();
    withDaemonScript(repo);
    const cap: Capture = { out: "", err: "" };

    let started = false;
    const fetcher: typeof globalThis.fetch = (async () => {
      if (started) return new Response("ok", { status: 200 });
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const spawnFn = (): SpawnedDaemon => {
      started = true;
      return { pid: 23456, unref: () => {} };
    };

    await runDaemon(
      { subcommand: "start" },
      deps(home, cap, { repoRoot: repo, fetch: fetcher, spawn: spawnFn }),
    );

    // After cmdStart's withDaemonLock returns, the lockfile must be unlinked.
    const lockPath = join(home, "daemon.lock");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when /health never comes up", async () => {
    const { home, repo } = mk();
    withDaemonScript(repo);
    const cap: Capture = { out: "", err: "" };
    let t = 0;

    await runDaemon(
      { subcommand: "start" },
      deps(home, cap, {
        repoRoot: repo,
        fetch: fakeFetch("down"),
        spawn: () => ({ pid: 23456, unref: () => {} }),
        now: () => { t += 16_000; return t; },
      }),
    );

    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
  });

  it("cleans up a stale lockfile (mtime old + pid dead)", async () => {
    const { home, repo } = mk();
    withDaemonScript(repo);
    const cap: Capture = { out: "", err: "" };

    const lockPath = join(home, "daemon.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, ts: 0 }));
    const fs = await import("node:fs");
    const oldTime = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, oldTime, oldTime);

    let started = false;
    const fetcher: typeof globalThis.fetch = (async () => {
      if (started) return new Response("ok", { status: 200 });
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const spawnFn = (): SpawnedDaemon => {
      started = true;
      return { pid: 23456, unref: () => {} };
    };

    const code = await runDaemon(
      { subcommand: "start" },
      deps(home, cap, {
        repoRoot: repo,
        fetch: fetcher,
        spawn: spawnFn,
        kill: (pid) => {
          // 99999 is dead; live PIDs return without error.
          if (pid === 99999) {
            const err: NodeJS.ErrnoException = new Error("ESRCH");
            err.code = "ESRCH";
            throw err;
          }
        },
      }),
    );
    expect(code).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("times out when another live process holds the lock", async () => {
    const { home, repo } = mk();
    withDaemonScript(repo);
    const cap: Capture = { out: "", err: "" };

    const lockPath = join(home, "daemon.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, ts: Date.now() }));

    let t = 0;
    await expect(
      runDaemon(
        { subcommand: "start" },
        deps(home, cap, {
          repoRoot: repo,
          fetch: fakeFetch("down"),
          spawn: () => ({ pid: 23456, unref: () => {} }),
          // Each now() call advances past DAEMON_LOCK_TIMEOUT_MS so the
          // retry loop hits the deadline on the second attempt.
          now: () => { t += 6_000; return t; },
          kill: () => { /* lock holder is alive */ },
        }),
      ),
    ).rejects.toThrowError(/Could not acquire/);
  });
});

describe("resolveDaemonScript", () => {
  it("prefers compiled JS when both src and dist exist", () => {
    const { repo } = mk();
    mkdirSync(join(repo, "packages", "host", "dist"), { recursive: true });
    mkdirSync(join(repo, "packages", "host", "src"), { recursive: true });
    writeFileSync(join(repo, "packages", "host", "dist", "daemon.js"), "//");
    writeFileSync(join(repo, "packages", "host", "src", "daemon.ts"), "//");

    const r = resolveDaemonScript({ repoRoot: repo });
    expect(r.kind).toBe("compiled");
    expect(r.path).toMatch(/dist\/daemon\.js$/);
  });

  it("falls back to tsx when only the source file exists", () => {
    const { repo } = mk();
    mkdirSync(join(repo, "packages", "host", "src"), { recursive: true });
    writeFileSync(join(repo, "packages", "host", "src", "daemon.ts"), "//");

    const r = resolveDaemonScript({ repoRoot: repo });
    expect(r.kind).toBe("tsx");
    expect(r.path).toMatch(/src\/daemon\.ts$/);
  });

  it("throws when neither exists", () => {
    const { repo } = mk();
    expect(() => resolveDaemonScript({ repoRoot: repo })).toThrowError(
      DaemonCommandError,
    );
  });
});
