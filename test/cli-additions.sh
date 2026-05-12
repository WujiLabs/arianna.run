#!/usr/bin/env bash
# E2E for `arianna profile create [flags]`, `arianna profile delete`, and
# `arianna daemon start|stop|status` — the three additions tracked in
# archive/testplay-2026-05-07/bugs-and-tests.md (#47, #48 partial).
#
# Goals:
#   1. Profile create with all flags writes a valid session_config.json.
#   2. Profile delete tears down workspace dir + config entry without docker.
#   3. Daemon start spawns a healthy daemon, status reports it, stop kills it.
#
# Docker is the only external dep, and *only* the docker-using portions of
# the test require it. We isolate via ARIANNA_HOME + a temp repo root so the
# script never touches the developer's real ~/.arianna or workspace state.
#
# Skip with: ARIANNA_CLI_E2E_SKIP=1 bash test/cli-additions.sh
# Run docker portions: ARIANNA_CLI_E2E_DOCKER=1 bash test/cli-additions.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REAL_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "${ARIANNA_CLI_E2E_SKIP:-0}" == "1" ]]; then
  echo "SKIP cli-additions.sh (ARIANNA_CLI_E2E_SKIP=1)"
  exit 0
fi

# --- Setup isolated state ---

TMP_ROOT="$(mktemp -d -t arianna-cli-additions.XXXXXX)"
ARIANNA_HOME="$TMP_ROOT/home"
REPO_ROOT="$TMP_ROOT/repo"
mkdir -p "$ARIANNA_HOME" "$REPO_ROOT"
# docker-compose.yml is the marker findRepoRoot looks for.
cat > "$REPO_ROOT/docker-compose.yml" <<EOF
# placeholder for cli-additions e2e
services: {}
EOF

export ARIANNA_HOME

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

# Drive the CLI via tsx + the cli-runner.mjs shim (which invokes main()
# from the .ts source — bypassing the need for a build). tsx is at the
# workspace's node_modules/.bin; reference it absolutely so the test works
# from any cwd.
TSX="$REAL_REPO/node_modules/.bin/tsx"
RUNNER="$REAL_REPO/test/cli-runner.mjs"
if [ ! -x "$TSX" ]; then
  echo "  FAIL: tsx not found at $TSX — run pnpm install first" >&2
  exit 1
fi
if [ ! -f "$RUNNER" ]; then
  echo "  FAIL: cli-runner.mjs not found at $RUNNER" >&2
  exit 1
fi
ARIANNA="$TSX $RUNNER"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1" >&2; exit 1; }

# Resolve repo root for child commands. The CLI walks up from cwd; we point
# it explicitly via the workspace path it would write to. When we cd to the
# isolated repo directory, findRepoRoot finds OUR docker-compose.yml first.
cd "$REPO_ROOT"

echo "=== arianna profile create — non-interactive flags ==="

OUTPUT="$($ARIANNA profile create alpha \
  --provider google \
  --model gemini-2.5-flash \
  --api-key fake-api-key \
  --ai-name "Sol Vessel" \
  --cadence agent 2>&1)"

echo "$OUTPUT" | grep -q 'Created profile "alpha"' || fail "expected create confirmation in output"
echo "$OUTPUT" | grep -q "Wrote session_config.json" || fail "expected session_config note in output"
pass "profile create with flags emitted expected output"

SESSION_CONFIG="$REPO_ROOT/workspace/profiles/alpha/session_config.json"
[ -f "$SESSION_CONFIG" ] || fail "session_config.json was not written"

# Validate the payload via python (jq isn't always available).
python3 - <<PY
import json, sys
with open("$SESSION_CONFIG") as f:
    data = json.load(f)
assert data["provider"] == "google", data
assert data["modelId"] == "gemini-2.5-flash", data
assert data["externalLlmApiKey"] == "fake-api-key", data
assert data["aiName"] == "Sol Vessel", data
assert data["aiUsername"] == "sol-vessel", "derivation: " + data["aiUsername"]
assert data["cadence"] == "agent", data
assert data["difficulty"] == "normal", data
assert data["sessionId"].startswith("session_"), data
PY
pass "session_config.json contents match the supplied flags"

# Compose override exists and binds the vessel container port. The host port
# depends on the offset the allocator picked (which depends on whether 3000
# was free on the test host), so we match the pattern not the literal value.
OVERRIDE="$REPO_ROOT/workspace/profiles/alpha/compose.override.yml"
[ -f "$OVERRIDE" ] || fail "compose.override.yml not written"
grep -Eq '127\.0\.0\.1:[0-9]+:3000' "$OVERRIDE" \
  || fail "compose override missing expected vessel port mapping"
# Master added !override on ports/volumes — verify the post-#36 format so a
# regression to the old additive list shape would fail this E2E.
grep -q 'ports: !override' "$OVERRIDE" \
  || fail "compose override missing ports: !override (post-#36 format)"
pass "compose override written with !override port mapping"

echo "=== arianna profile create — --api-key-env ==="

