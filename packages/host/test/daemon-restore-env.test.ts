import { describe, it, expect } from "vitest";
import type { SessionConfig } from "@arianna.run/types";

import {
  assertContainerSessionId,
  buildRestoreEnv,
  extractContainerEnv,
  findFallbackImageTag,
  parseSnapshotImageTags,
  vesselRepoForProfile,
  vesselTagFor,
} from "../src/daemon-restore-env.js";

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function fixtureConfig(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    externalLlmApiKey: "sk-test-12345",
    provider: "openrouter",
    modelId: "openai/gpt-4o-mini",
    aiName: "TestVessel",
    aiUsername: "testvessel",
    difficulty: "normal",
    createdAt: 1714000000,
    sessionId: "session_1714000000",
    ...over,
  };
}

describe("buildRestoreEnv", () => {
  it("propagates every session identity field compose needs", () => {
    const env = buildRestoreEnv(
      {},
      fixtureConfig(),
      "session_1714000000-current",
    );
    expect(env.ARIANNA_SESSION_ID).toBe("session_1714000000");
    expect(env.ARIANNA_VESSEL_TAG).toBe("session_1714000000-current");
    expect(env.AI_NAME).toBe("TestVessel");
    expect(env.AI_USERNAME).toBe("testvessel");
    expect(env.MODEL_ID).toBe("openai/gpt-4o-mini");
    expect(env.PROVIDER).toBe("openrouter");
    expect(env.API_KEY).toBe("sk-test-12345");
  });

  it("preserves base env keys that aren't overridden", () => {
    const base = { PATH: "/usr/bin", HOME: "/root", DEBUG: "1" };
    const env = buildRestoreEnv(base, fixtureConfig(), "session_42-current");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/root");
    expect(env.DEBUG).toBe("1");
  });

  it("session config wins when keys collide with the base env", () => {
    // Operator-set ARIANNA_SESSION_ID in shell at daemon-fork time MUST NOT
    // shadow the snapshot's own sessionId — that's the entire bug we're fixing.
    const base = {
      ARIANNA_SESSION_ID: "stale_from_shell",
      AI_NAME: "stale",
      API_KEY: "stale",
      ARIANNA_VESSEL_TAG: "stale",
    };
    const env = buildRestoreEnv(base, fixtureConfig(), "session_42-current");
    expect(env.ARIANNA_SESSION_ID).toBe("session_1714000000");
    expect(env.AI_NAME).toBe("TestVessel");
    expect(env.API_KEY).toBe("sk-test-12345");
    expect(env.ARIANNA_VESSEL_TAG).toBe("session_42-current");
  });

  it("returns a fresh object — does not mutate the base env", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const env = buildRestoreEnv(base, fixtureConfig(), "tag-current");
    env.ARIANNA_SESSION_ID = "tampered";
    expect(base.ARIANNA_SESSION_ID).toBeUndefined();
    expect(base.PATH).toBe("/usr/bin");
  });

  it("passes API keys with shell metacharacters through unchanged", () => {
    // Env values flow through child_process.exec's `env` option, which sets
    // them via the spawn API directly — no shell evaluation. Even keys
    // containing ;`$()&| should pass through verbatim. (The compose command
    // string itself is constructed only from validated paths.)
    const cfg = fixtureConfig({
      externalLlmApiKey: "sk-with-$(rm -rf /)`evil`;DROP TABLE",
    });
    const env = buildRestoreEnv({}, cfg, "tag-current");
    expect(env.API_KEY).toBe("sk-with-$(rm -rf /)`evil`;DROP TABLE");
  });
});

describe("extractContainerEnv", () => {
  it("returns the value when the key is present", () => {
    const list = ["PATH=/usr/bin", "ARIANNA_SESSION_ID=session_42", "AI_NAME=Foo"];
    expect(extractContainerEnv(list, "ARIANNA_SESSION_ID")).toBe("session_42");
  });

  it("returns null when the key is missing", () => {
    expect(extractContainerEnv(["PATH=/usr/bin"], "ARIANNA_SESSION_ID")).toBe(null);
  });

  it("handles undefined env list", () => {
    expect(extractContainerEnv(undefined, "ARIANNA_SESSION_ID")).toBe(null);
  });

  it("handles empty values like KEY=", () => {
    expect(extractContainerEnv(["EMPTY="], "EMPTY")).toBe("");
  });

  it("preserves '=' characters within the value", () => {
    expect(extractContainerEnv(["TOKEN=abc=def=ghi"], "TOKEN")).toBe("abc=def=ghi");
  });
});

