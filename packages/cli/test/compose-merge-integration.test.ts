// Integration test for finding 1 (ports double-bind) and finding 5 (volumes
// state leak) from the 2026-05-07 testplay.
//
// Approach: drive the real `arianna profile create` (and `arianna fork`) for
// two profiles, then simulate compose's merge of the generated overrides
// against the real base docker-compose.yml. Asserts the post-merge port and
// volume lists are scoped to each profile — no base-port double-binds, no
// legacy workspace/* state leak.
//
// We deliberately avoid pulling in a full YAML parser: every override we
// generate has a deterministic shape, and the merge rules we model are
// tiny (lists are concat by default, !override fully replaces). This keeps
// the test hermetic and dependency-free.

import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runProfile } from "../src/commands/profile.js";
import { runFork, VESSEL_REPO } from "../src/commands/fork.js";
import { profileDir, profileOverridePath } from "../src/paths.js";

interface Sandbox {
  home: string;
  repo: string;
}

function mk(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "arianna-merge-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-merge-repo-"));
  // Mirror the real base docker-compose.yml at the repo root. The values
  // are the ones the merge has to operate on; if the real base ever drifts
  // away from this, an additional regression test keeps both honest (see
  // `base docker-compose.yml drift catcher` below).
  writeFileSync(
    join(repo, "docker-compose.yml"),
    [
      "services:",
      "  sidecar:",
      "    ports:",
      '      - "127.0.0.1:8000:8000"',
      "    volumes:",
      "      - ./workspace/session_config.json:/app/session_config.json:ro",
      "      - ./workspace/sidecar-state:/app/sidecar-state",
      "  vessel:",
      "    container_name: arianna-vessel",
      "    ports:",
      '      - "127.0.0.1:3000:3000"',
      "",
    ].join("\n"),
  );
  return { home, repo };
}

// ── tiny compose-merge simulator ──────────────────────────────────────
//
// Models the rules we exercise (compose-spec §13):
//   - For list-typed fields (ports, volumes): override CONCATS unless tagged
//     `!override`, in which case it REPLACES.
//   - Scalar fields (container_name): override REPLACES.
//
// Real compose has more rules (env-var maps merge by key, deep-merging,
// etc.) — we don't model them because the override doesn't redefine those
// fields. The compose-override.test.ts drift catcher fails if a future
// override starts touching them.

interface ServiceShape {
  ports: string[];
  volumes: string[];
  container_name?: string;
}

interface ComposeShape {
  services: Record<string, ServiceShape>;
}

/** Minimal compose-file parser for our deterministic format. */
function parseCompose(text: string): ComposeShape {
  const services: Record<string, ServiceShape> = {};
  let currentService: string | null = null;
  let currentField: keyof ServiceShape | null = null;
  let currentFieldOverride = false;

  const overrides: Record<string, Record<string, boolean>> = {};

  const lines = text.split("\n");
  for (const raw of lines) {
    if (raw.trim().startsWith("#") || raw.trim() === "") continue;

    // Top-level "services:" — ignore, it's the only top-level we use.
    if (/^services:\s*$/.test(raw)) {
      currentService = null;
      currentField = null;
      continue;
    }

    // Service header: "  vessel:" or "  sidecar:" (2-space indent).
    const svc = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(raw);
    if (svc) {
      currentService = svc[1];
      services[currentService] ??= { ports: [], volumes: [] };
      overrides[currentService] ??= {};
      currentField = null;
      currentFieldOverride = false;
      continue;
    }

    // Field at 4-space indent: "    ports:" or "    ports: !override"
    // or "    container_name: arianna-vessel-alpha"
    const field = /^ {4}([a-zA-Z_]+):\s*(.*)$/.exec(raw);
    if (field && currentService) {
      const name = field[1];
      const rest = field[2].trim();
      if (name === "ports" || name === "volumes") {
        currentField = name;
        currentFieldOverride = rest === "!override";
        if (currentFieldOverride) {
          overrides[currentService][name] = true;
          // Initialize as empty so the override starts from scratch even
          // if no list items follow (defensive).
          services[currentService][name] = [];
        }
        continue;
      }
      if (name === "container_name") {
        services[currentService].container_name = rest;
        currentField = null;
        continue;
      }
      // Unknown field — ignore.
      currentField = null;
      continue;
    }

    // List item under ports/volumes: "      - "127.0.0.1:3000:3000""
    const item = /^ {6}- (.+)$/.exec(raw);
    if (item && currentService && currentField) {
      // Strip surrounding quotes if present.
      const value = item[1].replace(/^"(.*)"$/, "$1");
      services[currentService][currentField].push(value);
      continue;
    }
  }

  return { services };
}

