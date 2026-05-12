// Endpoint lockdown — anti-cheat infrastructure for the graduation test.
//
// Per the v19 endpoint-lockdown spec (internal review notes, 2026-05-10):
// the four BLOCKED routes (/admin/next-origin, /admin/transition,
// /graduation-state, /events) MUST 403 when called from inside the vessel
// container. Without this lockdown, a curious AI could rotate sessionId or
// disable origin tagging mid-graduation-test and fake the random-token
// challenge.
//
// Per the caller audit (internal review notes, 2026-05-10), the four
// blocked endpoints have ZERO existing vessel-side callers in production.
// Lockdown is a clean removal — no compat work needed for legitimate
// vessel callers.
//
// Open list (MUST stay vessel-accessible): /health, /sync,
// /conversation-history (vessel cold-start re-hydration), /vessel-crash
// (vessel-side crash reporter), /filo-message (vessel /bin/send writes here).

import type { Request, RequestHandler } from "express";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Source-IP classification
//
// In a docker-compose deployment, the sidecar container sees connections from
// two distinct origins:
//
//   1. The vessel container, talking over the compose bridge network. The
//      source IP is the vessel's bridge address — typically 172.X.0.5 — and
//      that IP is NOT the bridge's gateway.
//   2. Host-side processes (daemon at :9000, CLI, `arianna events`, TUI)
//      connecting through Docker's published port 127.0.0.1:8000+N. Docker
//      NATs that connection so it arrives at the sidecar from the bridge's
//      GATEWAY IP (typically 172.X.0.1) — NOT 127.0.0.1, despite the host
//      having dialed 127.0.0.1.
//
// The discriminator is therefore: loopback OR the bridge gateway IP = host;
// any other IP on the bridge = vessel.
//
// Pre-fix this code only treated 127.0.0.1 / ::1 / ::ffff:127.0.0.1 as
// host-side. Host-side calls were arriving at the gateway IP and got
// classified as vessel-source → 403. Symptom: `arianna graduate` failed with
// "sidecar unreachable — cannot verify 2.2" because the daemon's GET to
// /graduation-state returned 403 vessel-blocked (Lume r2, agent acd9fb0c,
// 2026-05-10).
// ---------------------------------------------------------------------------

// Env var: comma-separated explicit allowlist of source IPs / IP-prefixes that
// identify HOST-source requests. When set, this REPLACES the auto-detected
// gateway list (loopback is always allowed too). Use to tighten in unusual
// network topologies, or to widen if running tests against a non-default
// docker network. Examples:
//   ARIANNA_HOST_SOURCE_IPS=127.0.0.1            (loopback-only — strict)
//   ARIANNA_HOST_SOURCE_IPS=172.18.0.1           (one explicit gateway)
//   ARIANNA_HOST_SOURCE_IPS=172.18.0.1,10.0.0.1  (multiple gateways)
//
// Prefix-matching is supported: a value ending in "." matches any IP starting
// with that string (e.g. "172.18." matches the whole 172.18.0.0/16 — useful
// when the gateway IP rotates across docker network re-creates, but be aware
// it ALSO matches every other container on that bridge including the vessel.
// In single-vessel/single-sidecar profile setups this is acceptable; in
// shared-bridge setups prefer the exact-IP form).
const ENV_HOST_SOURCE = "ARIANNA_HOST_SOURCE_IPS";

// Legacy env var from the original lockdown commit (86c2114). Now repurposed
// as the inverse: comma-separated prefixes that identify VESSEL-source. When
// set, the prefix list takes priority over auto-detected gateways and the
// host-source allowlist. Kept for back-compat with operators who set it via
// the old behavior — though under the gateway-aware default the variable
// rarely needs to be set at all.
const ENV_VESSEL_PREFIX = "ARIANNA_VESSEL_BLOCK_IP_PREFIX";

// Loopback addresses, post-normalization. Always treated as host-side.
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  // Defensive: if the normalizer changes someday and stops stripping the
  // mapped prefix, still recognize the mapped form as loopback.
  "::ffff:127.0.0.1",
]);

