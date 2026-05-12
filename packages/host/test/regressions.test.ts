// Mandatory regression tests from the master eng-review test plan
// (~/.gstack/projects/arianna.run/cosimodw-master-eng-review-test-plan-20260506-222443.md).
//
// IRON RULE: any future change that breaks one of these must surface in CI
// before landing.
//
//   R1  Profile name `../foo` rejected — covered in
//       packages/cli/test/regressions.test.ts (cli package owns argv).
//   R2  Daemon endpoint accepts `?profile=` param — here.
//   R3  Daemon binds 127.0.0.1, NOT 0.0.0.0 — here, code-inspection on
//       packages/host/src/daemon.ts.
//   R4  `arianna fork` rewrites sessionId in snapshot-histories —
//       covered in packages/cli/test/regressions.test.ts.

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProfileContext } from "../src/daemon-profile.js";

// ── R2: ?profile= and X-Arianna-Profile both resolve correctly ────────

describe("R2 — daemon endpoint accepts ?profile= param (and X-Arianna-Profile header)", () => {
  function mk() {
    const home = mkdtempSync(join(tmpdir(), "arianna-r2-home-"));
    const repo = mkdtempSync(join(tmpdir(), "arianna-r2-repo-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
    return { home, repo };
  }
  function seedConfig(home: string) {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config"),
      `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 5\n`,
    );
  }

  it("?profile=alpha → profile-aware paths and shifted ports", () => {
    const { home, repo } = mk();
    seedConfig(home);
    const ctx = resolveProfileContext(
      { query: "alpha", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    if ("code" in ctx) throw new Error("expected ProfileContext, got error");
    expect(ctx.name).toBe("alpha");
    expect(ctx.containerName).toBe("arianna-vessel-alpha");
    expect(ctx.composeProject).toBe("arianna-alpha");
    expect(ctx.vesselUrl).toBe("http://127.0.0.1:3005");
    expect(ctx.sidecarUrl).toBe("http://127.0.0.1:8005");
    expect(ctx.source).toBe("query");
  });

  it("X-Arianna-Profile header resolves equivalently", () => {
    const { home, repo } = mk();
    seedConfig(home);
    const ctx = resolveProfileContext(
      { query: null, header: "alpha" },
      { ariannaHome: home, repoRoot: repo },
    );
    if ("code" in ctx) throw new Error("expected ProfileContext, got error");
    expect(ctx.name).toBe("alpha");
    expect(ctx.source).toBe("header");
  });

  it("conflicting query and header → 400 invalid-profile-name", () => {
    const { home, repo } = mk();
    seedConfig(home);
    const ctx = resolveProfileContext(
      { query: "alpha", header: "beta" },
      { ariannaHome: home, repoRoot: repo },
    );
    if (!("code" in ctx)) throw new Error("expected error, got ProfileContext");
    expect(ctx.code).toBe("invalid-profile-name");
    expect(ctx.status).toBe(400);
  });

  it("invalid profile name → 400 invalid-profile-name", () => {
    const { home, repo } = mk();
    const ctx = resolveProfileContext(
      { query: "../foo", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    if (!("code" in ctx)) throw new Error("expected error, got ProfileContext");
    expect(ctx.code).toBe("invalid-profile-name");
    expect(ctx.status).toBe(400);
  });

  it("unknown profile name → 404 unknown-profile", () => {
    const { home, repo } = mk();
    const ctx = resolveProfileContext(
      { query: "ghost", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    if (!("code" in ctx)) throw new Error("expected error, got ProfileContext");
    expect(ctx.code).toBe("unknown-profile");
    expect(ctx.status).toBe(404);
  });
});

// ── R3: daemon binds 127.0.0.1 by default ─────────────────────────────
//
// We don't spin up the real server (it would race for port 9000 with a real
// stack and conflict with parallel test workers). Instead we read the
// daemon source and assert its default bind address is the loopback. A
// brittle-by-design test: any future change that flips the default back to
// "0.0.0.0" or removes the loopback line must update this test, which forces
// reviewers to think about the unauth-on-public-iface known limitation.

describe("R3 — daemon binds 127.0.0.1 by default (NOT 0.0.0.0)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const daemonSrcPath = join(__dirname, "..", "src", "daemon.ts");
  const source = readFileSync(daemonSrcPath, "utf-8");

  it("default BIND constant is the loopback address", () => {
    // The line we want to lock down looks like:
    //   const BIND = process.env.ARIANNA_DAEMON_BIND ?? "127.0.0.1";
    // Tolerate whitespace + the env-var override but require the default
    // to be a 127.0.0.1 string literal.
    const re = /const\s+BIND\s*=\s*process\.env\.ARIANNA_DAEMON_BIND\s*\?\?\s*"127\.0\.0\.1"/;
    expect(source).toMatch(re);
  });

  it("does NOT contain a hardcoded 0.0.0.0 listen call", () => {
    // server.listen(PORT, "0.0.0.0", ...) was the pre-#37 default. Any
    // recurrence is a regression.
    expect(source).not.toMatch(/server\.listen\([^)]*"0\.0\.0\.0"/);
  });

  it("server.listen passes the BIND constant, not a literal address", () => {
    expect(source).toMatch(/server\.listen\(\s*PORT\s*,\s*BIND\s*,/);
  });
});