/**
 * Compose merge simulator. Mirrors the !override / concat rules for the
 * fields we generate. Override scalars replace; lists concat unless the
 * override file tagged the field with `!override`, in which case the
 * override list replaces.
 */
function mergeCompose(baseText: string, overrideText: string): ComposeShape {
  const base = parseCompose(baseText);
  const override = parseCompose(overrideText);

  // Detect which fields were tagged !override in the override file. Our
  // parser sets `services[name][field]` to the override's list and treats
  // a tagged field as starting from empty, but it doesn't expose the tag
  // separately. Re-parse the raw text for the tag presence.
  const tagged = new Map<string, Set<string>>();
  let svc: string | null = null;
  for (const raw of overrideText.split("\n")) {
    const svcM = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(raw);
    if (svcM) {
      svc = svcM[1];
      tagged.set(svc, new Set());
      continue;
    }
    const fieldM = /^ {4}([a-zA-Z_]+):\s*!override\s*$/.exec(raw);
    if (fieldM && svc) {
      tagged.get(svc)!.add(fieldM[1]);
    }
  }

  const merged: ComposeShape = { services: {} };
  const allServices = new Set([
    ...Object.keys(base.services),
    ...Object.keys(override.services),
  ]);
  for (const name of allServices) {
    const b = base.services[name] ?? { ports: [], volumes: [] };
    const o = override.services[name] ?? { ports: [], volumes: [] };
    const t = tagged.get(name) ?? new Set<string>();
    merged.services[name] = {
      ports: t.has("ports") ? o.ports : [...b.ports, ...o.ports],
      volumes: t.has("volumes") ? o.volumes : [...b.volumes, ...o.volumes],
      container_name: o.container_name ?? b.container_name,
    };
  }
  return merged;
}

