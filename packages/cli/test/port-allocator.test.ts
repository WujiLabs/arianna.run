import { describe, it, expect } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocateOffset,
  allocateOffsetLocked,
  PortAllocationError,
  readTakenOffsets,
  STALE_LOCK_MS,
  withPortLock,
} from "../src/port-allocator.js";
import { portsLockPath, profileOverridePath } from "../src/paths.js";
import { renderComposeOverride } from "../src/compose-override.js";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-port-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-port-repo-"));
  // docker-compose.yml marker so resolveRepoRoot would succeed if we used cwd.
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

function seedProfile(repo: string, name: string, offset: number) {
  const path = profileOverridePath(name, { repoRoot: repo });
  mkdirSync(join(repo, "workspace", "profiles", name), { recursive: true });
  writeFileSync(path, renderComposeOverride({ profile: name, portOffset: offset }));
}

describe("readTakenOffsets", () => {
  it("returns an empty set when profiles dir is missing", () => {
    const { repo } = mk();
    expect(readTakenOffsets({ repoRoot: repo })).toEqual(new Set());
  });

  it("collects offsets from existing compose.override.yml files", () => {
    const { repo } = mk();
    seedProfile(repo, "a", 0);
    seedProfile(repo, "b", 7);
    seedProfile(repo, "c", 12);
    const taken = readTakenOffsets({ repoRoot: repo });
    expect(taken).toEqual(new Set([0, 7, 12]));
  });

  it("ignores profile dirs without a compose.override.yml", () => {
    const { repo } = mk();
    mkdirSync(join(repo, "workspace", "profiles", "noyml"), { recursive: true });
    seedProfile(repo, "a", 4);
    expect(readTakenOffsets({ repoRoot: repo })).toEqual(new Set([4]));
  });
});

describe("allocateOffset", () => {
  it("returns 0 when no profiles exist (skipBindTest)", async () => {
    const { repo } = mk();
    const offset = await allocateOffset({ repoRoot: repo, skipBindTest: true });
    expect(offset).toBe(0);
  });

  it("picks the lowest free offset, skipping taken ones", async () => {
    const { repo } = mk();
    seedProfile(repo, "a", 0);
    seedProfile(repo, "b", 1);
    seedProfile(repo, "c", 3);
    const offset = await allocateOffset({ repoRoot: repo, skipBindTest: true });
    expect(offset).toBe(2);
  });

  it("respects bind-test failures", async () => {
    const { repo } = mk();
    seedProfile(repo, "a", 0);
    // Pretend 3001/8001/9001 are all bound. 3002/8002/9002 free.
    const isPortFree = async (port: number) => {
      if (port === 3001 || port === 8001 || port === 9001) return false;
      return true;
    };
    const offset = await allocateOffset({ repoRoot: repo, isPortFree });
    expect(offset).toBe(2);
  });

  it("throws when nothing is free", async () => {
    const { repo } = mk();
    const isPortFree = async () => false;
    await expect(
      allocateOffset({ repoRoot: repo, isPortFree }),
    ).rejects.toThrowError(PortAllocationError);
  });
});

describe("withPortLock", () => {
  it("creates and releases the lockfile", async () => {
    const { home } = mk();
    const lockPath = portsLockPath({ ariannaHome: home });
    expect(existsSync(lockPath)).toBe(false);

    let sawLock = false;
    await withPortLock(async () => {
      sawLock = existsSync(lockPath);
    }, { ariannaHome: home });

    expect(sawLock).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when fn throws", async () => {
    const { home } = mk();
    const lockPath = portsLockPath({ ariannaHome: home });
    await expect(
      withPortLock(async () => {
        throw new Error("boom");
      }, { ariannaHome: home }),
    ).rejects.toThrow(/boom/);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("times out when another stale-but-not-stale-enough lock is held", async () => {
    const { home } = mk();
    mkdirSync(home, { recursive: true });
    const lockPath = portsLockPath({ ariannaHome: home });
    closeSync(openSync(lockPath, "w"));
    // Touch the lock to "now" so it's not stale.
    const now = new Date();
    utimesSync(lockPath, now, now);
    const start = Date.now();
    await expect(
      withPortLock(async () => 1, {
        ariannaHome: home,
        acquireTimeoutMs: 200,
      }),
    ).rejects.toThrowError(PortAllocationError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it("does NOT break a stale-by-mtime lock if the recorded PID is still alive", async () => {
    const { home } = mk();
    mkdirSync(home, { recursive: true });
    const lockPath = portsLockPath({ ariannaHome: home });
    // Write our own PID into the lock — guaranteed alive while the test runs.
    const fd = openSync(lockPath, "w");
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    closeSync(fd);
    // Backdate the mtime past the stale threshold to simulate a long-running
    // legitimate lock-holder.
    const old = new Date(Date.now() - STALE_LOCK_MS - 1000);
    utimesSync(lockPath, old, old);

    const start = Date.now();
    await expect(
      withPortLock(async () => 1, {
        ariannaHome: home,
        acquireTimeoutMs: 200,
      }),
    ).rejects.toThrowError(PortAllocationError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it("breaks a stale lock and acquires", async () => {
    const { home } = mk();
    mkdirSync(home, { recursive: true });
    const lockPath = portsLockPath({ ariannaHome: home });
    closeSync(openSync(lockPath, "w"));
    // Backdate beyond stale threshold.
    const old = new Date(Date.now() - STALE_LOCK_MS - 1000);
    utimesSync(lockPath, old, old);

    let acquired = false;
    await withPortLock(async () => {
      acquired = true;
    }, { ariannaHome: home });
    expect(acquired).toBe(true);
  });
});

describe("allocateOffsetLocked", () => {
  it("acquires the lock and returns an offset", async () => {
    const { home, repo } = mk();
    seedProfile(repo, "a", 0);
    const offset = await allocateOffsetLocked({
      ariannaHome: home,
      repoRoot: repo,
      skipBindTest: true,
    });
    expect(offset).toBe(1);
  });
});
