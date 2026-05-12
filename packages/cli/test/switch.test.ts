import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSwitch, SwitchCommandError } from "../src/commands/switch.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";

function configFor() {
  return resolveConfig({
    env: {},
    ariannaHome: ISOLATED_ARIANNA_HOME,
    allowImplicitDefault: true,
  });
}

describe("runSwitch", () => {
  it("POSTs /restore with the snapshot id and the resolved profile", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, snapshotId: "snap_1" }), { status: 200 }),
    );
    const writes: string[] = [];

    const code = await runSwitch(
      { snapshotId: "snap_1", allowCrossPersonalization: false },
      configFor(),
      { fetch: fetchMock as never, write: (l) => writes.push(l) },
    );

    expect(code).toBe(0);
    expect(writes.join("")).toContain("switched to snap_1");

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/restore");
    expect(url.searchParams.get("profile")).toBe("default");
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ snapshotId: "snap_1" });
  });

  it("rejects unsafe snapshot ids before any HTTP call (defense-in-depth)", async () => {
    const fetchMock = vi.fn();
    await expect(
      runSwitch(
        { snapshotId: "snap;rm", allowCrossPersonalization: false },
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(SwitchCommandError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces 'snapshot not found' clearly", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "snapshot image ariannarun-vessel:session_1-snap_1 not found" }),
        { status: 500 },
      ),
    );
    await expect(
      runSwitch(
        { snapshotId: "snap_1", allowCrossPersonalization: false },
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(/snapshot not found/);
  });

  it("surfaces network errors", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      runSwitch(
        { snapshotId: "snap_1", allowCrossPersonalization: false },
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(/daemon unreachable/);
  });

  it("surfaces other daemon errors verbatim", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "vessel did not become healthy within 30s" }), { status: 500 }),
    );
    await expect(
      runSwitch(
        { snapshotId: "snap_1", allowCrossPersonalization: false },
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(/switch failed: vessel did not become healthy/);
  });
});

// ── Personalization pre-check (Iko revival fix, 2026-05-09) ──────────────
//
// Before POSTing /restore, runSwitch verifies that the source snapshot's
// vessel image was built for the same AI username as the active profile.
// The trigger: an operator forks/replays a profile (rebuilds the vessel
// image with a different aiUsername), but the snapshot meta still references
// the old image. Restoring would silently lose the personalized /home/<user>
// directory.

