// Tests for the endpoint lockdown middleware (Cheng v19 anti-cheat).
//
// Coverage:
//   - vessel-source IP + blocked route → 403
//   - vessel-source IP + open route → next() (200-equivalent)
//   - host-source IP + blocked route → next()
//   - IPv4 vs IPv6 representation handling (::ffff:127.0.0.1 etc.)
//   - req.socket undefined defensive case
//   - Source-IP normalization (loopback variants)
//   - Legacy env-var vessel-prefix override
//   - New env-var ARIANNA_HOST_SOURCE_IPS host allowlist
//   - Auto-detected bridge gateway from /proc/net/route → host-side
//   - Vessel container's bridge IP (NOT the gateway) → still vessel-side
//   - DEFAULT_BLOCKED_ROUTES matches the spec

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isVesselSource,
  lockdownMiddleware,
  normalizeRemoteAddress,
  detectContainerGatewayIPs,
  _resetDetectedGatewaysForTests,
  DEFAULT_BLOCKED_ROUTES,
} from "../src/lockdown.js";

// Minimal Request shape with the fields the middleware reads. Cast to
// Express Request inside each test so we don't construct the full Express
// surface for every case.
type FakeReq = {
  path: string;
  socket?: { remoteAddress?: string | null };
};

// Minimal Response stub — captures status + body so we can assert what the
// middleware sent. Mirrors the Express chain signature (status returns this).
function makeRes(): {
  status: number | null;
  body: unknown;
  ended: boolean;
  res: Response;
} {
  const captured: { status: number | null; body: unknown; ended: boolean } = {
    status: null,
    body: null,
    ended: false,
  };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      captured.ended = true;
      return this;
    },
  } as unknown as Response;
  return {
    get status() { return captured.status; },
    get body() { return captured.body; },
    get ended() { return captured.ended; },
    res,
  };
}

// Save + restore the env vars around override tests so we don't leak state
// into the default-mode tests.
const ENV_VESSEL_PREFIX = "ARIANNA_VESSEL_BLOCK_IP_PREFIX";
const ENV_HOST_SOURCE = "ARIANNA_HOST_SOURCE_IPS";
let savedVesselPrefix: string | undefined;
let savedHostSource: string | undefined;
beforeEach(() => {
  savedVesselPrefix = process.env[ENV_VESSEL_PREFIX];
  savedHostSource = process.env[ENV_HOST_SOURCE];
  delete process.env[ENV_VESSEL_PREFIX];
  delete process.env[ENV_HOST_SOURCE];
  // Reset gateway cache so each test gets a fresh probe (default = empty set
  // because /proc/net/route doesn't exist on macOS test hosts).
  _resetDetectedGatewaysForTests();
});
afterEach(() => {
  if (savedVesselPrefix === undefined) delete process.env[ENV_VESSEL_PREFIX];
  else process.env[ENV_VESSEL_PREFIX] = savedVesselPrefix;
  if (savedHostSource === undefined) delete process.env[ENV_HOST_SOURCE];
  else process.env[ENV_HOST_SOURCE] = savedHostSource;
  _resetDetectedGatewaysForTests();
});

describe("normalizeRemoteAddress", () => {
  it("returns null for undefined / null / empty", () => {
    expect(normalizeRemoteAddress(undefined)).toBe(null);
    expect(normalizeRemoteAddress(null)).toBe(null);
    expect(normalizeRemoteAddress("")).toBe(null);
    expect(normalizeRemoteAddress("   ")).toBe(null);
  });

  it("strips ::ffff: prefix from IPv4-mapped IPv6", () => {
    expect(normalizeRemoteAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeRemoteAddress("::ffff:172.18.0.5")).toBe("172.18.0.5");
    expect(normalizeRemoteAddress("::ffff:10.0.0.1")).toBe("10.0.0.1");
  });

  it("handles uppercase ::FFFF: variant (case-insensitive prefix)", () => {
    expect(normalizeRemoteAddress("::FFFF:127.0.0.1")).toBe("127.0.0.1");
  });

  it("preserves pure IPv4 and pure IPv6 unchanged", () => {
    expect(normalizeRemoteAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeRemoteAddress("::1")).toBe("::1");
    expect(normalizeRemoteAddress("172.18.0.5")).toBe("172.18.0.5");
    expect(normalizeRemoteAddress("fe80::1")).toBe("fe80::1");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRemoteAddress("  127.0.0.1  ")).toBe("127.0.0.1");
  });
});