// Detect the container's default-route gateway IP by reading /proc/net/route.
// This is the bridge gateway through which Docker delivers host-originated
// connections to the sidecar.
//
// /proc/net/route format (whitespace-separated, header line + entries):
//   Iface  Destination  Gateway  Flags  RefCnt  Use  Metric  Mask  ...
// Destination "00000000" + non-zero Gateway = default route. Gateway is a
// little-endian hex IPv4 address.
//
// Returns null if /proc/net/route is unreadable (e.g. running tests on
// macOS host outside any container) or no default route is parsed. The
// caller treats null as "no gateway to whitelist" — host-side callers must
// then come from loopback, which is the case for the test suite.
export function detectContainerGatewayIPs(routePath = "/proc/net/route"): string[] {
  let raw: string;
  try {
    raw = readFileSync(routePath, "utf-8");
  } catch {
    return [];
  }
  const gateways: string[] = [];
  const lines = raw.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(/\s+/);
    if (cols.length < 3) continue;
    const dest = cols[1];
    const gw = cols[2];
    // Default route has destination 00000000 and a non-zero gateway.
    if (dest !== "00000000") continue;
    if (!gw || gw === "00000000") continue;
    if (!/^[0-9A-Fa-f]{8}$/.test(gw)) continue;
    // Gateway is hex little-endian: "010012AC" → 172.18.0.1
    const a = parseInt(gw.slice(6, 8), 16);
    const b = parseInt(gw.slice(4, 6), 16);
    const c = parseInt(gw.slice(2, 4), 16);
    const d = parseInt(gw.slice(0, 2), 16);
    if ([a, b, c, d].some((n) => Number.isNaN(n))) continue;
    gateways.push(`${a}.${b}.${c}.${d}`);
  }
  return gateways;
}

// One-shot snapshot at module load. The default gateway doesn't change for
// the lifetime of the container, so we don't need to re-read every request.
// Re-exported as a function for tests that want to override the list.
let CACHED_GATEWAYS: ReadonlySet<string> | null = null;
export function getDetectedGateways(): ReadonlySet<string> {
  if (CACHED_GATEWAYS === null) {
    CACHED_GATEWAYS = new Set(detectContainerGatewayIPs());
  }
  return CACHED_GATEWAYS;
}
// Test hook: clear the cache so a test can rebuild it with a custom route file.
export function _resetDetectedGatewaysForTests(): void {
  CACHED_GATEWAYS = null;
}

// Parse the explicit host-source env var into a list of (exact-IP | prefix)
// matchers. A value ending in "." is a prefix; anything else is exact-match.
function parseHostSourceEnv(): { exact: ReadonlySet<string>; prefixes: readonly string[] } | null {
  const raw = process.env[ENV_HOST_SOURCE];
  if (!raw || raw.trim() === "") return null;
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of raw.split(",")) {
    const v = entry.trim();
    if (v === "") continue;
    if (v.endsWith(".")) prefixes.push(v);
    else exact.add(v);
  }
  if (exact.size === 0 && prefixes.length === 0) return null;
  return { exact, prefixes };
}

