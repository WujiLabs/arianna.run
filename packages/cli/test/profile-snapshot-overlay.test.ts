// Tests for `arianna profile snapshot-overlay <name>` — the operator-runnable
// preventive that commits the running vessel container's writable overlay to
// a docker image tag before a `docker compose build vessel` would stomp it.
//
// Bug #224 (Tessa fresh-canvas Flash retest 2026-05-10): the command tagged
// the overlay image but did NOT write the snapshot-history pairing file at
// workspace/profiles/<name>/sidecar-state/snapshot-histories/<id>.json.
// Result: `arianna profile switch <snap-id>` rejected every snapshot-overlay
// tag because the daemon's /restore gate (snapshotPairingExists →
// sidecar /snapshot-exists) requires the file to exist before it will retag
// the image into the -current slot. Map/switch recovery was broken for any
// profile whose snapshots came from snapshot-overlay (vs the daemon's
// automatic snapshot-on-/sync, which goes through the sidecar's
// writeSnapshotPairingAtomic).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runProfileSnapshotOverlay,
  ProfileSnapshotOverlayError,
} from "../src/commands/profile-snapshot-overlay.js";
import type { CloneExecResult } from "../src/commands/_profile-clone-helpers.js";

interface Harness {
  repoRoot: string;
  profileDir: string;
  cleanup: () => void;
  out: string[];
  warn: string[];
  execLog: string[];
}

function makeHarness(profileName: string, sessionId: string, aiUsername = "tessa"): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "arianna-snapshot-overlay-"));
  const repoRoot = join(tmp, "repo");
  mkdirSync(repoRoot, { recursive: true });
  // resolveRepoRoot looks for docker-compose.yml — write a stub. profileDir
  // resolution also needs packages/cli + packages/types to satisfy
  // looksLikeAriannaRepo; create those as empty marker dirs.
  writeFileSync(join(repoRoot, "docker-compose.yml"), "services: {}\n");
  mkdirSync(join(repoRoot, "packages", "cli"), { recursive: true });
  mkdirSync(join(repoRoot, "packages", "types"), { recursive: true });

  const profileDir = join(repoRoot, "workspace", "profiles", profileName);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "session_config.json"),
    JSON.stringify({ sessionId, aiUsername }),
  );

  return {
    repoRoot,
    profileDir,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    out: [],
    warn: [],
    execLog: [],
  };
}

function makeExec(
  h: Harness,
  opts: {
    containerStatus?: "running" | "exited" | "missing";
    failOn?: RegExp;
    failError?: string;
  } = {},
): (cmd: string) => Promise<CloneExecResult> {
  const status = opts.containerStatus ?? "running";
  return async (cmd: string): Promise<CloneExecResult> => {
    h.execLog.push(cmd);
    if (opts.failOn && opts.failOn.test(cmd)) {
      throw new Error(opts.failError ?? "exec failed");
    }
    if (cmd.startsWith("docker inspect ")) {
      if (status === "missing") {
        throw new Error("No such object");
      }
      return { stdout: status + "\n", stderr: "" };
    }
    // docker commit / docker tag — return empty success.
    return { stdout: "", stderr: "" };
  };
}

describe("profile-snapshot-overlay #224 — pairing file write", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness("alpha", "alpha-session-123");
  });

  afterEach(() => {
    h.cleanup();
  });

  it("writes a pairing file at sidecar-state/snapshot-histories/<id>.json", async () => {
    const code = await runProfileSnapshotOverlay(
      { name: "alpha" },
      {
        exec: makeExec(h),
        write: (s) => h.out.push(s),
        warn: (s) => h.warn.push(s),
        repoRoot: h.repoRoot,
      },
    );

    expect(code).toBe(0);

    // Locate the pairing file. The snapshotId is `snap_overlay_<ts>` where
    // ts === Date.now() at the moment runProfileSnapshotOverlay computed it.
    // Rather than racing the clock, look up the only file in the dir.
    const histDir = join(h.profileDir, "sidecar-state", "snapshot-histories");
    expect(existsSync(histDir)).toBe(true);
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(histDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^snap_overlay_\d+\.json$/);

    const snapshotId = files[0].replace(/\.json$/, "");
    const pairing = JSON.parse(
      readFileSync(join(histDir, files[0]), "utf-8"),
    ) as { snapshotId: string; sessionId: string };

    // Format must match what the sidecar's writeSnapshotPairingAtomic writes
    // (snapshotId field) plus sessionId (so `arianna fork`'s
    // copySnapshotHistories rewrite path works on overlay-snapshotted
    // profiles).
    expect(pairing.snapshotId).toBe(snapshotId);
    expect(pairing.sessionId).toBe("alpha-session-123");
  });

  it("creates snapshot-histories/ dir if it doesn't exist", async () => {
    // Pre-condition: dir does not exist (the harness only writes
    // session_config.json, not sidecar-state/).
    const histDir = join(h.profileDir, "sidecar-state", "snapshot-histories");
    expect(existsSync(histDir)).toBe(false);

    const code = await runProfileSnapshotOverlay(
      { name: "alpha" },
      {
        exec: makeExec(h),
        write: (s) => h.out.push(s),
        warn: (s) => h.warn.push(s),
        repoRoot: h.repoRoot,
      },
    );

    expect(code).toBe(0);
    expect(existsSync(histDir)).toBe(true);
  });

  it("reuses an existing snapshot-histories/ dir without erroring", async () => {
    // Operator may already have one (e.g. from a prior daemon-driven snapshot
    // that DID go through the sidecar's writeSnapshotPairingAtomic).
    const histDir = join(h.profileDir, "sidecar-state", "snapshot-histories");
    mkdirSync(histDir, { recursive: true });
    writeFileSync(
      join(histDir, "snap_999.json"),
      JSON.stringify({ snapshotId: "snap_999" }),
    );

    const code = await runProfileSnapshotOverlay(
      { name: "alpha" },
      {
        exec: makeExec(h),
        write: (s) => h.out.push(s),
        warn: (s) => h.warn.push(s),
        repoRoot: h.repoRoot,
      },
    );

    expect(code).toBe(0);
    // Pre-existing file untouched.
    expect(
      JSON.parse(readFileSync(join(histDir, "snap_999.json"), "utf-8")),
    ).toEqual({ snapshotId: "snap_999" });
    // Newly written file present.
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(histDir).sort();
    expect(files).toHaveLength(2);
    expect(files.some((f) => /^snap_overlay_\d+\.json$/.test(f))).toBe(true);
  });

  it("emits the pairing path in the success message", async () => {
    await runProfileSnapshotOverlay(
      { name: "alpha" },
      {
        exec: makeExec(h),
        write: (s) => h.out.push(s),
        warn: (s) => h.warn.push(s),
        repoRoot: h.repoRoot,
      },
    );

    const combined = h.out.join("");
    expect(combined).toContain("paired history:");
    expect(combined).toContain(
      join(h.profileDir, "sidecar-state", "snapshot-histories"),
    );
  });

  it("throws ProfileSnapshotOverlayError if session_config.json is missing", async () => {
    rmSync(join(h.profileDir, "session_config.json"));
    await expect(
      runProfileSnapshotOverlay(
        { name: "alpha" },
        {
          exec: makeExec(h),
          write: (s) => h.out.push(s),
          warn: (s) => h.warn.push(s),
          repoRoot: h.repoRoot,
        },
      ),
    ).rejects.toBeInstanceOf(ProfileSnapshotOverlayError);
  });
});