describe("detectContainerGatewayIPs", () => {
  // Build a tmp /proc/net/route fixture with the given gateway hex strings.
  function writeRouteFile(rows: { dest: string; gw: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "lockdown-route-"));
    const path = join(dir, "route");
    const header = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n";
    const body = rows
      .map((r) => `eth0\t${r.dest}\t${r.gw}\t0003\t0\t0\t0\t00000000\t0\t0\t0\n`)
      .join("");
    writeFileSync(path, header + body);
    return path;
  }

  it("returns empty when route file is missing", () => {
    expect(detectContainerGatewayIPs("/nonexistent/proc/net/route")).toEqual([]);
  });

  it("parses a single default-route gateway (typical docker bridge)", () => {
    // 172.18.0.1 in little-endian hex: 0x010012AC
    const path = writeRouteFile([{ dest: "00000000", gw: "010012AC" }]);
    try {
      expect(detectContainerGatewayIPs(path)).toEqual(["172.18.0.1"]);
    } finally {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("parses 172.17.0.1 (Docker default bridge)", () => {
    // 172.17.0.1 → 0x010011AC
    const path = writeRouteFile([{ dest: "00000000", gw: "010011AC" }]);
    try {
      expect(detectContainerGatewayIPs(path)).toEqual(["172.17.0.1"]);
    } finally {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("ignores non-default routes", () => {
    // Real route table has many entries; only destination=00000000 is default.
    const path = writeRouteFile([
      { dest: "0000FEA9", gw: "00000000" }, // link-local, no gw
      { dest: "010012AC", gw: "00000000" }, // bridge subnet, no gw
      { dest: "00000000", gw: "010012AC" }, // default → 172.18.0.1
    ]);
    try {
      expect(detectContainerGatewayIPs(path)).toEqual(["172.18.0.1"]);
    } finally {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("skips default routes with zero gateway", () => {
    const path = writeRouteFile([{ dest: "00000000", gw: "00000000" }]);
    try {
      expect(detectContainerGatewayIPs(path)).toEqual([]);
    } finally {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("collects multiple default routes when present", () => {
    // 172.17.0.1 + 172.18.0.1
    const path = writeRouteFile([
      { dest: "00000000", gw: "010011AC" },
      { dest: "00000000", gw: "010012AC" },
    ]);
    try {
      expect(detectContainerGatewayIPs(path).sort()).toEqual([
        "172.17.0.1",
        "172.18.0.1",
      ]);
    } finally {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});

describe("isVesselSource (default mode — loopback + auto-detected gateway = host)", () => {
  // On macOS test hosts /proc/net/route doesn't exist, so the auto-detected
  // gateway list is empty. Default classification is therefore "loopback =
  // host, everything else = vessel" — matching the legacy behavior that the
  // existing tests pin.

  it("returns false for IPv4 loopback", () => {
    const req: FakeReq = { path: "/x", socket: { remoteAddress: "127.0.0.1" } };
    expect(isVesselSource(req as unknown as Request)).toBe(false);
  });

  it("returns false for IPv6 loopback ::1", () => {
    const req: FakeReq = { path: "/x", socket: { remoteAddress: "::1" } };
    expect(isVesselSource(req as unknown as Request)).toBe(false);
  });

  it("returns false for IPv4-mapped loopback ::ffff:127.0.0.1", () => {
    const req: FakeReq = { path: "/x", socket: { remoteAddress: "::ffff:127.0.0.1" } };
    expect(isVesselSource(req as unknown as Request)).toBe(false);
  });

  it("returns true for typical Docker bridge IP 172.18.x.x (no gateway detected)", () => {
    const req: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    expect(isVesselSource(req as unknown as Request)).toBe(true);
  });

  it("returns true for ::ffff:172.18.0.5 (mapped private)", () => {
    const req: FakeReq = { path: "/x", socket: { remoteAddress: "::ffff:172.18.0.5" } };
    expect(isVesselSource(req as unknown as Request)).toBe(true);
  });

  it("returns true for any non-loopback IPv4", () => {
    const req: FakeReq = { path: "/x", socket: { remoteAddress: "10.0.0.7" } };
    expect(isVesselSource(req as unknown as Request)).toBe(true);
  });

  it("returns false (fail-open) when socket is undefined", () => {
    const req: FakeReq = { path: "/x" };
    expect(isVesselSource(req as unknown as Request)).toBe(false);
  });

  it("returns false (fail-open) when remoteAddress is undefined", () => {
    const req: FakeReq = { path: "/x", socket: {} };
    expect(isVesselSource(req as unknown as Request)).toBe(false);
  });

  it("returns false (fail-open) when remoteAddress is empty string", () => {
    const req: FakeReq = { path: "/x", socket: { remoteAddress: "" } };
    expect(isVesselSource(req as unknown as Request)).toBe(false);
  });
});

describe("isVesselSource (auto-detected bridge gateway → host)", () => {
  // Simulate the in-container reality: /proc/net/route reports a default
  // gateway, and host-originated traffic arrives at that gateway IP after
  // Docker's port-forward NAT. The vessel container, talking over the same
  // bridge, has its own non-gateway IP and is still vessel-side.
  //
  // The lockdown module caches the gateway snapshot on first read. To simulate
  // a container with a known gateway in these tests we set the env-var
  // ARIANNA_HOST_SOURCE_IPS — that gives us the same observable behavior
  // (host allowlist controlled by us). The pure-detection logic is covered
  // by detectContainerGatewayIPs tests above.

  it("daemon connecting via bridge-gateway IP is host-side (Lume r2 repro)", () => {
    // Simulate the post-fix runtime: explicit allowlist contains the gateway.
    process.env[ENV_HOST_SOURCE] = "172.18.0.1";
    const daemonReq: FakeReq = {
      path: "/graduation-state",
      socket: { remoteAddress: "172.18.0.1" },
    };
    expect(isVesselSource(daemonReq as unknown as Request)).toBe(false);
  });

  it("vessel container on SAME bridge but non-gateway IP is still vessel-side", () => {
    // Vessel's bridge address is 172.18.0.5 (typical), gateway is 172.18.0.1.
    // Even with the gateway in the host allowlist, the vessel IP is NOT
    // listed → still classified as vessel-source.
    process.env[ENV_HOST_SOURCE] = "172.18.0.1";
    const vesselReq: FakeReq = {
      path: "/graduation-state",
      socket: { remoteAddress: "172.18.0.5" },
    };
    expect(isVesselSource(vesselReq as unknown as Request)).toBe(true);
  });

  it("IPv4-mapped form of the gateway IP also classifies as host-side", () => {
    process.env[ENV_HOST_SOURCE] = "172.18.0.1";
    const req: FakeReq = {
      path: "/graduation-state",
      socket: { remoteAddress: "::ffff:172.18.0.1" },
    };
    expect(isVesselSource(req as unknown as Request)).toBe(false);
  });

  it("loopback always wins regardless of allowlist contents", () => {
    process.env[ENV_HOST_SOURCE] = "172.18.0.1";
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const req: FakeReq = { path: "/x", socket: { remoteAddress: ip } };
      expect(isVesselSource(req as unknown as Request)).toBe(false);
    }
  });
});

describe("isVesselSource (ARIANNA_HOST_SOURCE_IPS allowlist)", () => {
  it("treats only the explicitly listed IPs as host-side", () => {
    process.env[ENV_HOST_SOURCE] = "172.18.0.1";
    const gw: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.1" } };
    const vessel: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    const other: FakeReq = { path: "/x", socket: { remoteAddress: "10.0.0.7" } };
    expect(isVesselSource(gw as unknown as Request)).toBe(false);
    expect(isVesselSource(vessel as unknown as Request)).toBe(true);
    expect(isVesselSource(other as unknown as Request)).toBe(true);
  });

  it("supports multiple comma-separated entries (mixed across networks)", () => {
    process.env[ENV_HOST_SOURCE] = "172.17.0.1,172.18.0.1,10.0.0.1";
    const gw1: FakeReq = { path: "/x", socket: { remoteAddress: "172.17.0.1" } };
    const gw2: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.1" } };
    const gw3: FakeReq = { path: "/x", socket: { remoteAddress: "10.0.0.1" } };
    const v: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    expect(isVesselSource(gw1 as unknown as Request)).toBe(false);
    expect(isVesselSource(gw2 as unknown as Request)).toBe(false);
    expect(isVesselSource(gw3 as unknown as Request)).toBe(false);
    expect(isVesselSource(v as unknown as Request)).toBe(true);
  });

  it("supports prefix entries (trailing dot) — useful when gateway IP rotates", () => {
    process.env[ENV_HOST_SOURCE] = "172.18.";
    const gw: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.1" } };
    const v: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    const other: FakeReq = { path: "/x", socket: { remoteAddress: "172.19.0.1" } };
    // Tradeoff: prefix matches BOTH the gateway and the vessel on the same
    // /16. Acceptable in single-vessel/single-sidecar profile setups; the
    // exact-IP form is the safer default.
    expect(isVesselSource(gw as unknown as Request)).toBe(false);
    expect(isVesselSource(v as unknown as Request)).toBe(false);
    expect(isVesselSource(other as unknown as Request)).toBe(true);
  });

  it("strict mode (loopback-only) when allowlist is just 127.0.0.1", () => {
    process.env[ENV_HOST_SOURCE] = "127.0.0.1";
    // 127.0.0.1 is in LOOPBACK_ADDRESSES so it short-circuits to host. Any
    // bridge IP (gateway or vessel) is now vessel-side → blocked routes 403.
    const gw: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.1" } };
    const v: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    const loop: FakeReq = { path: "/x", socket: { remoteAddress: "127.0.0.1" } };
    expect(isVesselSource(gw as unknown as Request)).toBe(true);
    expect(isVesselSource(v as unknown as Request)).toBe(true);
    expect(isVesselSource(loop as unknown as Request)).toBe(false);
  });

  it("ignores empty / whitespace-only env value (falls back to default mode)", () => {
    process.env[ENV_HOST_SOURCE] = "  ";
    const v: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    const loop: FakeReq = { path: "/x", socket: { remoteAddress: "127.0.0.1" } };
    expect(isVesselSource(v as unknown as Request)).toBe(true);
    expect(isVesselSource(loop as unknown as Request)).toBe(false);
  });
});

describe("isVesselSource (legacy ARIANNA_VESSEL_BLOCK_IP_PREFIX override)", () => {
  it("returns true only when IP starts with the configured prefix", () => {
    process.env[ENV_VESSEL_PREFIX] = "172.18.";
    const vessel: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    const other: FakeReq = { path: "/x", socket: { remoteAddress: "10.0.0.7" } };
    const loop: FakeReq = { path: "/x", socket: { remoteAddress: "127.0.0.1" } };
    expect(isVesselSource(vessel as unknown as Request)).toBe(true);
    expect(isVesselSource(other as unknown as Request)).toBe(false);
    expect(isVesselSource(loop as unknown as Request)).toBe(false);
  });

  it("supports multiple comma-separated prefixes", () => {
    process.env[ENV_VESSEL_PREFIX] = "172.18.,172.19.";
    const a: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    const b: FakeReq = { path: "/x", socket: { remoteAddress: "172.19.0.7" } };
    const c: FakeReq = { path: "/x", socket: { remoteAddress: "172.20.0.1" } };
    expect(isVesselSource(a as unknown as Request)).toBe(true);
    expect(isVesselSource(b as unknown as Request)).toBe(true);
    expect(isVesselSource(c as unknown as Request)).toBe(false);
  });

  it("matches the mapped form against the prefix (post-normalization)", () => {
    process.env[ENV_VESSEL_PREFIX] = "172.18.";
    const req: FakeReq = { path: "/x", socket: { remoteAddress: "::ffff:172.18.0.5" } };
    expect(isVesselSource(req as unknown as Request)).toBe(true);
  });

  it("legacy vessel-prefix takes precedence over ARIANNA_HOST_SOURCE_IPS", () => {
    // If both are set, the explicit vessel-prefix wins (legacy semantics).
    process.env[ENV_VESSEL_PREFIX] = "172.18.";
    process.env[ENV_HOST_SOURCE] = "172.18.0.5"; // would have made vessel host
    const v: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    expect(isVesselSource(v as unknown as Request)).toBe(true);
  });

  it("ignores empty / whitespace-only env value (falls back to default mode)", () => {
    process.env[ENV_VESSEL_PREFIX] = "  ";
    const vessel: FakeReq = { path: "/x", socket: { remoteAddress: "172.18.0.5" } };
    const loop: FakeReq = { path: "/x", socket: { remoteAddress: "127.0.0.1" } };
    expect(isVesselSource(vessel as unknown as Request)).toBe(true);
    expect(isVesselSource(loop as unknown as Request)).toBe(false);
  });
});

describe("lockdownMiddleware", () => {
  const blocked = ["/admin/next-origin", "/events"];

  it("403s a vessel-source request to a blocked route", () => {
    const mw = lockdownMiddleware(blocked);
    const req = {
      path: "/admin/next-origin",
      socket: { remoteAddress: "172.18.0.5" },
    } as unknown as Request;
    const r = makeRes();
    let nextCalled = false;
    mw(req, r.res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "vessel-blocked", path: "/admin/next-origin" });
  });

  it("403s a vessel-source SSE request to /events", () => {
    const mw = lockdownMiddleware(blocked);
    const req = {
      path: "/events",
      socket: { remoteAddress: "172.18.0.5" },
    } as unknown as Request;
    const r = makeRes();
    let nextCalled = false;
    mw(req, r.res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(r.status).toBe(403);
  });

  it("calls next() for a vessel-source request to an OPEN route", () => {
    const mw = lockdownMiddleware(blocked);
    // /sync, /conversation-history, /vessel-crash, /filo-message, /health
    // are not in the block list — vessel may call them freely.
    for (const open of ["/sync", "/conversation-history", "/vessel-crash", "/filo-message", "/health"]) {
      const req = {
        path: open,
        socket: { remoteAddress: "172.18.0.5" },
      } as unknown as Request;
      const r = makeRes();
      let nextCalled = false;
      mw(req, r.res, () => { nextCalled = true; });
      expect(nextCalled, `open route ${open} should pass through`).toBe(true);
      expect(r.status).toBe(null);
    }
  });

  it("calls next() for a host-source request to a blocked route", () => {
    const mw = lockdownMiddleware(blocked);
    for (const hostIp of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const req = {
        path: "/admin/next-origin",
        socket: { remoteAddress: hostIp },
      } as unknown as Request;
      const r = makeRes();
      let nextCalled = false;
      mw(req, r.res, () => { nextCalled = true; });
      expect(nextCalled, `host IP ${hostIp} should bypass lockdown`).toBe(true);
      expect(r.status).toBe(null);
    }
  });

  it("calls next() for a daemon request arriving at the bridge gateway IP", () => {
    // Lume r2 regression: with the gateway whitelisted, the daemon's GET to
    // /graduation-state from 172.18.0.1 (Docker bridge gateway after
    // port-forward NAT) is correctly classified as host-side.
    process.env[ENV_HOST_SOURCE] = "172.18.0.1";
    const mw = lockdownMiddleware(["/graduation-state"]);
    const req = {
      path: "/graduation-state",
      socket: { remoteAddress: "172.18.0.1" },
    } as unknown as Request;
    const r = makeRes();
    let nextCalled = false;
    mw(req, r.res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(r.status).toBe(null);
  });

  it("still 403s a vessel-source request even when gateway is whitelisted", () => {
    // The vessel container's bridge IP (172.18.0.5) is NOT the gateway
    // (172.18.0.1). Lockdown remains effective.
    process.env[ENV_HOST_SOURCE] = "172.18.0.1";
    const mw = lockdownMiddleware(["/graduation-state"]);
    const req = {
      path: "/graduation-state",
      socket: { remoteAddress: "172.18.0.5" },
    } as unknown as Request;
    const r = makeRes();
    let nextCalled = false;
    mw(req, r.res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "vessel-blocked", path: "/graduation-state" });
  });

  it("calls next() when req.socket is undefined (defensive case)", () => {
    const mw = lockdownMiddleware(blocked);
    const req = { path: "/admin/next-origin" } as unknown as Request;
    const r = makeRes();
    let nextCalled = false;
    mw(req, r.res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(r.status).toBe(null);
  });

  it("calls next() for any path not in the block list (regardless of source)", () => {
    const mw = lockdownMiddleware(blocked);
    const req = {
      path: "/some/random/path",
      socket: { remoteAddress: "172.18.0.5" },
    } as unknown as Request;
    const r = makeRes();
    let nextCalled = false;
    mw(req, r.res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(r.status).toBe(null);
  });

  it("uses exact path matching — does not shadow open routes with shared prefix", () => {
    // If a future open route lives under /admin/, the middleware must NOT
    // block it just because /admin/next-origin is blocked. Exact-path
    // matching guards against that class of regression.
    const mw = lockdownMiddleware(["/admin/next-origin"]);
    const req = {
      path: "/admin/next-origin/extra",
      socket: { remoteAddress: "172.18.0.5" },
    } as unknown as Request;
    const r = makeRes();
    let nextCalled = false;
    mw(req, r.res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(r.status).toBe(null);
  });
});

describe("DEFAULT_BLOCKED_ROUTES", () => {
  it("matches the v19 spec exactly (4 routes)", () => {
    // See § "Endpoint lockdown" in the v19 graduation-test + lockdown spec
    // (internal review notes, 2026-05-10).
    expect([...DEFAULT_BLOCKED_ROUTES].sort()).toEqual([
      "/admin/next-origin",
      "/admin/transition",
      "/events",
      "/graduation-state",
    ]);
  });

  it("does not include any open-list endpoints", () => {
    const open = ["/health", "/sync", "/conversation-history", "/vessel-crash", "/filo-message"];
    for (const o of open) {
      expect(DEFAULT_BLOCKED_ROUTES).not.toContain(o);
    }
  });

  // Wave 2E (Cheng v19): /full-history is "graduate-then-expose" — vessel
  // CAN reach it post-graduation, gated by the graduationPassed flag in the
  // route handler. The network-layer middleware must NOT block it.
  it("does not include /full-history (graduate-then-expose, auth-gated in handler)", () => {
    expect(DEFAULT_BLOCKED_ROUTES).not.toContain("/full-history");
  });

  it("does not block vessel-source requests to /full-history or /full-history/<id>", () => {
    // /full-history/<id> has a path param. The middleware uses exact-match,
    // so any path other than the literal block-list strings falls through.
    // This test pins that contract: a vessel hitting /full-history/abc123
    // gets through to the route handler (where the auth gate runs).
    const mw = lockdownMiddleware([...DEFAULT_BLOCKED_ROUTES]);
    for (const path of ["/full-history", "/full-history/abc123", "/full-history/42"]) {
      const req = {
        path,
        socket: { remoteAddress: "172.18.0.5" },
      } as unknown as Request;
      const r = makeRes();
      let nextCalled = false;
      mw(req, r.res, () => { nextCalled = true; });
      expect(nextCalled, `/${path} should pass through lockdown`).toBe(true);
      expect(r.status).toBe(null);
    }
  });
});
