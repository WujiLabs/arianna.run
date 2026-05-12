import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleProfileCreate } from "../src/daemon-profile-create.js";
import { ariannaConfigPath, profileDir, profileOverridePath } from "@arianna/cli/paths";
import { loadConfig } from "@arianna/cli/arianna-config";

// Gap 12 (validation agent abf126be, 2026-05-09): the daemon's
// /profile-create endpoint runs the same allocator + override-write +
// config-update logic as `arianna profile create`, but on the host
// filesystem so an OpenClaw-container CLI can create a profile end-to-end.

function mk() {
  const home = mkdtempSync(join(tmpdir(), "daemon-pc-home-"));
  const repo = mkdtempSync(join(tmpdir(), "daemon-pc-repo-"));
  // docker-compose.yml marker so paths resolution stays self-contained.
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

describe("daemon /profile-create handler", () => {
  it("happy path: allocates port 0, writes override, updates ~/.arianna/config, becomes default", async () => {
    const { home, repo } = mk();
    const result = await handleProfileCreate({
      name: "alpha",
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe("alpha");
    expect(result.portOffset).toBe(0);
    expect(result.vesselPort).toBe(3000);
    expect(result.sidecarPort).toBe(8000);
    expect(result.daemonPort).toBe(9000);
    expect(result.isDefault).toBe(true);

    // Side effects: workspace dir, override file, config entry.
    expect(existsSync(profileDir("alpha", { repoRoot: repo }))).toBe(true);
    const overridePath = profileOverridePath("alpha", { repoRoot: repo });
    expect(existsSync(overridePath)).toBe(true);
    expect(readFileSync(overridePath, "utf-8")).toMatch(/127\.0\.0\.1:3000:3000/);

    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.profiles.get("alpha")?.portOffset).toBe(0);
    expect(cfg.defaultProfile).toBe("alpha");
  });

  it("subsequent creates pick the next free offset and don't override default", async () => {
    const { home, repo } = mk();
    await handleProfileCreate({ name: "alpha", ariannaHome: home, repoRoot: repo, skipBindTest: true });
    const second = await handleProfileCreate({
      name: "beta",
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.portOffset).toBe(1);
    expect(second.vesselPort).toBe(3001);
    expect(second.isDefault).toBe(false);

    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.defaultProfile).toBe("alpha");
  });

  it("rejects an invalid profile name with status 400 and code invalid-profile-name", async () => {
    const { home, repo } = mk();
    const result = await handleProfileCreate({
      name: "Bad-Name",
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe("invalid-profile-name");
  });

  it("rejects an empty name with status 400 and code missing-name", async () => {
    const { home, repo } = mk();
    const result = await handleProfileCreate({
      name: "",
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe("missing-name");
  });

  it("returns 409 profile-exists when the name is already in ~/.arianna/config", async () => {
    const { home, repo } = mk();
    await handleProfileCreate({ name: "alpha", ariannaHome: home, repoRoot: repo, skipBindTest: true });
    const dup = await handleProfileCreate({
      name: "alpha",
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.status).toBe(409);
    expect(dup.code).toBe("profile-exists");
  });

  it("returns 409 profile-dir-exists when an untracked dir squats on the name", async () => {
    const { home, repo } = mk();
    mkdirSync(profileDir("ghost", { repoRoot: repo }), { recursive: true });
    const result = await handleProfileCreate({
      name: "ghost",
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("profile-dir-exists");
    // The pre-existing dir wasn't trampled.
    expect(existsSync(profileDir("ghost", { repoRoot: repo }))).toBe(true);
    // No config entry was written.
    expect(existsSync(ariannaConfigPath({ ariannaHome: home }))).toBe(false);
  });

  it("rejects out-of-range explicit port_offset with status 400 and code invalid-port-offset", async () => {
    const { home, repo } = mk();
    const result = await handleProfileCreate({
      name: "alpha",
      portOffset: 100,
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe("invalid-port-offset");
  });

  it("rejects an explicit port_offset that doesn't match what the allocator would pick (409 offset-unavailable)", async () => {
    // alpha gets offset=0; an explicit request for offset=5 against an
    // empty repo (where 0 is available) fails — we never silently honor an
    // explicit request that disagrees with the allocator's choice.
    const { home, repo } = mk();
    const result = await handleProfileCreate({
      name: "alpha",
      portOffset: 5,
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("offset-unavailable");
    // The dir was rolled back.
    expect(existsSync(profileDir("alpha", { repoRoot: repo }))).toBe(false);
  });
});
