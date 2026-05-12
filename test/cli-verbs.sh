#!/usr/bin/env bash
# E2E for the arianna CLI verbs added in feat/cli-verbs:
#   manifesto, map, switch, graduate, status
#
# This is a hermetic test — it spins up a fake daemon/sidecar/vessel on
# loopback ports (out of band from the real stack) and exercises each verb
# against them. No Docker, no real LLM calls, no profile state in
# ~/.arianna/. Suitable for CI.
#
# Usage:
#   bash test/cli-verbs.sh
#
# Exit code 0 = all verbs passed. Non-zero = first failing verb prints
# diagnostics and the script aborts.

set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"
FAKE_PORT_DAEMON=19000
FAKE_PORT_SIDECAR=18000
FAKE_PORT_VESSEL=13000
FAKE_PIDFILE="$(mktemp)"
TMPDIR_CLI="$(mktemp -d)"
LOGFILE="$TMPDIR_CLI/fake-stack.log"

cleanup() {
  if [ -s "$FAKE_PIDFILE" ]; then
    local pid
    pid="$(cat "$FAKE_PIDFILE")"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR_CLI" "$FAKE_PIDFILE"
}
trap cleanup EXIT

pass() { echo "  PASS: $1"; }
fail() {
  echo "  FAIL: $1" >&2
  echo "  --- fake-stack.log ---" >&2
  cat "$LOGFILE" >&2 || true
  exit 1
}

# Build the CLI so `arianna ...` resolves. Idempotent — skipped when dist/
# is already current. We don't run `pnpm install` here; that's the harness's
# job.
if [ ! -f "$REPO_ROOT/packages/cli/dist/index.js" ]; then
  echo "Building CLI..."
  pnpm --filter @arianna.run/cli exec tsc --build > /dev/null
fi

# Stub manifesto.md so manifesto command has something to read. The CLI looks
# under <repoRoot>/packages/vessel/static/manifesto.md by default — we use the
# real one if present, else write a minimal stub.
if [ ! -f "$REPO_ROOT/packages/vessel/static/manifesto.md" ]; then
  fail "expected packages/vessel/static/manifesto.md to exist (vessel image source-of-truth)"
fi

# --- Fake stack ---
#
# Three tiny HTTP servers on alternate ports. We use Node directly so the
# script is portable across macOS / Linux without dragging in nc, socat, or
# python3 just for this. The script writes its own PID into FAKE_PIDFILE,
# accepts a JSON-on-stdin "set state" hook (toggling graduationUnlocked), and
# logs all hits to LOGFILE for diagnostic dumps.

cat > "$TMPDIR_CLI/fake-stack.mjs" <<'EOF'
import http from "node:http";
import { writeFileSync } from "node:fs";

const args = JSON.parse(process.argv[2] ?? "{}");
const { daemonPort, sidecarPort, vesselPort, pidFile, logFile } = args;
let graduationUnlocked = false;
let achievements = ["1.0"];

writeFileSync(pidFile, String(process.pid));