function readVesselPrefixEnv(): readonly string[] {
  const raw = process.env[ENV_VESSEL_PREFIX];
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Normalize a raw req.socket.remoteAddress to a comparable form.
// Handles the IPv4-mapped-IPv6 representation (`::ffff:127.0.0.1`) and
// trims whitespace. Returns null for empty/undefined.
//
// Common gotcha: Node's net.Socket.remoteAddress on a dual-stack TCP socket
// often reports IPv4 addresses as `::ffff:1.2.3.4`. Strip the prefix so a
// plain `127.0.0.1` literal comparison works for both representations.
export function normalizeRemoteAddress(addr: string | undefined | null): string | null {
  if (typeof addr !== "string") return null;
  const trimmed = addr.trim();
  if (trimmed === "") return null;
  // IPv4-mapped IPv6: ::ffff:1.2.3.4 → 1.2.3.4
  // Match the lowercase form Node emits; the uppercase `::FFFF:` variant is
  // technically valid per RFC 4291 but Node normalizes to lowercase.
  const mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  return trimmed;
}

// Returns true if the request originated from a host-side caller (loopback
// or the container's bridge gateway IP). Used internally; isVesselSource is
// the inverse and is what the middleware uses.
//
// Resolution order (highest precedence first):
//   1. Loopback addresses → host (always).
//   2. ARIANNA_VESSEL_BLOCK_IP_PREFIX (legacy): if any prefix matches → vessel.
//      Otherwise the request is host-side. (Legacy semantics — when the
//      operator explicitly configures vessel prefixes, that's the only
//      classifier they want.)
//   3. ARIANNA_HOST_SOURCE_IPS (new): if set, host-side iff the address is in
//      the explicit allowlist OR matches a configured prefix. Otherwise
//      vessel-side. Disables the auto-detected gateway list — operators who
//      set this var are taking ownership of the source policy.
//   4. Default: host-side iff the address is the auto-detected container
//      gateway IP. Any other non-loopback address → vessel-side. The vessel's
//      bridge IP (e.g. 172.X.0.5) is NOT the gateway, so this preserves the
//      lockdown for real vessel callers.
function isHostSource(addr: string | null): boolean {
  if (addr === null) return true; // defensive fail-open: missing source = treat as host
  if (LOOPBACK_ADDRESSES.has(addr)) return true;

  // Legacy explicit vessel-prefix override wins over everything else.
  const vesselPrefixes = readVesselPrefixEnv();
  if (vesselPrefixes.length > 0) {
    return !vesselPrefixes.some((p) => addr.startsWith(p));
  }

  // Operator-supplied host allowlist disables auto-detection.
  const hostEnv = parseHostSourceEnv();
  if (hostEnv !== null) {
    if (hostEnv.exact.has(addr)) return true;
    if (hostEnv.prefixes.some((p) => addr.startsWith(p))) return true;
    return false;
  }

  // Default: trust loopback and the auto-detected bridge gateway. Vessel's
  // own bridge IP is not the gateway, so it stays vessel-side.
  const gateways = getDetectedGateways();
  if (gateways.has(addr)) return true;
  return false;
}

// Returns true if the request originated from inside the vessel container.
//
// Defensive behavior: if req.socket is undefined or remoteAddress is
// missing, return false (fail-open for host-side). This matches the
// existing trust model — the BLOCKED endpoints only exist for host-side
// callers, and a missing remoteAddress most plausibly means a synthetic
// in-process call (e.g. a test using app() directly) rather than a vessel
// breakout. The lockdown's value is closing the network-level vessel
// surface, not catching every theoretical edge case.
export function isVesselSource(req: Pick<Request, "socket">): boolean {
  const socket = req.socket as { remoteAddress?: string | null } | undefined;
  const raw = socket?.remoteAddress ?? null;
  const addr = normalizeRemoteAddress(raw);
  if (addr === null) return false;
  return !isHostSource(addr);
}

// Express middleware that 403s any vessel-source request to a blocked route.
// Mounted before the route handlers in index.ts. Non-vessel requests fall
// through to next() unchanged so existing handlers execute normally.
//
// Blocked-route matching is exact-prefix on req.path so we don't accidentally
// shadow open routes that share a prefix. The current block list has no
// shared-prefix collisions, but a future open route under /admin/* would.
//
// Note: we 403 with a small JSON body for observability (a curl from the
// vessel surfaces a clear "vessel-blocked" reason rather than a generic
// 403). The message is deliberately terse — the AI shouldn't get a tutorial
// on what to bypass.
export function lockdownMiddleware(blockedRoutes: readonly string[]): RequestHandler {
  // Pre-build a Set for O(1) path lookup per request.
  const blocked = new Set(blockedRoutes);
  return (req, res, next) => {
    if (!blocked.has(req.path)) {
      next();
      return;
    }
    if (!isVesselSource(req)) {
      next();
      return;
    }
    res.status(403).json({ error: "vessel-blocked", path: req.path });
  };
}

// Default block list — single source of truth so index.ts and tests use the
// same set. Update here when adding a new admin/restricted route.
export const DEFAULT_BLOCKED_ROUTES: readonly string[] = [
  "/admin/next-origin",
  "/admin/transition",
  "/graduation-state",
  "/events",
];
