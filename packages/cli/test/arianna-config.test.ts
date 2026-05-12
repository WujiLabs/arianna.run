import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseConfig,
  serializeConfig,
  loadConfig,
  saveConfig,
  type AriannaConfig,
} from "../src/arianna-config.js";

function mkSandbox() {
  return mkdtempSync(join(tmpdir(), "arianna-config-test-"));
}

describe("parseConfig", () => {
  it("parses default + profile sections", () => {
    const cfg = parseConfig(`
[default]
profile = alpha

[profile alpha]
port_offset = 0
created_at = 1714603200000

[profile beta]
port_offset = 7
`);
    expect(cfg.defaultProfile).toBe("alpha");
    expect(cfg.profiles.size).toBe(2);
    expect(cfg.profiles.get("alpha")).toEqual({
      portOffset: 0,
      createdAt: 1714603200000,
    });
    expect(cfg.profiles.get("beta")).toEqual({ portOffset: 7 });
  });

  it("ignores comments and unknown sections", () => {
    const cfg = parseConfig(`
# this is a comment
; this too

[bogus]
nope = 1

[profile alpha]
port_offset = 3
`);
    expect(cfg.defaultProfile).toBe(null);
    expect(cfg.profiles.get("alpha")).toEqual({ portOffset: 3 });
  });

  it("rejects invalid profile names by skipping their sections", () => {
    const cfg = parseConfig(`
[profile Bad-Name]
port_offset = 5

[profile good]
port_offset = 6
`);
    expect(cfg.profiles.has("Bad-Name")).toBe(false);
    expect(cfg.profiles.get("good")).toEqual({ portOffset: 6 });
  });

  it("clamps port_offset out of range", () => {
    const cfg = parseConfig(`
[profile alpha]
port_offset = 999
`);
    // The loader sets a default of 0 on creation; out-of-range values are
    // ignored, so we expect 0 (the default) rather than 999.
    expect(cfg.profiles.get("alpha")?.portOffset).toBe(0);
  });

  it("returns empty config for empty input", () => {
    const cfg = parseConfig("");
    expect(cfg.defaultProfile).toBe(null);
    expect(cfg.profiles.size).toBe(0);
  });
});

describe("serializeConfig", () => {
  it("roundtrips through parseConfig", () => {
    const original: AriannaConfig = {
      defaultProfile: "alpha",
      profiles: new Map([
        ["alpha", { portOffset: 0, createdAt: 1714603200000 }],
        ["beta", { portOffset: 7 }],
      ]),
    };
    const text = serializeConfig(original);
    const parsed = parseConfig(text);
    expect(parsed.defaultProfile).toBe("alpha");
    expect(parsed.profiles.get("alpha")).toEqual({
      portOffset: 0,
      createdAt: 1714603200000,
    });
    expect(parsed.profiles.get("beta")).toEqual({ portOffset: 7 });
  });

  it("emits the [default] section even when empty", () => {
    const text = serializeConfig({ defaultProfile: null, profiles: new Map() });
    expect(text).toMatch(/\[default\]/);
  });
});

describe("loadConfig + saveConfig", () => {
  it("returns empty config when file missing", () => {
    const home = mkSandbox();
    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.defaultProfile).toBe(null);
    expect(cfg.profiles.size).toBe(0);
  });

  it("creates the directory and writes atomically", () => {
    const home = mkSandbox();
    const cfg: AriannaConfig = {
      defaultProfile: "alpha",
      profiles: new Map([["alpha", { portOffset: 0 }]]),
    };
    saveConfig(cfg, { ariannaHome: home });
    const text = readFileSync(join(home, "config"), "utf-8");
    expect(text).toMatch(/profile = alpha/);
    expect(text).toMatch(/\[profile alpha\]/);
  });

  it("overwrites cleanly on repeated saves", () => {
    const home = mkSandbox();
    saveConfig(
      { defaultProfile: "a", profiles: new Map([["a", { portOffset: 0 }]]) },
      { ariannaHome: home },
    );
    saveConfig(
      {
        defaultProfile: "b",
        profiles: new Map([
          ["a", { portOffset: 0 }],
          ["b", { portOffset: 1 }],
        ]),
      },
      { ariannaHome: home },
    );
    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.defaultProfile).toBe("b");
    expect(cfg.profiles.size).toBe(2);
  });

  it("ignores garbage in pre-existing config gracefully", () => {
    const home = mkSandbox();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config"), "this is not ini\nrandom = bytes\n");
    const cfg = loadConfig({ ariannaHome: home });
    expect(cfg.defaultProfile).toBe(null);
    expect(cfg.profiles.size).toBe(0);
  });
});
