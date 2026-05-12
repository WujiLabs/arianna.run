import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveProfile,
  requireProfile,
  ImplicitDefaultBlockedError,
  NoProfileResolvedError,
} from "../src/profile-resolver.js";
import { ariannaConfigPath, profileDir } from "../src/paths.js";
import { InvalidProfileNameError } from "../src/profile.js";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-resolver-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-resolver-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

function writeConfig(home: string, body: string) {
  const path = ariannaConfigPath({ ariannaHome: home });
  mkdirSync(home, { recursive: true });
  writeFileSync(path, body);
}

describe("resolveProfile", () => {
  it("returns flag with source=flag when --profile is set", () => {
    const r = resolveProfile({ flag: "alpha", env: {} });
    expect(r).toEqual({ name: "alpha", source: "flag" });
  });

  it("rejects an invalid flag value", () => {
    expect(() => resolveProfile({ flag: "BadName", env: {} })).toThrowError(
      InvalidProfileNameError,
    );
  });

  it("falls back to ARIANNA_PROFILE env", () => {
    const { home } = mk();
    const r = resolveProfile({
      env: { ARIANNA_PROFILE: "beta" },
      ariannaHome: home,
    });
    expect(r).toEqual({ name: "beta", source: "env" });
  });

  it("falls back to ~/.arianna/config [default] profile", () => {
    const { home } = mk();
    writeConfig(
      home,
      `[default]\nprofile = gamma\n\n[profile gamma]\nport_offset = 2\n`,
    );
    const r = resolveProfile({ env: {}, ariannaHome: home });
    expect(r).toEqual({ name: "gamma", source: "config-default" });
  });

  it("returns name=null when nothing matches and implicit-default disabled", () => {
    const { home } = mk();
    const r = resolveProfile({ env: {}, ariannaHome: home });
    expect(r).toEqual({ name: null, source: "none" });
  });

  it("returns implicit-default when allowed and no sentinel", () => {
    const { home, repo } = mk();
    const r = resolveProfile({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      allowImplicitDefault: true,
    });
    expect(r).toEqual({ name: "default", source: "implicit-default" });
  });

  it("throws ImplicitDefaultBlockedError when sentinel exists", () => {
    const { home, repo } = mk();
    const sentinelDir = profileDir("default", { repoRoot: repo });
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, ".no-default-allowed"), "");
    expect(() =>
      resolveProfile({
        env: {},
        ariannaHome: home,
        repoRoot: repo,
        allowImplicitDefault: true,
      }),
    ).toThrowError(ImplicitDefaultBlockedError);
  });

  it("flag wins over env which wins over config-default", () => {
    const { home } = mk();
    writeConfig(home, `[default]\nprofile = gamma\n`);
    expect(
      resolveProfile({
        flag: "alpha",
        env: { ARIANNA_PROFILE: "beta" },
        ariannaHome: home,
      }).name,
    ).toBe("alpha");
    expect(
      resolveProfile({
        env: { ARIANNA_PROFILE: "beta" },
        ariannaHome: home,
      }).name,
    ).toBe("beta");
    expect(resolveProfile({ env: {}, ariannaHome: home }).name).toBe("gamma");
  });
});

describe("requireProfile", () => {
  it("throws when nothing resolves", () => {
    const { home } = mk();
    expect(() => requireProfile({ env: {}, ariannaHome: home })).toThrowError(
      NoProfileResolvedError,
    );
  });

  it("returns when something resolves", () => {
    expect(requireProfile({ flag: "alpha", env: {} }).name).toBe("alpha");
  });
});