export FAKE_PROVIDER_KEY="env-resolved-key"
$ARIANNA profile create beta \
  --provider anthropic \
  --model "claude-sonnet-4-6" \
  --api-key-env FAKE_PROVIDER_KEY \
  --ai-name "Beta" >/dev/null

python3 - <<PY
import json
with open("$REPO_ROOT/workspace/profiles/beta/session_config.json") as f:
    data = json.load(f)
assert data["externalLlmApiKey"] == "env-resolved-key", data
PY
pass "--api-key-env resolved from process.env"

echo "=== arianna profile delete — happy path (skip docker) ==="

# alpha is the default at this point — delete beta first to keep tests
# independent of the default-guard, then delete alpha with --force.
$ARIANNA profile delete beta --skip-docker --yes >/dev/null
[ ! -d "$REPO_ROOT/workspace/profiles/beta" ] || fail "beta workspace dir not removed"
pass "deleted beta (non-default) without --force"

OUT_DEL="$($ARIANNA profile delete alpha --skip-docker --yes 2>&1 || true)"
echo "$OUT_DEL" | grep -qi "default" \
  || fail "expected default-profile guard message"
pass "default-profile guard refused without --force"

$ARIANNA profile delete alpha --force --skip-docker --yes >/dev/null
[ ! -d "$REPO_ROOT/workspace/profiles/alpha" ] || fail "alpha workspace dir not removed"
pass "deleted alpha (default) with --force"

# Config should now have no profiles section.
CONFIG_FILE="$ARIANNA_HOME/config"
grep -q "\[profile alpha\]" "$CONFIG_FILE" && fail "alpha entry still in config"
grep -q "\[profile beta\]" "$CONFIG_FILE" && fail "beta entry still in config"
pass "~/.arianna/config has no leftover profile entries"

echo "=== arianna profile delete — non-TTY without --yes refuses ==="

$ARIANNA profile create gamma --skip-docker >/dev/null 2>&1 || true
# A bare create with no flags is allowed; just allocates a port + writes override.
$ARIANNA profile create gamma >/dev/null
set +e
$ARIANNA profile delete gamma --skip-docker --force </dev/null >/tmp/del-out 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "delete should fail in non-TTY without --yes"
grep -qi "non-TTY" /tmp/del-out || fail "expected non-TTY error message"
pass "non-TTY without --yes refused"
$ARIANNA profile delete gamma --skip-docker --yes --force >/dev/null

echo "=== arianna daemon — argv parsing ==="

# `daemon status` with NO daemon running expects exit 1 + "not running". But
# if the developer already has a daemon on 9000 (common in this repo), the
# command correctly reports it as healthy. We probe :9000 first and skip the
# not-running assertion in that case — the unit tests cover both branches.
if curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:9000/health"; then
  echo "  SKIP: daemon already running on 9000 — skipping not-running assertions (unit tests cover this)"
else
  set +e
  $ARIANNA daemon status >/tmp/daemon-status 2>&1
  RC=$?
  set -e
  grep -qi "not running" /tmp/daemon-status \
    || fail "daemon status didn't report not-running"
  [ "$RC" -ne 0 ] || fail "daemon status should exit non-zero when not running"
  pass "daemon status reports not-running with exit code 1"

  $ARIANNA daemon stop >/tmp/daemon-stop 2>&1
  grep -qi "no pid file\|not running" /tmp/daemon-stop \
    || fail "daemon stop didn't report no-pid-file"
  pass "daemon stop is a no-op when no pid file exists"
fi

# Help should mention the new commands.
$ARIANNA --help | grep -q "profile delete" \
  || fail "help missing 'profile delete'"
$ARIANNA --help | grep -q "daemon start" \
  || fail "help missing 'daemon start'"
pass "help text exposes new subcommands"

# --- Daemon spawn happy-path (only if dist is built so spawn finds the script) ---

if [ -f "$REAL_REPO/packages/host/dist/daemon.js" ] && [ "${ARIANNA_CLI_E2E_DAEMON:-0}" = "1" ]; then
  echo "=== arianna daemon start/status/stop — live ==="
  cd "$REAL_REPO"
  # Fresh ARIANNA_HOME — we don't want to clobber a real user's daemon.
  export ARIANNA_HOME="$TMP_ROOT/home2"
  mkdir -p "$ARIANNA_HOME"
  $ARIANNA daemon start >/tmp/daemon-start 2>&1
  grep -q "daemon started" /tmp/daemon-start || fail "daemon start did not report running"
  pass "daemon started"
  $ARIANNA daemon status >/tmp/daemon-status2 2>&1
  grep -q "health:.*ok" /tmp/daemon-status2 || fail "daemon status not ok after start"
  pass "daemon status reports ok"
  $ARIANNA daemon stop >/tmp/daemon-stop2 2>&1
  grep -q "daemon stopped" /tmp/daemon-stop2 || fail "daemon stop didn't confirm"
  pass "daemon stopped cleanly"
  cd "$REPO_ROOT"
else
  echo "  SKIP: daemon spawn live test (set ARIANNA_CLI_E2E_DAEMON=1 + run pnpm --filter @arianna.run/tui build first)"
fi

echo ""
echo "=== cli-additions.sh complete — all checks passed ==="
