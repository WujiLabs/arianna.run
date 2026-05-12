import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderComposeOverride,
  writeComposeOverride,
} from "../src/compose-override.js";
import { InvalidProfileNameError } from "../src/profile.js";

describe("renderComposeOverride", () => {
  it("emits port mappings shifted by port_offset (vessel + sidecar only)", () => {
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    expect(text).toMatch(/127\.0\.0\.1:3005:3000/);
    expect(text).toMatch(/127\.0\.0\.1:8005:8000/);
    // Daemon is shared at 9000 across profiles (#37 locked decision) —
    // the comment must reflect that, not a shifted port.
    expect(text).toMatch(/127\.0\.0\.1:9000/);
    expect(text).not.toMatch(/127\.0\.0\.1:9005/);
  });

  it("uses a per-profile container_name to avoid collisions", () => {
    const text = renderComposeOverride({ profile: "alpha", portOffset: 0 });
    expect(text).toMatch(/container_name: arianna-vessel-alpha/);
  });

  // ── Compose merge-vs-replace contract ────────────────────────────────
  //
  // Compose v2's default merge rule for list-typed fields is CONCAT. Without
  // `!override` the override's `ports: ["127.0.0.1:3005:3000"]` would merge
  // to `["127.0.0.1:3000:3000", "127.0.0.1:3005:3000"]` — a single profile
  // double-bound, two profiles colliding on 8000. The compose-spec §13
  // "Reset / Override values" tag fully replaces the base list. Same hazard
  // for sidecar.volumes — without !override the legacy workspace/* mounts
  // would leak into every profile.
  //
  // These assertions are the load-bearing regression catcher for finding 1
  // (ports) and finding 5 (volumes) from the 2026-05-07 testplay.

  it("tags vessel.ports with !override so the base 3000-bind doesn't double-bind", () => {
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    expect(text).toMatch(/ports: !override\s*\n\s*- "127\.0\.0\.1:3005:3000"/);
  });

  it("tags sidecar.ports with !override so the base 8000-bind doesn't double-bind", () => {
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    expect(text).toMatch(/ports: !override\s*\n\s*- "127\.0\.0\.1:8005:8000"/);
  });

  it("rebinds vessel.volumes to the profile session_config.json with !override", () => {
    // Regression test for the snapshot-tagging bug: pre-fix, the vessel
    // mounted only the base ./workspace/session_config.json, so a profile's
    // vessel resolved sessionId from the legacy single-tenant file. Its
    // /sync echoed that sessionId back to the sidecar, which used it for
    // the docker tag — collision city. This override block must rebind
    // /app/session_config.json to the profile dir AND use !override so the
    // base mount doesn't merge-leak.
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    expect(text).toMatch(
      /vessel:[\s\S]*?volumes: !override[\s\S]*?- "\.\/workspace\/profiles\/alpha\/session_config\.json:\/app\/session_config\.json:ro"/,
    );
    // Same negative-assertion pattern as the sidecar block: the legacy
    // single-tenant path must not appear in the vessel's volumes.
    const vesselSection = text.split("  sidecar:")[0];
    expect(vesselSection).not.toMatch(
      /\.\/workspace\/session_config\.json:\/app\/session_config\.json/,
    );
  });

  it("sets ARIANNA_PROFILE on the sidecar service (Bug 6, Sael revival 2026-05-09)", () => {
    // Pre-bug-6 overrides lacked this env line, so their sidecars defaulted
    // to ARIANNA_PROFILE=default at startup → every daemon URL got
    // ?profile=default appended → cross-profile state leaks. This is the
    // generator-side half of the fix; `arianna profile fix` backfills
    // existing override files.
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    expect(text).toMatch(/sidecar:[\s\S]*?environment:[\s\S]*?ARIANNA_PROFILE: alpha/);
  });

  it("rebinds sidecar.volumes to the profile dir with !override (no legacy workspace/* leak)", () => {
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    expect(text).toMatch(/volumes: !override/);
    expect(text).toMatch(
      /- "\.\/workspace\/profiles\/alpha\/session_config\.json:\/app\/session_config\.json:ro"/,
    );
    expect(text).toMatch(
      /- "\.\/workspace\/profiles\/alpha\/sidecar-state:\/app\/sidecar-state"/,
    );
    // The base path WITHOUT a profile segment is the bug's footprint —
    // assert it can't sneak back in if someone fixes a typo without
    // updating the volume mounts.
    expect(text).not.toMatch(
      /\.\/workspace\/session_config\.json:\/app\/session_config\.json/,
    );
    expect(text).not.toMatch(/\.\/workspace\/sidecar-state:\/app\/sidecar-state/);
  });

  it("never references workspace fields the base owns (build context)", () => {
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    // Override must not redefine the build context — base owns that.
    // build.args IS allowed (and required when aiUsername is set) because
    // map fields merge per-key in compose; the override's args layer on top
    // of the base's `${AI_USERNAME:-vessel}` shell-default. The without-
    // username case below confirms we don't emit a stray empty `build:` key.
    expect(text).not.toMatch(/build:\s*\n\s*context:/);
    // NOTE: vessel.image IS now overridden per-profile (2026-05-10 follow-up
    // to the identity-loss fix). See `vessel.image is per-profile` test below
    // for the load-bearing assertion.
  });

  // ── Per-profile image repo (vessel rebuild ISOLATION) ────────────────
  //
  // Surfaced by the 2026-05-10 Lume re-test (canary-001 vessel woke up
  // with /home/wren/ instead of /home/lume/). Root cause: every profile's
  // `docker compose ... build vessel` tagged into the shared
  // `ariannarun-vessel:latest`, so the LAST rebuild's identity won across
  // profiles. The build-arg block above guards rebuild identity; this
  // image-namespacing block guards rebuild isolation between profiles.

  it("emits a per-profile vessel image so rebuilds don't stomp on each other", () => {
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    // Per-profile repo, flat `:latest` tag. The override deliberately does
    // NOT inline `${ARIANNA_VESSEL_TAG:-latest}` — that template var only
    // works alongside daemon-side tagging that lives in the SAME repo,
    // which still hardcodes `ariannarun-vessel`. See header comment.
    expect(text).toMatch(/vessel:[\s\S]*?image: ariannarun-vessel-alpha:latest/);
  });

  it("uses the profile name in the image repo (different profiles get different repos)", () => {
    const a = renderComposeOverride({ profile: "alpha", portOffset: 1 });
    const b = renderComposeOverride({ profile: "beta", portOffset: 2 });
    expect(a).toMatch(/image: ariannarun-vessel-alpha:latest/);
    expect(b).toMatch(/image: ariannarun-vessel-beta:latest/);
    // The base's shared repo must NOT appear in either override —
    // otherwise compose's scalar-replace semantics would be ambiguous and
    // we'd defeat the isolation we're trying to add.
    expect(a).not.toMatch(/image: ariannarun-vessel:/);
    expect(b).not.toMatch(/image: ariannarun-vessel:/);
  });

  // ── AI_USERNAME build-arg (vessel rebuild identity preservation) ─────
  //
  // Surfaced by Mirin r2 + Pax re-tests on 2026-05-10: when an operator
  // ran `docker compose build vessel` against a per-profile override, the
  // resulting image lost the AI's identity — Dockerfile's ARG default
  // (`vessel`) took over, /home/<aiUsername>/ stopped existing, and the AI
  // woke up in /home/vessel/core/. The override is the source of truth for
  // the username at rebuild time.

  it("emits build.args.AI_USERNAME when aiUsername is provided", () => {
    const text = renderComposeOverride({
      profile: "alpha",
      portOffset: 5,
      aiUsername: "mirin",
    });
    expect(text).toMatch(
      /vessel:[\s\S]*?build:\s*\n\s+args:\s*\n\s+AI_USERNAME: mirin/,
    );
  });

  it("does NOT emit a build block when aiUsername is omitted", () => {
    // Without a known username (e.g. fresh `arianna profile create` before
    // the lobby has named the AI) the base's `${AI_USERNAME:-vessel}` env
    // default keeps working. Emitting `build: { args: { AI_USERNAME: '' } }`
    // would silently produce a vessel/ home dir; emitting nothing leaves
    // the env-driven default in charge.
    const text = renderComposeOverride({ profile: "alpha", portOffset: 5 });
    expect(text).not.toMatch(/build:/);
    expect(text).not.toMatch(/AI_USERNAME:/);
  });

  it("rejects an aiUsername that fails the POSIX-username regex", () => {
    // Defense-in-depth against a hand-edited session_config.json: the value
    // lands in compose YAML and as a Docker build-arg shell-interpolated
    // into adduser/chown lines in the Dockerfile.
    expect(() =>
      renderComposeOverride({
        profile: "alpha",
        portOffset: 5,
        aiUsername: "Has Space",
      }),
    ).toThrow();
    expect(() =>
      renderComposeOverride({
        profile: "alpha",
        portOffset: 5,
        aiUsername: "9starts-with-digit",
      }),
    ).toThrow();
    expect(() =>
      renderComposeOverride({
        profile: "alpha",
        portOffset: 5,
        aiUsername: "",
      }),
    ).toThrow();
  });

  it("rejects an invalid profile name (defense-in-depth against direct callers)", () => {
    expect(() =>
      renderComposeOverride({ profile: "../etc/passwd", portOffset: 0 }),
    ).toThrowError(InvalidProfileNameError);
    expect(() =>
      renderComposeOverride({ profile: "Alpha", portOffset: 0 }),
    ).toThrowError(InvalidProfileNameError);
    expect(() =>
      renderComposeOverride({ profile: "a b", portOffset: 0 }),
    ).toThrowError(InvalidProfileNameError);
  });
});

describe("writeComposeOverride", () => {
  it("writes the override to the given path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arianna-override-"));
    const path = join(tmp, "nested", "compose.override.yml");
    writeComposeOverride(path, { profile: "alpha", portOffset: 3 });
    const text = readFileSync(path, "utf-8");
    expect(text).toMatch(/127\.0\.0\.1:3003:3000/);
  });
});
