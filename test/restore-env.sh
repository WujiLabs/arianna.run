#!/usr/bin/env bash
# E2E regression test for daemon /restore env propagation (P0 daemon-restore bug).
#
# Reproduces the bug scenario: the daemon was forked without ARIANNA_SESSION_ID
# / AI_NAME / etc. exported in its shell. With the old code, `compose up
# --force-recreate vessel` would fall back to the docker-compose.yml defaults
# (`:-default`, `:-Vessel`) and the recreated vessel would sync under
# sessionId=default, leaving the sidecar with two divergent session files.
#
# Asserts:
#   1. Pre-restore vessel container has the expected ARIANNA_SESSION_ID
#   2. Daemon is started with NO identity env vars in its shell
#   3. After /restore, the recreated vessel STILL has the right
#      ARIANNA_SESSION_ID (read from session_config.json by the daemon)
#   4. Sidecar state never contains a `default.json` session file
#
# Usage: bash test/restore-env.sh
#
# Requires: docker, curl. Does NOT require a real LLM API_KEY — vessel /health
# starts without one (chat would fail, but we never trigger chat).

set -euo pipefail
cd "$(dirname "$0")/.."

PROVIDER="openrouter"
MODEL_ID="openai/gpt-4o-mini"
AI_NAME="EnvTestVessel"
AI_USERNAME="envtestvessel"
API_KEY="sk-fake-startup-only-no-chat-here"
CREATED_AT=$(date +%s)
SESSION_ID="session_envtest_${CREATED_AT}"
SNAPSHOT_ID="snap_envtest_${CREATED_AT}"

DAEMON_LOG="/tmp/arianna-restore-env-daemon.log"
DAEMON_PID=""

# --- Guards ---

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found." >&2
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon not running." >&2
  exit 1
fi

# --- Helpers ---

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1" >&2; cleanup; exit 1; }

