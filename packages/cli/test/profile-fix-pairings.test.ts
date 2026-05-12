// Tests for `arianna profile fix-pairings <name>` — the operator-runnable
// rescue that reconstructs missing snapshot-history pairing files from the
// docker-image inventory. The command is the human-runnable backstop for
// the snapshot-pairing-loss bug (2026-05-11): when sidecar cleanup wipes
// pairings the daemon's /restore gate then refuses to retag the snapshot's
// image — fix-pairings re-creates the JSON files in one pass.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runProfileFixPairings,
  ProfileFixPairingsError,
} from "../src/commands/profile-fix-pairings.js";

interface Harness {
  repoRoot: string;
  profileDir: string;
  histDir: string;
  cleanup: () => void;
  out: string[];
  warn: string[];
  fetchCalls: string[];
}

function makeHarness(profileName: string): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "arianna-fix-pairings-"));
  const repoRoot = join(tmp, "repo");
  // Mirror profile-snapshot-overlay's test scaffolding — resolveRepoRoot
  // walks up looking for docker-compose.yml AND packages/cli +
  // packages/types markers (looksLikeAriannaRepo).
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, "docker-compose.yml"), "services: {}\n");
  mkdirSync(join(repoRoot, "packages", "cli"), { recursive: true });
  mkdirSync(join(repoRoot, "packages", "types"), { recursive: true });

  const profileDir = join(repoRoot, "workspace", "profiles", profileName);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "session_config.json"),
    JSON.stringify({ sessionId: "session_1", aiUsername: "aril" }),
  );

  return {
    repoRoot,
    profileDir,
    histDir: join(profileDir, "sidecar-state", "snapshot-histories"),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    out: [],
    warn: [],
    fetchCalls: [],
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeFetch(
  h: Harness,
  responseBody: unknown,
  opts: { ok?: boolean; throwError?: string } = {},
): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    h.fetchCalls.push(String(input));
    if (opts.throwError) throw new Error(opts.throwError);
    return jsonResponse(responseBody, opts.ok ?? true);
  }) as unknown as typeof globalThis.fetch;
}

const SAMPLE_DETAILS = [
  {
    snapshotId: "snap_1778455594975",
    sessionId: "session_1778437900722",
    repo: "ariannarun-vessel-canary-fresh-1",
    tag: "ariannarun-vessel-canary-fresh-1:session_1778437900722-snap_1778455594975",
  },
  {
    snapshotId: "snap_overlay_1778513013916",
    sessionId: "session_1778437900722",
    repo: "ariannarun-vessel-canary-fresh-1",
    tag: "ariannarun-vessel-canary-fresh-1:session_1778437900722-snap_overlay_1778513013916",
  },
  {
    snapshotId: "snap_post_209_active",
    sessionId: "session_1778437900722",
    repo: "ariannarun-vessel-canary-fresh-1",
    tag: "ariannarun-vessel-canary-fresh-1:session_1778437900722-snap_post_209_active",
  },
];

const SAMPLE_BODY = {
  ids: SAMPLE_DETAILS.map((r) => r.snapshotId),
  details: SAMPLE_DETAILS,
};

let h: Harness;

beforeEach(() => {
  h = makeHarness("canary");
});

afterEach(() => {
  h.cleanup();
});

