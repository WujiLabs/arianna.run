import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../src/config.js";
import { ariannaConfigPath } from "../src/paths.js";

function mk() {
  const home = mkdtempSync(join(tmpdir(), "arianna-cfg-home-"));
  const repo = mkdtempSync(join(tmpdir(), "arianna-cfg-repo-"));
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}");
  return { home, repo };
}

function seedConfig(home: string, body: string) {
  mkdirSync(home, { recursive: true });
  writeFileSync(ariannaConfigPath({ ariannaHome: home }), body);
}

// Inject a deterministic "docker is available" probe so tests don't depend on
// whether the host machine running vitest happens to have docker on PATH.
// See the container-aware host swap notes in src/config.ts.
const DOCKER_PRESENT = (): void => {
  /* no-op: success ⇒ isLocalDockerAvailable returns true ⇒ host stays 127.0.0.1 */
};
const DOCKER_MISSING = (): void => {
  throw new Error("docker not on PATH (test fake)");
};

describe("resolveConfig", () => {
  it("uses 3000/8000/9000 when no profile resolves and offset 0 fallback", () => {
    const { home } = mk();
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      allowImplicitDefault: false,
      dockerProbe: DOCKER_PRESENT,
    });
    expect(cfg.profile).toBe(null);
    expect(cfg.profileSource).toBe("none");
    expect(cfg.vesselBaseUrl).toBe("http://127.0.0.1:3000");
    expect(cfg.sidecarBaseUrl).toBe("http://127.0.0.1:8000");
    expect(cfg.daemonBaseUrl).toBe("http://127.0.0.1:9000");
  });

  it("shifts ports by the resolved profile's port_offset", () => {
    const { home } = mk();
    seedConfig(
      home,
      `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 5\n`,
    );
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      dockerProbe: DOCKER_PRESENT,
    });
    expect(cfg.profile).toBe("alpha");
    expect(cfg.profileSource).toBe("config-default");
    expect(cfg.portOffset).toBe(5);
    expect(cfg.vesselBaseUrl).toBe("http://127.0.0.1:3005");
    expect(cfg.sidecarBaseUrl).toBe("http://127.0.0.1:8005");
    // Daemon is shared at 9000 across all profiles (#37 locked decision).
    expect(cfg.daemonBaseUrl).toBe("http://127.0.0.1:9000");
  });

  it("falls back to offset 0 for an unknown profile (e.g. implicit-default before create)", () => {
    const { home, repo } = mk();
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      repoRoot: repo,
      dockerProbe: DOCKER_PRESENT,
    });
    expect(cfg.profile).toBe("default");
    expect(cfg.profileSource).toBe("implicit-default");
    expect(cfg.portOffset).toBe(0);
    expect(cfg.vesselBaseUrl).toBe("http://127.0.0.1:3000");
  });

  it("env URL overrides win over profile-derived URLs", () => {
    const { home } = mk();
    seedConfig(home, `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 7\n`);
    const cfg = resolveConfig({
      env: {
        VESSEL_BASE_URL: "http://10.0.0.1:1111",
        SIDECAR_BASE_URL: "http://10.0.0.1:2222",
        DAEMON_BASE_URL: "http://10.0.0.1:3333",
      },
      ariannaHome: home,
      dockerProbe: DOCKER_PRESENT,
    });
    expect(cfg.vesselBaseUrl).toBe("http://10.0.0.1:1111");
    expect(cfg.sidecarBaseUrl).toBe("http://10.0.0.1:2222");
    expect(cfg.daemonBaseUrl).toBe("http://10.0.0.1:3333");
  });

  it("flag wins over env wins over config", () => {
    const { home } = mk();
    seedConfig(home, `[default]\nprofile = gamma\n\n[profile gamma]\nport_offset = 3\n[profile beta]\nport_offset = 2\n[profile alpha]\nport_offset = 1\n`);
    const flag = resolveConfig({
      profile: "alpha",
      env: { ARIANNA_PROFILE: "beta" },
      ariannaHome: home,
      dockerProbe: DOCKER_PRESENT,
    });
    expect(flag.profile).toBe("alpha");
    expect(flag.portOffset).toBe(1);

    const env = resolveConfig({
      env: { ARIANNA_PROFILE: "beta" },
      ariannaHome: home,
      dockerProbe: DOCKER_PRESENT,
    });
    expect(env.profile).toBe("beta");
    expect(env.portOffset).toBe(2);
  });

  it("daemonBaseUrl is ALWAYS 9000 regardless of port_offset (#37 locked decision)", () => {
    const { home } = mk();
    seedConfig(
      home,
      `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 17\n`,
    );
    const cfg = resolveConfig({
      env: {},
      ariannaHome: home,
      dockerProbe: DOCKER_PRESENT,
    });
    // vessel + sidecar shift, daemon does not.
    expect(cfg.vesselBaseUrl).toBe("http://127.0.0.1:3017");
    expect(cfg.sidecarBaseUrl).toBe("http://127.0.0.1:8017");
    expect(cfg.daemonBaseUrl).toBe("http://127.0.0.1:9000");
  });

  describe("container-aware host swap (extends bc325ae /compose-up pattern)", () => {
    it("keeps 127.0.0.1 when docker probe succeeds (laptop / CI default)", () => {
      const { home } = mk();
      seedConfig(
        home,
        `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 11\n`,
      );
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        dockerProbe: DOCKER_PRESENT,
      });
      expect(cfg.vesselBaseUrl).toBe("http://127.0.0.1:3011");
      expect(cfg.sidecarBaseUrl).toBe("http://127.0.0.1:8011");
      // Daemon URL stays 127.0.0.1 — daemon-route fallback in compose-up.ts
      // owns its own host swap (bc325ae). See src/config.ts comment.
      expect(cfg.daemonBaseUrl).toBe("http://127.0.0.1:9000");
    });

    it("swaps to host.docker.internal when no local docker (openclaw container case)", () => {
      const { home } = mk();
      seedConfig(
        home,
        `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 11\n`,
      );
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        dockerProbe: DOCKER_MISSING,
      });
      expect(cfg.vesselBaseUrl).toBe("http://host.docker.internal:3011");
      expect(cfg.sidecarBaseUrl).toBe("http://host.docker.internal:8011");
      // Daemon URL is intentionally NOT swapped here — see config.ts.
      expect(cfg.daemonBaseUrl).toBe("http://127.0.0.1:9000");
    });

    it("env VESSEL_BASE_URL/SIDECAR_BASE_URL still win even when docker is missing", () => {
      const { home } = mk();
      seedConfig(
        home,
        `[default]\nprofile = alpha\n\n[profile alpha]\nport_offset = 11\n`,
      );
      const cfg = resolveConfig({
        env: {
          VESSEL_BASE_URL: "http://example.test:9999",
          SIDECAR_BASE_URL: "http://example.test:8888",
        },
        ariannaHome: home,
        dockerProbe: DOCKER_MISSING,
      });
      // Env wins — no host.docker.internal substitution despite docker-missing
      // probe result. Operators with weird bridge networking get full control.
      expect(cfg.vesselBaseUrl).toBe("http://example.test:9999");
      expect(cfg.sidecarBaseUrl).toBe("http://example.test:8888");
    });

    it("works for the no-profile / offset 0 case too (covers `arianna talk` early in onboarding)", () => {
      const { home } = mk();
      const cfg = resolveConfig({
        env: {},
        ariannaHome: home,
        allowImplicitDefault: false,
        dockerProbe: DOCKER_MISSING,
      });
      expect(cfg.vesselBaseUrl).toBe("http://host.docker.internal:3000");
      expect(cfg.sidecarBaseUrl).toBe("http://host.docker.internal:8000");
    });
  });
});