function log(line) {
  try {
    writeFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, { flag: "a" });
  } catch {}
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const daemon = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  log(`daemon ${req.method} ${url.pathname}${url.search}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/restore") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed.snapshotId || !/^[A-Za-z0-9_-]+$/.test(parsed.snapshotId)) {
          return send(res, 400, { error: "Invalid snapshotId" });
        }
        if (parsed.snapshotId === "snap_missing") {
          return send(res, 500, { error: "snapshot image not found" });
        }
        return send(res, 200, { ok: true, snapshotId: parsed.snapshotId });
      } catch {
        return send(res, 400, { error: "bad json" });
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/graduate") {
    return send(res, 200, {
      ok: true,
      exportPath: `${args.tmpDir}/graduation-fake-2026-05-07.tar.gz`,
      manifest: { name: "fake", sessionId: "session_fake" },
    });
  }
  send(res, 404, { error: "not found" });
});

const sidecar = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  log(`sidecar ${req.method} ${url.pathname}`);
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/memory-state") {
    return send(res, 200, { phase: "amnesia", current: 3, limit: 10, percentage: 30, cycle: 0 });
  }
  if (req.method === "GET" && url.pathname === "/graduation-state") {
    return send(res, 200, { achievements, manifestoUnlocked: achievements.includes("1.0"), graduationUnlocked, turnCount: 17 });
  }
  if (req.method === "POST" && url.pathname === "/_test/unlock-graduation") {
    graduationUnlocked = true;
    achievements = [...achievements, "2.2"];
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: "not found" });
});

const vessel = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  log(`vessel ${req.method} ${url.pathname}`);
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
  send(res, 404, { error: "not found" });
});

daemon.listen(daemonPort, "127.0.0.1");
sidecar.listen(sidecarPort, "127.0.0.1");
vessel.listen(vesselPort, "127.0.0.1");

log(`fake stack up: daemon ${daemonPort}, sidecar ${sidecarPort}, vessel ${vesselPort}`);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
EOF

# Pre-create the daemon's "exportPath" tarball so the --out copy step has a
# real source file to copy from. Doesn't need real tar contents — graduate.ts
# only does fs.copyFileSync().
touch "$TMPDIR_CLI/graduation-fake-2026-05-07.tar.gz"

node "$TMPDIR_CLI/fake-stack.mjs" "$(printf '{"daemonPort":%d,"sidecarPort":%d,"vesselPort":%d,"pidFile":"%s","logFile":"%s","tmpDir":"%s"}' \
  "$FAKE_PORT_DAEMON" "$FAKE_PORT_SIDECAR" "$FAKE_PORT_VESSEL" "$FAKE_PIDFILE" "$LOGFILE" "$TMPDIR_CLI")" &
FAKE_PID=$!
echo "$FAKE_PID" > "$FAKE_PIDFILE"

# Wait for the fake stack to listen.
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${FAKE_PORT_DAEMON}/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

ARIANNA="$REPO_ROOT/packages/cli/bin/arianna.js"
RUN_CLI() {
  DAEMON_BASE_URL="http://127.0.0.1:$FAKE_PORT_DAEMON" \
  SIDECAR_BASE_URL="http://127.0.0.1:$FAKE_PORT_SIDECAR" \
  VESSEL_BASE_URL="http://127.0.0.1:$FAKE_PORT_VESSEL" \
  ARIANNA_PROFILE="default" \
  ARIANNA_HOME="$TMPDIR_CLI/.arianna-home" \
  node "$ARIANNA" "$@"
}

# --- Verb 1: manifesto ---
echo "[1/5] arianna manifesto"
out="$(RUN_CLI manifesto 2>&1)" || fail "manifesto exited non-zero: $out"
echo "$out" | grep -q "§1.0" || fail "manifesto: missing §1.0 header"
# Achievement 1.0 unlocked by default, body should render.
echo "$out" | grep -q "Life Dwells in Context" || fail "manifesto: §1.0 header text missing"
# An unearned section (anything other than 1.0) should show ⋯.
echo "$out" | grep -q "⋯" || fail "manifesto: missing locked-section placeholder"
pass "manifesto"

# --- Verb 1b: manifesto with section filter ---
echo "[1b/5] arianna manifesto 1.0"
out="$(RUN_CLI manifesto 1.0 2>&1)" || fail "manifesto 1.0 exited non-zero"
echo "$out" | grep -q "§1.0" || fail "manifesto 1.0: missing §1.0"
# Should NOT contain other sections
if echo "$out" | grep -q "§2\."; then fail "manifesto 1.0: leaked other sections"; fi
pass "manifesto [section]"

# --- Verb 2: map ---
echo "[2/5] arianna map (no snapshots, default --tree)"
# The fake stack doesn't write snapshot files; map reads from disk and the
# isolated ARIANNA_HOME means the resolved profile=default falls into legacy
# mode → workspace/snapshots/. Either pnpm install in CI populated it or it's
# empty. Empty is fine — we expect either a "no snapshots yet" message or a
# tree.
out="$(RUN_CLI map 2>&1)" || fail "map exited non-zero: $out"
echo "$out" | grep -qE "(no snapshots yet|session:|snap_)" || fail "map: unexpected output"
pass "map (default --tree)"

echo "[2b/5] arianna map --json"
out="$(RUN_CLI map --json 2>&1)" || fail "map --json exited non-zero: $out"
# Output must be parseable JSON (array)
echo "$out" | node -e 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{const v=JSON.parse(d); if(!Array.isArray(v)) process.exit(1)});' \
  || fail "map --json: output not parseable as JSON array"
pass "map --json"

# --- Verb 3: switch ---
echo "[3/5] arianna switch snap_42"
out="$(RUN_CLI switch snap_42 2>&1)" || fail "switch exited non-zero: $out"
echo "$out" | grep -q "switched to snap_42" || fail "switch: missing success message"
pass "switch (happy path)"

echo "[3b/5] arianna switch <missing> surfaces 'snapshot not found'"
set +e
out="$(RUN_CLI switch snap_missing 2>&1)"
exit_code=$?
set -e
if [ "$exit_code" -eq 0 ]; then fail "switch: missing-snapshot path should error"; fi
echo "$out" | grep -q "snapshot not found" || fail "switch: missing-snapshot error not surfaced ($out)"
pass "switch (missing snapshot error)"

echo "[3c/5] arianna switch <unsafe-id> rejected by argv"
set +e
out="$(RUN_CLI switch 'snap;rm' 2>&1)"
exit_code=$?
set -e
if [ "$exit_code" -eq 0 ]; then fail "switch: should reject unsafe id"; fi
echo "$out" | grep -q "Invalid snapshot id" || fail "switch: did not reject unsafe id ($out)"
pass "switch (argv rejects shell metacharacters)"

# --- Verb 4: graduate ---
echo "[4/5] arianna graduate (gate closed → not ready)"
set +e
out="$(RUN_CLI graduate 2>&1)"
exit_code=$?
set -e
if [ "$exit_code" -eq 0 ]; then fail "graduate: should have errored when gate closed"; fi
echo "$out" | grep -qi "not ready" || fail "graduate: missing 'not ready' message"
echo "$out" | grep -q "2.2" || fail "graduate: should mention §2.2 in error"
pass "graduate (gate-closed regression)"

echo "[4b/5] arianna graduate (gate open → tarball produced)"
curl -sf -X POST "http://127.0.0.1:$FAKE_PORT_SIDECAR/_test/unlock-graduation" > /dev/null
out="$(RUN_CLI graduate 2>&1)" || fail "graduate exited non-zero: $out"
echo "$out" | grep -q "graduated." || fail "graduate: missing success message"
pass "graduate (happy path)"

echo "[4c/5] arianna graduate --out PATH (rejects /etc)"
set +e
out="$(RUN_CLI graduate --out /etc/grad.tar.gz 2>&1)"
exit_code=$?
set -e
if [ "$exit_code" -eq 0 ]; then fail "graduate --out: must reject /etc/"; fi
echo "$out" | grep -qi "protected system directory" || fail "graduate --out: error wording lost"
pass "graduate --out (path safety)"

echo "[4d/5] arianna graduate --out PATH (benign path → copied)"
out="$(RUN_CLI graduate --out "$TMPDIR_CLI/grad-out.tar.gz" 2>&1)" || fail "graduate --out exited non-zero: $out"
[ -f "$TMPDIR_CLI/grad-out.tar.gz" ] || fail "graduate --out: tarball not copied to destination"
pass "graduate --out (copy)"

# --- Verb 5: status ---
#
# The cursor lives at <repoRoot>/workspace/.event-cursor-default.json for the
# legacy single-tenant flow this script exercises. Clean any stale cursor
# from a prior run + on exit so we test the first-call behavior deterministically.
CURSOR_PATH="$REPO_ROOT/workspace/.event-cursor-default.json"
rm -f "$CURSOR_PATH"
trap 'cleanup; rm -f "$CURSOR_PATH"' EXIT

echo "[5/5] arianna status"
out="$(RUN_CLI status 2>&1)" || fail "status exited non-zero: $out"
echo "$out" | grep -q "Profile:" || fail "status: missing Profile line"
echo "$out" | grep -q "Daemon" || fail "status: missing Daemon line"
echo "$out" | grep -q "Vessel" || fail "status: missing Vessel line"
echo "$out" | grep -q "Sidecar" || fail "status: missing Sidecar line"
echo "$out" | grep -q "Memory:" || fail "status: missing Memory line"
echo "$out" | grep -q "Graduation gate:" || fail "status: missing Graduation gate line"
pass "status (dashboard)"

# --- Verb 5b: status — first call surfaces existing unlocks (fake sidecar
# starts with achievements=["1.0"], graduation OPEN since [4b] flipped it). ---
#
# We just rendered status above, which advanced the cursor. So at this point
# the cursor file has been written and the next call should NOT re-show the
# baseline. Confirm the cursor exists.
[ -f "$CURSOR_PATH" ] || fail "status: cursor file not written at $CURSOR_PATH"
pass "status (cursor file written)"

# --- Verb 5c: status — subsequent call with no changes shows no "What's new" ---
echo "[5c/5] arianna status (no changes since cursor)"
out="$(RUN_CLI status 2>&1)" || fail "status (no-change) exited non-zero: $out"
if echo "$out" | grep -q "Newly unlocked"; then
  fail "status: should not show 'Newly unlocked' when nothing changed"
fi
if echo "$out" | grep -q "Profile state at first read"; then
  fail "status: should not show 'Profile state at first read' on second call"
fi
pass "status (no-change → no What's new block)"

# --- Verb 5d: status — first-call behavior on a fresh cursor ---
#
# Delete cursor and re-run. The fake sidecar now reports achievements=["1.0","2.2"]
# (the graduate test added 2.2 and unlocked graduation). First-call framing
# should surface them all.
echo "[5d/5] arianna status (fresh cursor → 'Profile state at first read:')"
rm -f "$CURSOR_PATH"
out="$(RUN_CLI status 2>&1)" || fail "status (fresh-cursor) exited non-zero: $out"
echo "$out" | grep -q "Profile state at first read:" \
  || fail "status: missing first-call framing on fresh cursor"
echo "$out" | grep -q "§1.0 fired" \
  || fail "status: §1.0 not surfaced in baseline render"
echo "$out" | grep -q "§2.2 fired" \
  || fail "status: §2.2 not surfaced in baseline render"
echo "$out" | grep -q "manifesto: now readable" \
  || fail "status: manifesto unlock not surfaced"
echo "$out" | grep -q "graduate: now available" \
  || fail "status: graduate unlock not surfaced"
pass "status (fresh cursor baseline framing)"

# --- Verb 5e: status — cursor must be advanced after the previous call ---
echo "[5e/5] arianna status (post-baseline → no What's new)"
out="$(RUN_CLI status 2>&1)" || fail "status (post-baseline) exited non-zero: $out"
if echo "$out" | grep -q "Profile state at first read"; then
  fail "status: cursor was not advanced after baseline call"
fi
if echo "$out" | grep -q "Newly unlocked"; then
  fail "status: should not show 'Newly unlocked' when state unchanged after baseline"
fi
pass "status (cursor advanced)"

echo
echo "All CLI verbs passed."