describe("runProfileFixPairings — happy path", () => {
  it("writes pairings for every docker-image-extant snapshot that lacks one", async () => {
    const exitCode = await runProfileFixPairings(
      { name: "canary", dryRun: false },
      {
        repoRoot: h.repoRoot,
        write: (line) => h.out.push(line),
        warn: (line) => h.warn.push(line),
        fetch: makeFetch(h, SAMPLE_BODY),
        daemonUrl: "http://test-daemon.test",
      },
    );
    expect(exitCode).toBe(0);

    const files = readdirSync(h.histDir).sort();
    expect(files).toEqual([
      "snap_1778455594975.json",
      "snap_overlay_1778513013916.json",
      "snap_post_209_active.json",
    ]);
    for (const rec of SAMPLE_DETAILS) {
      const path = join(h.histDir, `${rec.snapshotId}.json`);
      const body = JSON.parse(readFileSync(path, "utf-8"));
      expect(body).toEqual({
        snapshotId: rec.snapshotId,
        sessionId: rec.sessionId,
      });
    }
  });

  it("includes ?profile=<name> in the daemon fetch URL", async () => {
    await runProfileFixPairings(
      { name: "canary", dryRun: false },
      {
        repoRoot: h.repoRoot,
        write: (line) => h.out.push(line),
        fetch: makeFetch(h, SAMPLE_BODY),
        daemonUrl: "http://test-daemon.test",
      },
    );
    expect(h.fetchCalls).toEqual([
      "http://test-daemon.test/snapshot-images?profile=canary",
    ]);
  });

  it("is idempotent: re-running with existing pairings touches nothing", async () => {
    // First pass: writes all three pairings.
    await runProfileFixPairings(
      { name: "canary", dryRun: false },
      {
        repoRoot: h.repoRoot,
        write: (line) => h.out.push(line),
        fetch: makeFetch(h, SAMPLE_BODY),
        daemonUrl: "http://test-daemon.test",
      },
    );

    // Capture file mtimes so we can confirm nothing was rewritten.
    const beforeMtimes = SAMPLE_DETAILS.map(
      (r) =>
        [r.snapshotId, readFileSync(join(h.histDir, `${r.snapshotId}.json`), "utf-8")] as const,
    );

    // Reset the output buffer so we can read the second-run summary in
    // isolation.
    h.out.length = 0;
    await runProfileFixPairings(
      { name: "canary", dryRun: false },
      {
        repoRoot: h.repoRoot,
        write: (line) => h.out.push(line),
        fetch: makeFetch(h, SAMPLE_BODY),
        daemonUrl: "http://test-daemon.test",
      },
    );
    // Summary should say "0 pairings written, 3 already present."
    const summary = h.out.join("");
    expect(summary).toMatch(/0 pairings written/);
    expect(summary).toMatch(/3 already present/);
    // Byte content unchanged.
    for (const [snapshotId, expected] of beforeMtimes) {
      const actual = readFileSync(
        join(h.histDir, `${snapshotId}.json`),
        "utf-8",
      );
      expect(actual).toBe(expected);
    }
  });

  it("does NOT overwrite an existing pairing even if its sessionId disagrees with docker", async () => {
    // Operator may have run `arianna fork` (which rewrites sessionId in
    // pairings to the destination's sessionId). fix-pairings must not
    // clobber that choice with the docker tag's sessionId.
    mkdirSync(h.histDir, { recursive: true });
    const path = join(h.histDir, "snap_1778455594975.json");
    const preservedBody = JSON.stringify({
      snapshotId: "snap_1778455594975",
      sessionId: "session_FORKED_DST",
    });
    writeFileSync(path, preservedBody);

    await runProfileFixPairings(
      { name: "canary", dryRun: false },
      {
        repoRoot: h.repoRoot,
        write: (line) => h.out.push(line),
        fetch: makeFetch(h, SAMPLE_BODY),
        daemonUrl: "http://test-daemon.test",
      },
    );

    expect(readFileSync(path, "utf-8")).toBe(preservedBody);
  });
});

describe("runProfileFixPairings — dry-run", () => {
  it("prints WOULD CREATE and writes no files", async () => {
    await runProfileFixPairings(
      { name: "canary", dryRun: true },
      {
        repoRoot: h.repoRoot,
        write: (line) => h.out.push(line),
        fetch: makeFetch(h, SAMPLE_BODY),
        daemonUrl: "http://test-daemon.test",
      },
    );
    expect(existsSync(h.histDir)).toBe(false);
    const summary = h.out.join("");
    expect(summary).toMatch(/WOULD CREATE/);
    expect(summary).toMatch(/3 would create/);
  });
});

describe("runProfileFixPairings — error paths", () => {
  it("throws when the profile directory has no session_config.json", async () => {
    await expect(
      runProfileFixPairings(
        { name: "nonexistent-profile", dryRun: false },
        {
          repoRoot: h.repoRoot,
          write: (line) => h.out.push(line),
          fetch: makeFetch(h, SAMPLE_BODY),
          daemonUrl: "http://test-daemon.test",
        },
      ),
    ).rejects.toBeInstanceOf(ProfileFixPairingsError);
  });

  it("wraps a daemon non-200 response in a clear error", async () => {
    await expect(
      runProfileFixPairings(
        { name: "canary", dryRun: false },
        {
          repoRoot: h.repoRoot,
          write: (line) => h.out.push(line),
          fetch: makeFetch(h, { error: "daemon boom" }, { ok: false }),
          daemonUrl: "http://test-daemon.test",
        },
      ),
    ).rejects.toThrow(/500/);
  });

  it("wraps a fetch failure (daemon unreachable) with an actionable hint", async () => {
    let err: unknown;
    try {
      await runProfileFixPairings(
        { name: "canary", dryRun: false },
        {
          repoRoot: h.repoRoot,
          write: (line) => h.out.push(line),
          fetch: makeFetch(h, null, { throwError: "ECONNREFUSED" }),
          daemonUrl: "http://test-daemon.test",
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProfileFixPairingsError);
    expect((err as Error).message).toMatch(/daemon status/);
  });

  it("returns 0 with a benign message when daemon reports no images", async () => {
    const exitCode = await runProfileFixPairings(
      { name: "canary", dryRun: false },
      {
        repoRoot: h.repoRoot,
        write: (line) => h.out.push(line),
        fetch: makeFetch(h, { ids: [], details: [] }),
        daemonUrl: "http://test-daemon.test",
      },
    );
    expect(exitCode).toBe(0);
    expect(h.out.join("")).toMatch(/No snapshot images found/);
    expect(existsSync(h.histDir)).toBe(false);
  });
});
