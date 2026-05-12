import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ariannaConfigPath,
  findRepoRoot,
  noDefaultAllowedSentinelPath,
  portsLockPath,
  profileDir,
  profileOverridePath,
  profilesDir,
  resolveAriannaHome,
  resolveRepoRoot,
} from "../src/paths.js";

function mk() {
  return mkdtempSync(join(tmpdir(), "arianna-paths-"));
}

describe("resolveAriannaHome", () => {
  it("uses opts.ariannaHome when provided", () => {
    expect(resolveAriannaHome({ ariannaHome: "/x" })).toBe("/x");
  });

  it("falls back to ARIANNA_HOME env", () => {
    expect(resolveAriannaHome({ env: { ARIANNA_HOME: "/y" } })).toBe("/y");
  });

  it("falls back to homeDir/.arianna", () => {
    expect(resolveAriannaHome({ homeDir: "/home/test", env: {} })).toBe(
      "/home/test/.arianna",
    );
  });

  it("derives ariannaConfigPath / portsLockPath from home", () => {
    expect(ariannaConfigPath({ ariannaHome: "/x" })).toBe("/x/config");
    expect(portsLockPath({ ariannaHome: "/x" })).toBe("/x/ports.lock");
  });
});

describe("findRepoRoot", () => {
  it("returns null when no docker-compose.yml is found anywhere", () => {
    const tmp = mk();
    // Pin ariannaHome to a path with no /repo so the install fallback can't
    // accidentally resolve to a real ~/.arianna/repo on the dev machine.
    expect(findRepoRoot({ cwd: tmp, ariannaHome: tmp })).toBe(null);
  });

  it("finds docker-compose.yml in cwd", () => {
    const tmp = mk();
    writeFileSync(join(tmp, "docker-compose.yml"), "services: {}");
    expect(findRepoRoot({ cwd: tmp, ariannaHome: tmp })).toBe(tmp);
  });

  it("walks up to find docker-compose.yml in an ancestor", () => {
    const tmp = mk();
    writeFileSync(join(tmp, "docker-compose.yml"), "services: {}");
    const nested = join(tmp, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot({ cwd: nested, ariannaHome: tmp })).toBe(tmp);
  });

  it("falls back to ~/.arianna/repo when the cwd walk fails", () => {
    const cwdDir = mk();
    const home = mk();
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
    expect(findRepoRoot({ cwd: cwdDir, ariannaHome: home })).toBe(repo);
  });

  it("cwd walk wins over the install fallback when both have docker-compose.yml", () => {
    const cwdDir = mk();
    writeFileSync(join(cwdDir, "docker-compose.yml"), "services: {}");
    const home = mk();
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
    expect(findRepoRoot({ cwd: cwdDir, ariannaHome: home })).toBe(cwdDir);
  });

  // Gap 11 (validation agent abf126be, 2026-05-09): inside an openclaw
  // container the cwd walk could find a co-tenant project's
  // docker-compose.yml first (e.g. /workspace/openclaw/docker-compose.yml)
  // and adopt it as REPO_ROOT. `arianna profile create` then wrote profile
  // state into the wrong tree where the host daemon couldn't see it.
  // The smarter walk does a first pass for arianna-shaped roots
  // (docker-compose.yml + packages/cli + packages/types) before falling back
  // to the legacy any-compose-file behaviour.
  describe("co-tenant project (Gap 11)", () => {
    it("prefers an arianna-shaped ancestor over a closer co-tenant compose file", () => {
      // Set up: /tmp/<x>/arianna/docker-compose.yml + packages/{cli,types}
      // and a nested /tmp/<x>/arianna/openclaw/docker-compose.yml that LACKS
      // the packages/ layout. cwd walks from openclaw/ — the first pass
      // should skip openclaw/ and resolve to arianna/.
      const ariannaRoot = mk();
      writeFileSync(join(ariannaRoot, "docker-compose.yml"), "services: {}");
      mkdirSync(join(ariannaRoot, "packages", "cli"), { recursive: true });
      mkdirSync(join(ariannaRoot, "packages", "types"), { recursive: true });

      const coTenant = join(ariannaRoot, "openclaw");
      mkdirSync(coTenant, { recursive: true });
      writeFileSync(join(coTenant, "docker-compose.yml"), "services: {}");

      expect(findRepoRoot({ cwd: coTenant, ariannaHome: ariannaRoot })).toBe(
        ariannaRoot,
      );
    });

    it("falls back to bare docker-compose.yml when no arianna-shaped ancestor exists", () => {
      // Stripped-down arianna deployments (or bare-compose-file environments
      // that aren't co-tenant) should still resolve. The legacy contract is
      // preserved as the second pass.
      const tmp = mk();
      writeFileSync(join(tmp, "docker-compose.yml"), "services: {}");
      // No packages/cli or packages/types. Pass 1 misses; pass 2 catches.
      expect(findRepoRoot({ cwd: tmp, ariannaHome: tmp })).toBe(tmp);
    });

    it("ARIANNA_REPO_ROOT env override beats both the shape walk and the bare walk", () => {
      // Operator pin: an explicit env override always wins. Even if the cwd
      // walk would otherwise find an arianna-shaped repo nearby, the env
      // value gets the final say. Documented in paths.ts as the agent
      // escape hatch for sibling-checkout / git-worktree scenarios.
      const envRoot = mk();
      writeFileSync(join(envRoot, "docker-compose.yml"), "services: {}");

      const cwdRoot = mk();
      writeFileSync(join(cwdRoot, "docker-compose.yml"), "services: {}");
      mkdirSync(join(cwdRoot, "packages", "cli"), { recursive: true });
      mkdirSync(join(cwdRoot, "packages", "types"), { recursive: true });

      expect(
        findRepoRoot({
          cwd: cwdRoot,
          ariannaHome: cwdRoot,
          env: { ARIANNA_REPO_ROOT: envRoot },
        }),
      ).toBe(envRoot);
    });
  });
});

describe("resolveRepoRoot", () => {
  it("throws when not in a repo and no install fallback exists", () => {
    const tmp = mk();
    expect(() => resolveRepoRoot({ cwd: tmp, ariannaHome: tmp })).toThrowError(
      /Not inside an arianna repo/,
    );
  });

  it("returns opts.repoRoot when set, no walking", () => {
    expect(resolveRepoRoot({ repoRoot: "/some/path" })).toBe("/some/path");
  });
});

describe("profile path helpers", () => {
  it("derive paths from a fixed repoRoot", () => {
    expect(profilesDir({ repoRoot: "/r" })).toBe("/r/workspace/profiles");
    expect(profileDir("alpha", { repoRoot: "/r" })).toBe(
      "/r/workspace/profiles/alpha",
    );
    expect(profileOverridePath("alpha", { repoRoot: "/r" })).toBe(
      "/r/workspace/profiles/alpha/compose.override.yml",
    );
    expect(noDefaultAllowedSentinelPath({ repoRoot: "/r" })).toBe(
      "/r/workspace/profiles/default/.no-default-allowed",
    );
  });
});
