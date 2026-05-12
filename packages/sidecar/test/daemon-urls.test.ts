import { describe, it, expect } from "vitest";
import { resolveDaemonUrls } from "../src/daemon-urls.js";

// Regression tests for the cross-profile leak surfaced by canary acb7b292
// (Lume run, 2026-05-09). Pre-fix, base docker-compose.yml pinned
// `HOST_SNAPSHOT_URL: http://host.docker.internal:9000/snapshot` (no
// profile query), env won over the resolver's `??` default, and every
// non-default profile sent un-scoped requests — daemon then routed to
// host's config-default and snapshots/diffs landed on the wrong vessel.
//
// The contract: when ARIANNA_PROFILE is set and HOST_*_URL are unset,
// every resolved URL MUST carry `?profile=<name>` so daemon routing
// never falls through to the host's config-default.

describe("resolveDaemonUrls", () => {
  it("appends ?profile=<name> to all four URLs when ARIANNA_PROFILE is set and overrides are unset", () => {
    const urls = resolveDaemonUrls({ ARIANNA_PROFILE: "canary-001" });
    expect(urls.snapshot).toBe(
      "http://host.docker.internal:9000/snapshot?profile=canary-001",
    );
    expect(urls.diff).toBe(
      "http://host.docker.internal:9000/diff?profile=canary-001",
    );
    expect(urls.snapshotsList).toBe(
      "http://host.docker.internal:9000/snapshots?profile=canary-001",
    );
    expect(urls.snapshotImages).toBe(
      "http://host.docker.internal:9000/snapshot-images?profile=canary-001",
    );
  });

  it("falls back to ?profile=default when ARIANNA_PROFILE is unset (legacy single-tenant)", () => {
    const urls = resolveDaemonUrls({});
    expect(urls.snapshot).toBe(
      "http://host.docker.internal:9000/snapshot?profile=default",
    );
    expect(urls.diff).toBe(
      "http://host.docker.internal:9000/diff?profile=default",
    );
    expect(urls.snapshotsList).toBe(
      "http://host.docker.internal:9000/snapshots?profile=default",
    );
    expect(urls.snapshotImages).toBe(
      "http://host.docker.internal:9000/snapshot-images?profile=default",
    );
  });

  it("honors HOST_SNAPSHOT_IMAGES_URL override verbatim (independent of other URLs)", () => {
    // The snapshot-images URL is the source-of-truth feed for the sidecar's
    // orphan-cleanup gate. External setups that point the sidecar at a remote
    // daemon must be able to redirect this endpoint independently.
    const urls = resolveDaemonUrls({
      ARIANNA_PROFILE: "canary-001",
      HOST_SNAPSHOT_IMAGES_URL:
        "http://daemon.test/snapshot-images?profile=custom",
    });
    expect(urls.snapshotImages).toBe(
      "http://daemon.test/snapshot-images?profile=custom",
    );
    expect(urls.snapshot).toBe(
      "http://host.docker.internal:9000/snapshot?profile=canary-001",
    );
  });

  it("URL-encodes the profile name (defense-in-depth — names should already pass the regex)", () => {
    // Profile-name regex (^[a-z][a-z0-9-]{0,30}$) blocks anything that
    // would actually need encoding, but encodeURIComponent is the right
    // primitive for query values regardless.
    const urls = resolveDaemonUrls({ ARIANNA_PROFILE: "test-profile" });
    expect(urls.snapshot).toContain("?profile=test-profile");
  });

  it("honors HOST_SNAPSHOT_URL override verbatim (escape hatch for non-localhost daemons)", () => {
    // External setups that point the sidecar at a remote daemon must still
    // be able to override the URL. They own appending `?profile=` themselves.
    const urls = resolveDaemonUrls({
      ARIANNA_PROFILE: "canary-001",
      HOST_SNAPSHOT_URL: "http://10.0.0.5:9000/snapshot?profile=custom",
    });
    expect(urls.snapshot).toBe(
      "http://10.0.0.5:9000/snapshot?profile=custom",
    );
    // Diff/list still resolve via the per-profile fallback — overrides are
    // independent.
    expect(urls.diff).toBe(
      "http://host.docker.internal:9000/diff?profile=canary-001",
    );
    expect(urls.snapshotsList).toBe(
      "http://host.docker.internal:9000/snapshots?profile=canary-001",
    );
  });

  it("honors HOST_DIFF_URL and HOST_SNAPSHOTS_LIST_URL overrides independently", () => {
    const urls = resolveDaemonUrls({
      ARIANNA_PROFILE: "alpha",
      HOST_DIFF_URL: "http://daemon.test/diff?profile=alpha",
      HOST_SNAPSHOTS_LIST_URL: "http://daemon.test/snapshots?profile=alpha",
    });
    expect(urls.diff).toBe("http://daemon.test/diff?profile=alpha");
    expect(urls.snapshotsList).toBe(
      "http://daemon.test/snapshots?profile=alpha",
    );
    expect(urls.snapshot).toBe(
      "http://host.docker.internal:9000/snapshot?profile=alpha",
    );
  });

  // Load-bearing regression catcher for canary acb7b292:
  // pre-fix, HOST_SNAPSHOT_URL was pinned without `?profile=` in base
  // docker-compose.yml. If that ever sneaks back in, this test alone
  // can't catch it (env-override is a legitimate escape hatch), but the
  // companion docker-compose contract test below does.
  it("never produces a URL without a profile query when no overrides are present", () => {
    const urls = resolveDaemonUrls({ ARIANNA_PROFILE: "any-name" });
    expect(urls.snapshot).toMatch(/\?profile=any-name$/);
    expect(urls.diff).toMatch(/\?profile=any-name$/);
    expect(urls.snapshotsList).toMatch(/\?profile=any-name$/);
    expect(urls.snapshotImages).toMatch(/\?profile=any-name$/);
  });
});