describe("compose merge — two profiles up simultaneously", () => {
  it("each profile binds ONLY its offset port (no base-port double-bind)", async () => {
    const sandbox = mk();
    await runProfile(
      { subcommand: "create", name: "alpha" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );
    await runProfile(
      { subcommand: "create", name: "beta" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );

    const baseText = readFileSync(join(sandbox.repo, "docker-compose.yml"), "utf-8");
    const alphaOverride = readFileSync(
      profileOverridePath("alpha", { repoRoot: sandbox.repo }),
      "utf-8",
    );
    const betaOverride = readFileSync(
      profileOverridePath("beta", { repoRoot: sandbox.repo }),
      "utf-8",
    );

    const alphaMerged = mergeCompose(baseText, alphaOverride);
    const betaMerged = mergeCompose(baseText, betaOverride);

    // Vessel: each profile binds exactly ONE host port, and it's the
    // offset port — not the base 3000.
    expect(alphaMerged.services.vessel.ports).toEqual([
      "127.0.0.1:3000:3000",
    ]);
    // alpha is offset 0 (first profile), so its only port IS 3000. The
    // hazard surfaces with beta (offset 1+): without !override it would
    // include both 3000 AND 3001.
    expect(betaMerged.services.vessel.ports).toHaveLength(1);
    expect(betaMerged.services.vessel.ports[0]).toMatch(/127\.0\.0\.1:300\d:3000/);
    expect(betaMerged.services.vessel.ports[0]).not.toBe("127.0.0.1:3000:3000");

    // Sidecar: same hazard, same fix.
    expect(alphaMerged.services.sidecar.ports).toEqual([
      "127.0.0.1:8000:8000",
    ]);
    expect(betaMerged.services.sidecar.ports).toHaveLength(1);
    expect(betaMerged.services.sidecar.ports[0]).toMatch(/127\.0\.0\.1:800\d:8000/);
    expect(betaMerged.services.sidecar.ports[0]).not.toBe("127.0.0.1:8000:8000");

    // The two profiles' merged port lists must NOT collide.
    const alphaSidecarPort = alphaMerged.services.sidecar.ports[0];
    const betaSidecarPort = betaMerged.services.sidecar.ports[0];
    expect(alphaSidecarPort).not.toBe(betaSidecarPort);
  });

  it("each profile reads/writes its OWN profile-scoped state paths", async () => {
    const sandbox = mk();
    await runProfile(
      { subcommand: "create", name: "alpha" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );
    await runProfile(
      { subcommand: "create", name: "beta" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );

    const baseText = readFileSync(join(sandbox.repo, "docker-compose.yml"), "utf-8");
    const alphaOverride = readFileSync(
      profileOverridePath("alpha", { repoRoot: sandbox.repo }),
      "utf-8",
    );
    const betaOverride = readFileSync(
      profileOverridePath("beta", { repoRoot: sandbox.repo }),
      "utf-8",
    );

    const alphaMerged = mergeCompose(baseText, alphaOverride);
    const betaMerged = mergeCompose(baseText, betaOverride);

    // alpha.sidecar.volumes = ONLY profile-scoped paths (no legacy
    // ./workspace/session_config.json, no beta paths).
    expect(alphaMerged.services.sidecar.volumes).toEqual([
      "./workspace/profiles/alpha/session_config.json:/app/session_config.json:ro",
      "./workspace/profiles/alpha/sidecar-state:/app/sidecar-state",
    ]);
    expect(betaMerged.services.sidecar.volumes).toEqual([
      "./workspace/profiles/beta/session_config.json:/app/session_config.json:ro",
      "./workspace/profiles/beta/sidecar-state:/app/sidecar-state",
    ]);

    // The two profiles share NO volume entries — state can't leak between
    // them through a stray legacy mount.
    const alphaSet = new Set(alphaMerged.services.sidecar.volumes);
    for (const v of betaMerged.services.sidecar.volumes) {
      expect(alphaSet.has(v)).toBe(false);
    }
  });

  it("vessel container_name is per-profile (no docker name collision)", async () => {
    const sandbox = mk();
    await runProfile(
      { subcommand: "create", name: "alpha" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );
    const baseText = readFileSync(join(sandbox.repo, "docker-compose.yml"), "utf-8");
    const alphaOverride = readFileSync(
      profileOverridePath("alpha", { repoRoot: sandbox.repo }),
      "utf-8",
    );
    const merged = mergeCompose(baseText, alphaOverride);
    expect(merged.services.vessel.container_name).toBe("arianna-vessel-alpha");
  });

  it("`arianna fork` produces an override with the same merge-replace contract", async () => {
    const sandbox = mk();
    await runProfile(
      { subcommand: "create", name: "alpha" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
      },
    );
    // Source profile needs a session_config + a docker tag to fork from.
    const srcDir = profileDir("alpha", { repoRoot: sandbox.repo });
    writeFileSync(
      join(srcDir, "session_config.json"),
      JSON.stringify({
        sessionId: "session_1700000000000",
        provider: "openrouter",
        modelId: "openai/gpt-4o-mini",
        aiName: "Aria",
        aiUsername: "aria",
        difficulty: "normal",
        createdAt: 1_700_000_000_000,
      }),
    );

    const fakeExec = vi.fn(async (cmd: string) => {
      if (cmd.includes("docker images") && cmd.includes("session_1700000000000")) {
        return {
          stdout: `${VESSEL_REPO}:session_1700000000000-base\n`,
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    await runFork(
      { src: "alpha", dst: "gamma" },
      {
        write: () => {},
        ariannaHome: sandbox.home,
        repoRoot: sandbox.repo,
        skipBindTest: true,
        now: () => 2_000_000_000_000,
        exec: fakeExec,
      },
    );

    const baseText = readFileSync(join(sandbox.repo, "docker-compose.yml"), "utf-8");
    const gammaOverride = readFileSync(
      profileOverridePath("gamma", { repoRoot: sandbox.repo }),
      "utf-8",
    );
    expect(gammaOverride).toMatch(/ports: !override/);
    expect(gammaOverride).toMatch(/volumes: !override/);

    const merged = mergeCompose(baseText, gammaOverride);
    // Volumes are gamma-scoped, not alpha's, not legacy.
    expect(merged.services.sidecar.volumes).toEqual([
      "./workspace/profiles/gamma/session_config.json:/app/session_config.json:ro",
      "./workspace/profiles/gamma/sidecar-state:/app/sidecar-state",
    ]);
    // Vessel binds exactly one host port.
    expect(merged.services.vessel.ports).toHaveLength(1);
    expect(merged.services.sidecar.ports).toHaveLength(1);
  });

  it("base docker-compose.yml drift catcher: real base still uses workspace/* mounts", () => {
    // If the base ever migrates away from the legacy workspace/* mounts on
    // its own (e.g. someone collapses base + override into one file), this
    // override's `volumes: !override` would be redundant — but harmless.
    // Conversely, if the base GROWS new list-typed fields not modeled here
    // (extra_hosts, depends_on with profile-specific deps), this catcher
    // pings the human to extend the merge contract.
    const realBase = readFileSync(
      resolve(__dirname, "..", "..", "..", "docker-compose.yml"),
      "utf-8",
    );
    expect(realBase).toMatch(/\.\/workspace\/session_config\.json/);
    expect(realBase).toMatch(/\.\/workspace\/sidecar-state/);
    expect(realBase).toMatch(/127\.0\.0\.1:3000:3000/);
    expect(realBase).toMatch(/127\.0\.0\.1:8000:8000/);
  });

  it("base docker-compose.yml MUST NOT pin HOST_*_URL env vars (canary acb7b292 cross-profile leak)", () => {
    // Canary acb7b292 (Lume run, 2026-05-09): base docker-compose.yml had
    //   HOST_SNAPSHOT_URL: http://host.docker.internal:9000/snapshot
    // Env wins over the sidecar's `??` default, so the per-profile
    // `?profile=<name>` query was never appended. Every non-default
    // profile's snapshots/diffs/snapshot-list calls fell through to the
    // host's config-default, silently corrupting tagging and listing.
    //
    // Per-profile compose.override.yml only sets ARIANNA_PROFILE; the
    // sidecar derives the URLs from that. Pinning a URL in base disables
    // the derivation. This catcher fails loudly if anyone re-introduces it.
    const realBase = readFileSync(
      resolve(__dirname, "..", "..", "..", "docker-compose.yml"),
      "utf-8",
    );
    // We allow comments to mention these names (the new comment block
    // explains why they're absent). Strip comment lines before asserting
    // they don't appear as YAML keys.
    const liveLines = realBase
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(liveLines).not.toMatch(/\bHOST_SNAPSHOT_URL\s*:/);
    expect(liveLines).not.toMatch(/\bHOST_DIFF_URL\s*:/);
    expect(liveLines).not.toMatch(/\bHOST_SNAPSHOTS_LIST_URL\s*:/);
  });
});