describe("assertContainerSessionId", () => {
  it("returns silently on match", () => {
    expect(() =>
      assertContainerSessionId(
        ["PATH=/usr/bin", "ARIANNA_SESSION_ID=session_42"],
        "session_42",
      ),
    ).not.toThrow();
  });

  it("throws with the actual + expected on mismatch", () => {
    expect(() =>
      assertContainerSessionId(
        ["ARIANNA_SESSION_ID=default"],
        "session_42",
      ),
    ).toThrowError(/expected session_42/);
    expect(() =>
      assertContainerSessionId(
        ["ARIANNA_SESSION_ID=default"],
        "session_42",
      ),
    ).toThrowError(/ARIANNA_SESSION_ID=default/);
  });

  it("throws with <missing> when the env var is absent", () => {
    expect(() =>
      assertContainerSessionId(["PATH=/usr/bin"], "session_42"),
    ).toThrowError(/<missing>/);
  });

  it("throws on undefined env list", () => {
    expect(() =>
      assertContainerSessionId(undefined, "session_42"),
    ).toThrowError(/expected session_42/);
  });
});

describe("findFallbackImageTag (backwards-compat for default-* legacy snapshots)", () => {
  // Snapshots taken before the resolveSessionId fix landed have meta files
  // pointing at images tagged with the wrong sessionId (typically "default")
  // because the buggy vessel echoed it via /sync. The fallback lets restore
  // bridge old → new without renaming images on disk.

  it("returns the meta dockerImage when it points inside the vessel repo", () => {
    const meta = JSON.stringify({
      id: "snap_42",
      dockerImage: "ariannarun-vessel:default-snap_42",
      sessionId: "session_real",
    });
    expect(
      findFallbackImageTag({
        metaJson: meta,
        vesselRepo: "ariannarun-vessel",
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toBe("ariannarun-vessel:default-snap_42");
  });

  it("returns null for a missing meta file (caller passes null)", () => {
    expect(
      findFallbackImageTag({
        metaJson: null,
        vesselRepo: "ariannarun-vessel",
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(
      findFallbackImageTag({
        metaJson: "{not json",
        vesselRepo: "ariannarun-vessel",
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toBeNull();
  });

  it("returns null when dockerImage is missing or non-string", () => {
    expect(
      findFallbackImageTag({
        metaJson: JSON.stringify({ id: "snap_42" }),
        vesselRepo: "ariannarun-vessel",
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toBeNull();
    expect(
      findFallbackImageTag({
        metaJson: JSON.stringify({ dockerImage: 42 }),
        vesselRepo: "ariannarun-vessel",
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toBeNull();
  });

  it("rejects a meta dockerImage pointing at a different repo", () => {
    expect(
      findFallbackImageTag({
        metaJson: JSON.stringify({ dockerImage: "evil/repo:default-snap_42" }),
        vesselRepo: "ariannarun-vessel",
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toBeNull();
  });

  it("rejects a tag with shell metacharacters (defense against corrupted meta)", () => {
    expect(
      findFallbackImageTag({
        metaJson: JSON.stringify({
          dockerImage: "ariannarun-vessel:default-snap_42; rm -rf /",
        }),
        vesselRepo: "ariannarun-vessel",
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toBeNull();
    expect(
      findFallbackImageTag({
        metaJson: JSON.stringify({
          dockerImage: "ariannarun-vessel:../etc/passwd",
        }),
        vesselRepo: "ariannarun-vessel",
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toBeNull();
  });

  // Per-profile namespacing complement (2026-05-10, follow-up to 18ba363).
  // The daemon's restore flow now mints into `ariannarun-vessel-{profile}:`
  // for non-legacy profiles, but legacy global-namespace snapshots
  // (`ariannarun-vessel:{sid}-{slot}`) on disk must still restore. The
  // fallback helper accepts a list of repo candidates so the daemon can
  // pass `[profileRepo, "ariannarun-vessel"]` and have either prefix match.
  describe("per-profile namespacing — multi-repo candidate list", () => {
    it("accepts a tag in the per-profile repo when listed first", () => {
      const meta = JSON.stringify({
        id: "snap_42",
        dockerImage: "ariannarun-vessel-foo:session_1-snap_42",
      });
      expect(
        findFallbackImageTag({
          metaJson: meta,
          vesselRepo: ["ariannarun-vessel-foo", "ariannarun-vessel"],
          safeIdRegex: SAFE_ID_RE,
        }),
      ).toBe("ariannarun-vessel-foo:session_1-snap_42");
    });

    it("accepts a legacy global-namespace tag when the per-profile repo doesn't match", () => {
      const meta = JSON.stringify({
        id: "snap_42",
        dockerImage: "ariannarun-vessel:session_1-snap_42",
      });
      expect(
        findFallbackImageTag({
          metaJson: meta,
          vesselRepo: ["ariannarun-vessel-foo", "ariannarun-vessel"],
          safeIdRegex: SAFE_ID_RE,
        }),
      ).toBe("ariannarun-vessel:session_1-snap_42");
    });

    it("rejects a tag in a profile repo not on the candidate list", () => {
      const meta = JSON.stringify({
        dockerImage: "ariannarun-vessel-other:session_1-snap_42",
      });
      expect(
        findFallbackImageTag({
          metaJson: meta,
          vesselRepo: ["ariannarun-vessel-foo", "ariannarun-vessel"],
          safeIdRegex: SAFE_ID_RE,
        }),
      ).toBeNull();
    });

    it("still rejects shell metacharacters when matching against a candidate list", () => {
      const meta = JSON.stringify({
        dockerImage: "ariannarun-vessel-foo:session_1-snap_42; rm -rf /",
      });
      expect(
        findFallbackImageTag({
          metaJson: meta,
          vesselRepo: ["ariannarun-vessel-foo", "ariannarun-vessel"],
          safeIdRegex: SAFE_ID_RE,
        }),
      ).toBeNull();
    });

    it("single-repo string form still works (back-compat with original signature)", () => {
      const meta = JSON.stringify({
        dockerImage: "ariannarun-vessel:session_1-snap_42",
      });
      expect(
        findFallbackImageTag({
          metaJson: meta,
          vesselRepo: "ariannarun-vessel",
          safeIdRegex: SAFE_ID_RE,
        }),
      ).toBe("ariannarun-vessel:session_1-snap_42");
    });
  });
});

describe("vesselRepoForProfile (per-profile namespacing)", () => {
  it("returns the legacy global repo for legacy contexts", () => {
    expect(
      vesselRepoForProfile({ isLegacy: true, name: "default" }),
    ).toBe("ariannarun-vessel");
  });

  it("returns ariannarun-vessel-{name} for non-legacy profiles", () => {
    expect(
      vesselRepoForProfile({ isLegacy: false, name: "alpha" }),
    ).toBe("ariannarun-vessel-alpha");
    expect(
      vesselRepoForProfile({ isLegacy: false, name: "canary-001" }),
    ).toBe("ariannarun-vessel-canary-001");
  });

  it("name is ignored when isLegacy=true (defensive — legacy ctx may carry name='default')", () => {
    expect(
      vesselRepoForProfile({ isLegacy: true, name: "anything" }),
    ).toBe("ariannarun-vessel");
  });

  it("legacyRepo override threads through (test seam)", () => {
    expect(
      vesselRepoForProfile({ isLegacy: false, name: "alpha", legacyRepo: "custom" }),
    ).toBe("custom-alpha");
  });
});

describe("vesselTagFor", () => {
  it("formats {repo}:{sessionId}-{slot}", () => {
    expect(vesselTagFor("ariannarun-vessel", "session_1", "current")).toBe(
      "ariannarun-vessel:session_1-current",
    );
    expect(
      vesselTagFor("ariannarun-vessel-alpha", "session_42", "snap_99"),
    ).toBe("ariannarun-vessel-alpha:session_42-snap_99");
  });

  it("composes cleanly with vesselRepoForProfile for the per-profile case", () => {
    // The daemon's actual call site: vesselTagFor(vesselRepoForProfile(ctx), ...)
    // This test pins the contract end-to-end.
    const repo = vesselRepoForProfile({ isLegacy: false, name: "foo" });
    expect(vesselTagFor(repo, "session_1", "base")).toBe(
      "ariannarun-vessel-foo:session_1-base",
    );
  });
});

// =============================================================================
// parseSnapshotImageTags — the docker-image-source-of-truth view that powers
// GET /snapshot-images and feeds the sidecar's orphan-cleanup gate.
// =============================================================================

describe("parseSnapshotImageTags", () => {
  it("parses session-scoped snap_TIMESTAMP tags from the per-profile repo", () => {
    const records = parseSnapshotImageTags({
      tags: [
        "ariannarun-vessel-canary:session_1778437900722-snap_1778438029521",
        "ariannarun-vessel-canary:session_1778437900722-snap_1778455594975",
      ],
      vesselRepo: ["ariannarun-vessel-canary", "ariannarun-vessel"],
      safeIdRegex: SAFE_ID_RE,
    });
    expect(records.map((r) => r.snapshotId).sort()).toEqual([
      "snap_1778438029521",
      "snap_1778455594975",
    ]);
    expect(records.every((r) => r.sessionId === "session_1778437900722")).toBe(
      true,
    );
    expect(records.every((r) => r.repo === "ariannarun-vessel-canary")).toBe(
      true,
    );
  });

  it("recovers snap_overlay_TIMESTAMP tags (the canary-fresh-1 case)", () => {
    // This is the regression the snapshot-pairing-loss fix turns on. Before
    // /snapshot-images existed, the sidecar's cleanup queried /snapshots
    // which scanned meta JSON files — snap_overlay_* mints skipped the meta
    // write, so their pairings got classified as orphans and deleted on
    // next sidecar startup. docker-image enumeration recovers them.
    const records = parseSnapshotImageTags({
      tags: [
        "ariannarun-vessel-canary-fresh-1:session_1778437900722-snap_overlay_1778513013916",
        "ariannarun-vessel-canary-fresh-1:session_1778437900722-snap_overlay_1778441033758",
      ],
      vesselRepo: ["ariannarun-vessel-canary-fresh-1", "ariannarun-vessel"],
      safeIdRegex: SAFE_ID_RE,
    });
    expect(records.map((r) => r.snapshotId).sort()).toEqual([
      "snap_overlay_1778441033758",
      "snap_overlay_1778513013916",
    ]);
  });

  it("captures operator-named rescue tags (snap_post_*, snap_pre_*)", () => {
    // Observed in canary-fresh-1: docker tags from a manual rescue commit
    // (`docker commit --change ... -m '#209 rescue'`). They start with
    // `snap_` so the filter keeps them.
    const records = parseSnapshotImageTags({
      tags: [
        "ariannarun-vessel-canary:session_1-snap_post_209_active_1778451313",
        "ariannarun-vessel-canary:session_1-snap_pre_209_fix_1778450035",
      ],
      vesselRepo: ["ariannarun-vessel-canary"],
      safeIdRegex: SAFE_ID_RE,
    });
    expect(records.map((r) => r.snapshotId).sort()).toEqual([
      "snap_post_209_active_1778451313",
      "snap_pre_209_fix_1778450035",
    ]);
  });

  it("ignores session-lifecycle slot tags (-base, -current)", () => {
    // -base and -current are pointers to per-session lifecycle states, not
    // restore targets. Including them would cause the sidecar to assume
    // pairings should exist for `base` / `current` and fail the cleanup gate.
    const records = parseSnapshotImageTags({
      tags: [
        "ariannarun-vessel-canary:session_1-base",
        "ariannarun-vessel-canary:session_1-current",
        "ariannarun-vessel-canary:session_1-snap_99",
      ],
      vesselRepo: ["ariannarun-vessel-canary"],
      safeIdRegex: SAFE_ID_RE,
    });
    expect(records.map((r) => r.snapshotId)).toEqual(["snap_99"]);
  });

  it("ignores the bare :latest pointer", () => {
    // `:latest` has no `-` after the colon so the indexOf('-') guard rejects
    // it. Also covers any other repo-level pointer the operator might tag.
    const records = parseSnapshotImageTags({
      tags: [
        "ariannarun-vessel-canary:latest",
        "ariannarun-vessel-canary:session_1-snap_42",
      ],
      vesselRepo: ["ariannarun-vessel-canary"],
      safeIdRegex: SAFE_ID_RE,
    });
    expect(records.map((r) => r.snapshotId)).toEqual(["snap_42"]);
  });

  it("rejects tags from other repos (foreign images, accidental name collisions)", () => {
    const records = parseSnapshotImageTags({
      tags: [
        "some-other-app:session_1-snap_99",
        "ariannarun-vessel-other:session_1-snap_42",
      ],
      vesselRepo: ["ariannarun-vessel-canary", "ariannarun-vessel"],
      safeIdRegex: SAFE_ID_RE,
    });
    expect(records).toEqual([]);
  });

  it("deduplicates when a snapshot is tagged in both per-profile and legacy repos", () => {
    // Per-profile namespacing complement: a snapshot taken before the
    // namespacing landed lives under `ariannarun-vessel:...`. After a fork
    // or manual retag, the same snapshotId may also live under the per-
    // profile repo. The dedup key is snapshotId; the preferred repo (first
    // entry in vesselRepo) wins so downstream consumers see the per-profile
    // tag.
    const records = parseSnapshotImageTags({
      tags: [
        "ariannarun-vessel-canary:session_1-snap_99",
        "ariannarun-vessel:session_1-snap_99",
      ],
      vesselRepo: ["ariannarun-vessel-canary", "ariannarun-vessel"],
      safeIdRegex: SAFE_ID_RE,
    });
    expect(records).toHaveLength(1);
    expect(records[0].snapshotId).toBe("snap_99");
    expect(records[0].repo).toBe("ariannarun-vessel-canary");
  });

  it("rejects tags whose sessionId fails the safe-id regex", () => {
    // Defense-in-depth: a corrupted tag with shell metachars (`;`, `$()`)
    // must not flow into the response, since downstream the snapshotId can
    // end up in a docker shell command for fix-pairings rescue work.
    const records = parseSnapshotImageTags({
      tags: [
        "ariannarun-vessel-canary:session_1;rm-snap_99",
        "ariannarun-vessel-canary:session_1-snap_99$()",
        "ariannarun-vessel-canary:session_1-snap_OK",
      ],
      vesselRepo: ["ariannarun-vessel-canary"],
      safeIdRegex: SAFE_ID_RE,
    });
    // Note: the `;` falls inside the sessionId split (before first `-`),
    // so the regex rejects it.
    expect(records.map((r) => r.snapshotId)).toEqual(["snap_OK"]);
  });

  it("handles empty input cleanly", () => {
    expect(
      parseSnapshotImageTags({
        tags: [],
        vesselRepo: ["ariannarun-vessel-canary"],
        safeIdRegex: SAFE_ID_RE,
      }),
    ).toEqual([]);
  });

  it("anchors the split on `-snap_` so dashes in sessionId don't mis-parse", () => {
    // SAFE_ID_RE allows `-` in both sessionId and snapshotId. Current mints
    // (`session_${Date.now()}`) don't include `-`, but a future scheme might.
    // The first-dash split would have set sessionId="session" and snapshotId
    // ="with-dashes-snap_99". The `-snap_` anchor keeps the full sessionId
    // intact.
    const records = parseSnapshotImageTags({
      tags: [
        "ariannarun-vessel-canary:session-with-dashes-snap_99",
      ],
      vesselRepo: ["ariannarun-vessel-canary"],
      safeIdRegex: SAFE_ID_RE,
    });
    expect(records).toHaveLength(1);
    expect(records[0].sessionId).toBe("session-with-dashes");
    expect(records[0].snapshotId).toBe("snap_99");
  });
});