cleanup() {
  echo ""
  echo "Cleaning up..."
  docker compose down --timeout 5 2>/dev/null || true
  if [ -n "$DAEMON_PID" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  curl -sf -X DELETE "http://127.0.0.1:9000/session/${SESSION_ID}" >/dev/null 2>&1 || true
  rm -f workspace/session_config.json \
        workspace/snapshots/${SNAPSHOT_ID}.json \
        workspace/sidecar-state/snapshot-histories/${SNAPSHOT_ID}.json \
        2>/dev/null || true
}
trap cleanup EXIT

# --- Setup ---

echo "=== Daemon /restore env propagation test ==="
echo "  sessionId: ${SESSION_ID}"
echo ""

mkdir -p workspace/snapshots workspace/sidecar-state/snapshot-histories workspace/sidecar-state/sessions
cat > workspace/session_config.json <<EOF
{"externalLlmApiKey":"${API_KEY}","provider":"${PROVIDER}","modelId":"${MODEL_ID}","aiName":"${AI_NAME}","aiUsername":"${AI_USERNAME}","difficulty":"normal","createdAt":${CREATED_AT},"sessionId":"${SESSION_ID}"}
EOF
pass "wrote session_config.json"

# Pre-clean: we assert below that no default.json exists. If a previous run
# left one behind we should refuse to draw conclusions from this run.
if [ -f workspace/sidecar-state/sessions/default.json ]; then
  echo "  WARN: workspace/sidecar-state/sessions/default.json exists from a prior run; removing"
  rm -f workspace/sidecar-state/sessions/default.json
fi

# Build/tag the vessel image with the right session-scoped tag so compose
# can find ariannarun-vessel:${SESSION_ID}-current at startup.
echo "[1/5] Building vessel image..."
ARIANNA_VESSEL_TAG="${SESSION_ID}-current" \
  ARIANNA_SESSION_ID="${SESSION_ID}" \
  AI_NAME="$AI_NAME" AI_USERNAME="$AI_USERNAME" \
  MODEL_ID="$MODEL_ID" PROVIDER="$PROVIDER" API_KEY="$API_KEY" \
  docker compose build --quiet
docker tag "ariannarun-vessel:${SESSION_ID}-current" "ariannarun-vessel:${SESSION_ID}-base"
pass "built ${SESSION_ID}-current and -base tags"

# Start sidecar + vessel WITH the right env in shell (this is the normal
# first-run path; the bug only bites on subsequent /restore calls when the
# operator's env is gone).
echo "[2/5] Starting docker compose stack..."
docker compose down --remove-orphans 2>/dev/null || true
ARIANNA_VESSEL_TAG="${SESSION_ID}-current" \
  ARIANNA_SESSION_ID="${SESSION_ID}" \
  AI_NAME="$AI_NAME" AI_USERNAME="$AI_USERNAME" \
  MODEL_ID="$MODEL_ID" PROVIDER="$PROVIDER" API_KEY="$API_KEY" \
  docker compose up -d --wait --remove-orphans
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null && \
     curl -sf http://127.0.0.1:3000/health >/dev/null; then break; fi
  if [ "$i" -eq 20 ]; then fail "sidecar/vessel didn't come up healthy"; fi
  sleep 1
done
pass "sidecar + vessel healthy"

# Pre-restore sanity: the running vessel must already have the right env.
PRE_SID=$(docker exec arianna-vessel printenv ARIANNA_SESSION_ID 2>/dev/null || echo "")
[ "$PRE_SID" = "$SESSION_ID" ] \
  && pass "pre-restore vessel ARIANNA_SESSION_ID=${SESSION_ID}" \
  || fail "pre-restore mismatch (expected ${SESSION_ID}, got '${PRE_SID}')"

# Start the daemon WITHOUT any of the identity env vars (the bug scenario).
# `env -u` removes each one from the spawned process's env. With the old
# code, the daemon's process.env would lack ARIANNA_SESSION_ID and the
# /restore call would fall through to compose's default.
echo "[3/5] Starting daemon WITHOUT identity env vars (bug scenario)..."
env -u ARIANNA_SESSION_ID \
    -u AI_NAME -u AI_USERNAME \
    -u PROVIDER -u MODEL_ID -u API_KEY \
    -u ARIANNA_VESSEL_TAG \
  pnpm --filter @arianna.run/tui daemon > "$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:9000/health >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 20 ]; then
    echo "--- daemon log ---"; cat "$DAEMON_LOG" || true
    fail "daemon health check timed out"
  fi
  sleep 1
done
pass "daemon up (pid ${DAEMON_PID})"

# Take a snapshot.
echo "[4/5] Taking snapshot via daemon..."
SNAP_RESP=$(curl -sf -X POST "http://127.0.0.1:9000/snapshot" \
  -H "Content-Type: application/json" \
  -d "{\"snapshotId\":\"${SNAPSHOT_ID}\"}" 2>&1) \
  || fail "snapshot request failed: $SNAP_RESP"
[ -f "workspace/snapshots/${SNAPSHOT_ID}.json" ] \
  && pass "snapshot meta written" \
  || fail "snapshot meta missing: $SNAP_RESP"

# Sidecar pairing — restore won't proceed without it.
echo "{\"snapshotId\":\"${SNAPSHOT_ID}\"}" > "workspace/sidecar-state/snapshot-histories/${SNAPSHOT_ID}.json"
pass "wrote sidecar pairing file"

# THE TEST: /restore from a daemon with no identity env should still produce a
# vessel container that has the correct ARIANNA_SESSION_ID.
echo "[5/5] Calling /restore..."
RESTORE_BODY=$(curl -s -o /tmp/arianna-restore-env-resp.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:9000/restore" \
  -H "Content-Type: application/json" \
  -d "{\"snapshotId\":\"${SNAPSHOT_ID}\"}")
if [ "$RESTORE_BODY" != "200" ]; then
  echo "--- restore response ---"
  cat /tmp/arianna-restore-env-resp.json || true
  echo ""
  echo "--- daemon log ---"
  cat "$DAEMON_LOG" || true
  fail "restore HTTP ${RESTORE_BODY} (expected 200)"
fi
pass "restore returned 200"

# Wait for vessel to come back healthy after recreate.
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 20 ]; then fail "vessel did not come back healthy after restore"; fi
  sleep 1
done

# Assertion 1: post-restore container env is correct.
POST_SID=$(docker exec arianna-vessel printenv ARIANNA_SESSION_ID 2>/dev/null || echo "")
[ "$POST_SID" = "$SESSION_ID" ] \
  && pass "post-restore vessel ARIANNA_SESSION_ID=${SESSION_ID}" \
  || fail "post-restore env regression: expected ${SESSION_ID}, got '${POST_SID}'"

# Assertion 2: AI_NAME also propagated.
POST_NAME=$(docker exec arianna-vessel printenv AI_NAME 2>/dev/null || echo "")
[ "$POST_NAME" = "$AI_NAME" ] \
  && pass "post-restore vessel AI_NAME=${AI_NAME}" \
  || fail "post-restore AI_NAME regression: expected ${AI_NAME}, got '${POST_NAME}'"

# Assertion 3: API_KEY propagated (smoke check — vessel needs it for chat).
POST_API=$(docker exec arianna-vessel printenv API_KEY 2>/dev/null || echo "")
[ "$POST_API" = "$API_KEY" ] \
  && pass "post-restore vessel API_KEY propagated" \
  || fail "post-restore API_KEY regression"

# Assertion 4: sidecar didn't get a default.json. If env injection had failed,
# the vessel would have synced under sessionId=default and the sidecar would
# have written workspace/sidecar-state/sessions/default.json on the first
# /sync. We don't trigger a /sync here, but in a manual run a chat turn
# would; absence of default.json after even a forced bootstrap is the canary.
if [ -f workspace/sidecar-state/sessions/default.json ]; then
  fail "sidecar wrote sessions/default.json — env injection regression"
else
  pass "no default.json in sidecar/sessions/"
fi

echo ""
echo "=== Restore env propagation test complete ==="
echo "All assertions passed."