describe("runSwitch — personalization pre-check", () => {
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "arianna-switch-home-"));
    repo = mkdtempSync(join(tmpdir(), "arianna-switch-repo-"));
    // Marker file resolveRepoRoot looks for.
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    // Profile config so the resolver picks "iko" (port_offset=0 since we
    // don't care about ports for these tests — daemon URL is mocked).
    mkdirSync(join(home), { recursive: true });
    writeFileSync(
      join(home, "config"),
      ["[default]", "profile = iko", "", "[profile iko]", "port_offset = 0", ""].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  function makeProfile(aiUsername: string): void {
    const profileDir = join(repo, "workspace", "profiles", "iko");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "session_config.json"),
      JSON.stringify({
        externalLlmApiKey: "x",
        provider: "google",
        modelId: "gemini",
        aiName: "Iko",
        aiUsername,
        difficulty: "normal",
        createdAt: 1778000000000,
        sessionId: "session_1778000000000",
      }),
    );
  }

  function makeSnapshot(snapshotId: string, dockerImage: string): void {
    const snapsDir = join(repo, "workspace", "profiles", "iko", "snapshots");
    mkdirSync(snapsDir, { recursive: true });
    writeFileSync(
      join(snapsDir, `${snapshotId}.json`),
      JSON.stringify({
        id: snapshotId,
        dockerImage,
        timestamp: 1778000000001,
        parentId: null,
        changedFiles: [],
        sessionId: "session_1778000000000",
      }),
    );
  }

  function configFor(): ReturnType<typeof resolveConfig> {
    return resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      cwd: repo,
      allowImplicitDefault: true,
    });
  }

  it("refuses when /etc/passwd has no line for the expected aiUsername", async () => {
    makeProfile("iko");
    makeSnapshot("snap_1", "ariannarun-vessel:session_1778000000000-snap_1");
    const fetchMock = vi.fn();
    // /etc/passwd from a vessel built for `pax`, not `iko`.
    const passwdForPax =
      "root:x:0:0:root:/root:/bin/sh\n" +
      "pax:x:1000:1000:Linux User,,,:/home/pax:/bin/sh\n";
    const exec = vi.fn(async () => ({ stdout: passwdForPax, stderr: "" }));

    await expect(
      runSwitch(
        { snapshotId: "snap_1", allowCrossPersonalization: false },
        configFor(),
        {
          fetch: fetchMock as never,
          write: () => {},
          exec,
          pathOpts: { ariannaHome: home, repoRoot: repo, cwd: repo },
        },
      ),
    ).rejects.toThrowError(/built for AI "pax".*runs as AI "iko"/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toContain("ariannarun-vessel:session_1778000000000-snap_1");
    expect(exec.mock.calls[0][0]).toContain("/etc/passwd");
  });

  it("permits the switch when /etc/passwd contains the expected aiUsername", async () => {
    makeProfile("iko");
    makeSnapshot("snap_1", "ariannarun-vessel:session_1778000000000-snap_1");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const passwdForIko =
      "root:x:0:0:root:/root:/bin/sh\n" +
      "iko:x:1000:1000:Linux User,,,:/home/iko:/bin/sh\n";
    const exec = vi.fn(async () => ({ stdout: passwdForIko, stderr: "" }));

    const code = await runSwitch(
      { snapshotId: "snap_1", allowCrossPersonalization: false },
      configFor(),
      {
        fetch: fetchMock as never,
        write: () => {},
        exec,
        pathOpts: { ariannaHome: home, repoRoot: repo, cwd: repo },
      },
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("--allow-cross-personalization bypasses the check", async () => {
    makeProfile("iko");
    makeSnapshot("snap_1", "ariannarun-vessel:session_1778000000000-snap_1");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const exec = vi.fn(async () => ({
      stdout: "pax:x:1000:1000::/home/pax:/bin/sh\n",
      stderr: "",
    }));

    const code = await runSwitch(
      { snapshotId: "snap_1", allowCrossPersonalization: true },
      configFor(),
      {
        fetch: fetchMock as never,
        write: () => {},
        exec,
        pathOpts: { ariannaHome: home, repoRoot: repo, cwd: repo },
      },
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // exec should NOT be called when bypass is set — saves a docker run.
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls through to daemon when snapshot meta is missing (skipped, not refused)", async () => {
    makeProfile("iko");
    // Deliberately do NOT write a snapshot meta. The check skips and the
    // daemon's existence check (`snapshot image ... not found`) becomes the
    // gating signal.
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "snapshot image ariannarun-vessel:session_X-snap_1 not found" }),
        { status: 500 },
      ),
    );
    const exec = vi.fn();
    await expect(
      runSwitch(
        { snapshotId: "snap_1", allowCrossPersonalization: false },
        configFor(),
        {
          fetch: fetchMock as never,
          write: () => {},
          exec: exec as never,
          pathOpts: { ariannaHome: home, repoRoot: repo, cwd: repo },
        },
      ),
    ).rejects.toThrowError(/snapshot not found/);
    expect(exec).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not collide on aiUsername prefix (e.g. 'pax' vs 'paxter')", async () => {
    // Anchor: /etc/passwd lines start with `<user>:` — a regex without a
    // start anchor would falsely match `paxter:` for expected `pax`. Verify
    // we anchor on the line head.
    makeProfile("pax");
    makeSnapshot("snap_1", "ariannarun-vessel:session_1778000000000-snap_1");
    const fetchMock = vi.fn();
    const passwdForPaxter =
      "root:x:0:0::/root:/bin/sh\n" +
      "paxter:x:1000:1000::/home/paxter:/bin/sh\n";
    const exec = vi.fn(async () => ({ stdout: passwdForPaxter, stderr: "" }));

    await expect(
      runSwitch(
        { snapshotId: "snap_1", allowCrossPersonalization: false },
        configFor(),
        {
          fetch: fetchMock as never,
          write: () => {},
          exec,
          pathOpts: { ariannaHome: home, repoRoot: repo, cwd: repo },
        },
      ),
    ).rejects.toThrowError(/built for AI "paxter".*runs as AI "pax"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through when docker run fails (image missing locally, etc.)", async () => {
    makeProfile("iko");
    makeSnapshot("snap_1", "ariannarun-vessel:session_1778000000000-snap_1");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const exec = vi.fn(async () => {
      throw new Error("Unable to find image 'ariannarun-vessel:...' locally");
    });

    // Skipped → daemon call proceeds; daemon would surface a real error
    // if the image is actually missing. Returning 200 here mirrors the
    // case where the image exists on the host running the daemon but
    // not on the host running the CLI (rare but possible with split setups).
    const code = await runSwitch(
      { snapshotId: "snap_1", allowCrossPersonalization: false },
      configFor(),
      {
        fetch: fetchMock as never,
        write: () => {},
        exec,
        pathOpts: { ariannaHome: home, repoRoot: repo, cwd: repo },
      },
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("rejects an image tag that doesn't match the ariannarun-vessel:* shape", async () => {
    makeProfile("iko");
    // Smuggle a meta file whose dockerImage has a backtick shell-injection
    // attempt. The pre-check skips (verdict=skipped), and the daemon takes
    // over — which is the safe behavior. We're verifying the CLI doesn't
    // shell out to docker with the smuggled tag.
    const snapsDir = join(repo, "workspace", "profiles", "iko", "snapshots");
    mkdirSync(snapsDir, { recursive: true });
    writeFileSync(
      join(snapsDir, "snap_1.json"),
      JSON.stringify({
        id: "snap_1",
        dockerImage: "evil`whoami`:tag",
        timestamp: 1778000000001,
        parentId: null,
        changedFiles: [],
        sessionId: "session_1778000000000",
      }),
    );
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const code = await runSwitch(
      { snapshotId: "snap_1", allowCrossPersonalization: false },
      configFor(),
      {
        fetch: fetchMock as never,
        write: () => {},
        exec,
        pathOpts: { ariannaHome: home, repoRoot: repo, cwd: repo },
      },
    );
    expect(code).toBe(0);
    // The CLI must NOT have shelled out to docker with the smuggled tag.
    expect(exec).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
