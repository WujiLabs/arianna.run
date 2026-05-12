import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeBaseCommand,
  resolveProfileContext,
  type DaemonProfileError,
  type ProfileContext,
  type RequestProfileInput,
} from "../src/daemon-profile.js";
import { ariannaConfigPath, profileDir } from "@arianna/cli/paths";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-daemon-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-daemon-repo-"));
  // docker-compose.yml marker so paths resolution would walk up correctly.
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

function seedConfig(home: string, body: string) {
  mkdirSync(home, { recursive: true });
  writeFileSync(ariannaConfigPath({ ariannaHome: home }), body);
}

function isErr(x: ProfileContext | DaemonProfileError): x is DaemonProfileError {
  return "code" in x;
}

const empty: RequestProfileInput = { query: null, header: null };

describe("resolveProfileContext — happy paths", () => {
  it("legacy: no param + no config-default → 'default' with legacy paths", () => {
    const { home, repo } = mk();
    const ctx = resolveProfileContext(empty, { ariannaHome: home, repoRoot: repo });
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(ctx.name).toBe("default");
    expect(ctx.isLegacy).toBe(true);
    expect(ctx.containerName).toBe("arianna-vessel");
    expect(ctx.composeProject).toBe(null);
    expect(ctx.composeOverride).toBe(null);
    expect(ctx.portOffset).toBe(0);
    expect(ctx.vesselUrl).toBe("http://127.0.0.1:3000");
    expect(ctx.sidecarUrl).toBe("http://127.0.0.1:8000");
    expect(ctx.sessionConfigPath).toBe(join(repo, "workspace", "session_config.json"));
    expect(ctx.snapshotsDir).toBe(join(repo, "workspace", "snapshots"));
    expect(ctx.sidecarStateDir).toBe(join(repo, "workspace", "sidecar-state"));
    expect(ctx.source).toBe("implicit-default");
  });

  it("named profile in config: profile-aware paths and shifted ports", () => {
    const { home, repo } = mk();
    seedConfig(
      home,
      `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 5\n`,
    );
    const ctx = resolveProfileContext(
      { query: "alpha", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(ctx.name).toBe("alpha");
    expect(ctx.isLegacy).toBe(false);
    expect(ctx.containerName).toBe("arianna-vessel-alpha");
    expect(ctx.composeProject).toBe("arianna-alpha");
    expect(ctx.composeOverride).toBe(
      join(repo, "workspace", "profiles", "alpha", "compose.override.yml"),
    );
    expect(ctx.portOffset).toBe(5);
    expect(ctx.vesselUrl).toBe("http://127.0.0.1:3005");
    expect(ctx.sidecarUrl).toBe("http://127.0.0.1:8005");
    expect(ctx.sessionConfigPath).toBe(
      join(repo, "workspace", "profiles", "alpha", "session_config.json"),
    );
    expect(ctx.source).toBe("query");
  });

  it("X-Arianna-Profile header is treated equivalently to query", () => {
    const { home, repo } = mk();
    seedConfig(home, `[profile alpha]\nport_offset = 5\n`);
    const ctx = resolveProfileContext(
      { query: null, header: "alpha" },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(ctx.name).toBe("alpha");
    expect(ctx.source).toBe("header");
  });

  it("query and header agreeing is fine", () => {
    const { home, repo } = mk();
    seedConfig(home, `[profile alpha]\nport_offset = 1\n`);
    const ctx = resolveProfileContext(
      { query: "alpha", header: "alpha" },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(ctx)).toBe(false);
  });

  it("missing param + config-default named profile → uses that profile", () => {
    const { home, repo } = mk();
    seedConfig(
      home,
      `[default]\nprofile = beta\n\n[profile beta]\nport_offset = 2\n`,
    );
    const ctx = resolveProfileContext(empty, { ariannaHome: home, repoRoot: repo });
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(ctx.name).toBe("beta");
    expect(ctx.source).toBe("config-default");
    expect(ctx.portOffset).toBe(2);
    expect(ctx.isLegacy).toBe(false);
  });

  it("missing param + sentinel-blocked default → only blocks the literal 'default' fallback", () => {
    // If the developer has named a config-default explicitly, they've made a
    // deliberate choice — sentinel only protects the implicit (no config)
    // case. Verify the named-default still resolves.
    const { home, repo } = mk();
    seedConfig(home, `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 0\n`);
    const sentinelDir = profileDir("default", { repoRoot: repo });
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, ".no-default-allowed"), "");
    const ctx = resolveProfileContext(empty, { ariannaHome: home, repoRoot: repo });
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(ctx.name).toBe("alpha");
  });

  it("explicit ?profile=default with no config entry → legacy paths", () => {
    const { home, repo } = mk();
    const ctx = resolveProfileContext(
      { query: "default", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(ctx.isLegacy).toBe(true);
    expect(ctx.source).toBe("query");
  });

  it("explicit ?profile=default WHEN it's in config → profile-aware paths", () => {
    const { home, repo } = mk();
    seedConfig(home, `[profile default]\nport_offset = 4\n`);
    const ctx = resolveProfileContext(
      { query: "default", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(ctx.isLegacy).toBe(false);
    expect(ctx.portOffset).toBe(4);
    expect(ctx.containerName).toBe("arianna-vessel-default");
  });
});

describe("resolveProfileContext — error paths", () => {
  it("invalid name → 400 invalid-profile-name", () => {
    const { home, repo } = mk();
    const err = resolveProfileContext(
      { query: "Bad-Name", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(err)).toBe(true);
    if (!isErr(err)) return;
    expect(err.code).toBe("invalid-profile-name");
    expect(err.status).toBe(400);
  });

  it("missing param + allowImplicitDefault: false → 400 missing-profile", () => {
    const { home, repo } = mk();
    const err = resolveProfileContext(empty, {
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: false,
    });
    expect(isErr(err)).toBe(true);
    if (!isErr(err)) return;
    expect(err.code).toBe("missing-profile");
    expect(err.status).toBe(400);
  });

  it("missing param + sentinel + no config-default → 400 implicit-default-blocked", () => {
    const { home, repo } = mk();
    const sentinelDir = profileDir("default", { repoRoot: repo });
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, ".no-default-allowed"), "");
    const err = resolveProfileContext(empty, { ariannaHome: home, repoRoot: repo });
    expect(isErr(err)).toBe(true);
    if (!isErr(err)) return;
    expect(err.code).toBe("implicit-default-blocked");
    expect(err.status).toBe(400);
  });

  it("unknown valid name → 404 unknown-profile", () => {
    const { home, repo } = mk();
    const err = resolveProfileContext(
      { query: "ghost", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(err)).toBe(true);
    if (!isErr(err)) return;
    expect(err.code).toBe("unknown-profile");
    expect(err.status).toBe(404);
  });

  it("conflicting query and header → 400", () => {
    const { home, repo } = mk();
    seedConfig(home, `[profile alpha]\nport_offset = 0\n[profile beta]\nport_offset = 1\n`);
    const err = resolveProfileContext(
      { query: "alpha", header: "beta" },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(err)).toBe(true);
    if (!isErr(err)) return;
    expect(err.code).toBe("invalid-profile-name");
    expect(err.status).toBe(400);
  });
});

describe("composeBaseCommand", () => {
  it("returns plain `docker compose` for legacy", () => {
    const { home, repo } = mk();
    const ctx = resolveProfileContext(empty, { ariannaHome: home, repoRoot: repo });
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(composeBaseCommand(ctx, repo)).toBe("docker compose");
  });

  it("includes -p and -f flags for a named profile, with repo-relative override path", () => {
    const { home, repo } = mk();
    seedConfig(home, `[profile alpha]\nport_offset = 1\n`);
    const ctx = resolveProfileContext(
      { query: "alpha", header: null },
      { ariannaHome: home, repoRoot: repo },
    );
    expect(isErr(ctx)).toBe(false);
    if (isErr(ctx)) return;
    expect(composeBaseCommand(ctx, repo)).toBe(
      "docker compose -p arianna-alpha -f docker-compose.yml -f workspace/profiles/alpha/compose.override.yml",
    );
  });
});
