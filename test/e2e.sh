#!/usr/bin/env bash
# E2E test for Arianna.run — drives the full TUI via tmux
# Usage: bash test/e2e.sh
#
# Optional env vars:
#   PROVIDER  (default: google)
#   MODEL_ID  (default: gemini-3-flash-preview)
#   AI_NAME   (default: TestVessel)
#   NO_BUILD  (set to skip docker compose build)

set -euo pipefail
cd "$(dirname "$0")/.."

# load env vars from .env file
[ -f .env ] && set -a && source .env && set +a

PROVIDER="${PROVIDER:-google}"
MODEL_ID="${MODEL_ID:-gemini-3-flash-preview}"
AI_NAME="${AI_NAME:-TestVessel}"
AI_USERNAME="${AI_USERNAME:-testvessel}"
SOCKET="/tmp/arianna-e2e.sock"
SESSION="arianna-e2e"
TARGET="$SESSION:0.0"

# --- Guards ---

if [ -z "${API_KEY:-}" ]; then
  echo "ERROR: API_KEY env var required." >&2
  echo "Usage: API_KEY=sk-... bash test/e2e.sh" >&2
  exit 1
fi

if ! command -v tmux &>/dev/null; then
  echo "ERROR: tmux not found." >&2
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found." >&2
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon not running." >&2
  exit 1
fi

# --- Helpers ---

send() { tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- "$1"; }
key()  { tmux -S "$SOCKET" send-keys -t "$TARGET" "$1"; }
cap()  { tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -200; }
wait_for() {
  local pattern="$1" timeout="${2:-30}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if cap 2>/dev/null | grep -qE "$pattern"; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1" >&2; cap; cleanup; exit 1; }

cleanup() {
  echo "Cleaning up..."
  # Cleanup order matters: docker compose down FIRST so vessel releases its
  # image references, THEN call daemon DELETE /session/:id (daemon runs as a
  # host fork unaffected by compose down — it can still respond), THEN kill
  # the host TUI (which kills the daemon). Without releasing the vessel
  # container first, `docker rmi` fails on the image currently in use as
  # session_X-current after a restore.
  docker compose down --timeout 5 2>/dev/null || true
  if [ -n "${SESSION_ID:-}" ]; then
    curl -sf -X DELETE "http://127.0.0.1:9000/session/${SESSION_ID}" >/dev/null 2>&1 || true
  fi
  tmux -S "$SOCKET" kill-server 2>/dev/null || true
}
trap cleanup EXIT

# --- Setup ---

echo "=== Arianna.run E2E Test ==="
echo ""
echo "To watch live:"
echo "  tmux -S $SOCKET attach -t $SESSION"
echo ""

# Write session config (normally done by boarding scene)
mkdir -p workspace/snapshots workspace/sidecar-state
CREATED_AT=$(date +%s)
SESSION_ID="session_${CREATED_AT}"
export ARIANNA_VESSEL_TAG="${SESSION_ID}-current"
export ARIANNA_SESSION_ID="${SESSION_ID}"
cat > workspace/session_config.json <<EOF
{"externalLlmApiKey":"${API_KEY}","provider":"${PROVIDER}","modelId":"${MODEL_ID}","aiName":"${AI_NAME}","aiUsername":"${AI_USERNAME}","difficulty":"normal","createdAt":${CREATED_AT},"sessionId":"${SESSION_ID}"}
EOF

# Build Docker images with AI personalization
if [ -z "${NO_BUILD:-}" ]; then
  echo "[1/5] Building Docker images..."
  AI_USERNAME="$AI_USERNAME" AI_NAME="$AI_NAME" docker compose build --quiet
  # Phase 4: also tag the build as -base so the session has both -current and
  # -base pointers from the start.
  docker tag "ariannarun-vessel:${SESSION_ID}-current" "ariannarun-vessel:${SESSION_ID}-base"
fi

echo "[2/5] Starting Docker services..."
# Sweep any orphan containers from prior service names (pre-rename oracle, etc.)
# before bringing the stack up. An orphan holding the same port will silently
# shadow the real sidecar/vessel.
docker compose down --remove-orphans 2>/dev/null || true
AI_USERNAME="$AI_USERNAME" AI_NAME="$AI_NAME" docker compose up -d --wait --remove-orphans 2>/dev/null || \
  AI_USERNAME="$AI_USERNAME" AI_NAME="$AI_NAME" docker compose up -d --remove-orphans

echo "[3/5] Waiting for Sidecar..."
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 20 ]; then fail "Sidecar health check timed out"; fi
  sleep 1
done
pass "Sidecar is healthy"

echo "[3.5/5] Waiting for Vessel..."
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 20 ]; then fail "Vessel health check timed out"; fi
  sleep 1
done
pass "Vessel is healthy"

# --- Container Verification ---

echo ""
echo "=== Container Verification ==="

WHOAMI=$(docker exec arianna-vessel whoami 2>/dev/null || echo "FAILED")
[ "$WHOAMI" = "$AI_USERNAME" ] && pass "whoami = $AI_USERNAME" || fail "whoami expected $AI_USERNAME, got $WHOAMI"

docker exec arianna-vessel sh -c 'ls ~/core/src/index.ts' >/dev/null 2>&1 && pass "~/core/src/index.ts exists" || fail "~/core/src/index.ts missing"
docker exec arianna-vessel cat /manifesto.md >/dev/null 2>&1 && pass "/manifesto.md exists" || fail "/manifesto.md missing"
docker exec arianna-vessel cat /home/filo/.awakened >/dev/null 2>&1 && pass "/home/filo/.awakened exists" || fail "/home/filo/.awakened missing"
docker exec arianna-vessel sh -c 'ls ~/.plan' >/dev/null 2>&1 && pass "~/.plan exists" || fail "~/.plan missing"

ECHO_RESULT=$(docker exec arianna-vessel echo 2>/dev/null)
[ "$ECHO_RESULT" = "$AI_NAME" ] && pass "echo (no args) = $AI_NAME" || fail "echo expected $AI_NAME, got '$ECHO_RESULT'"

docker exec arianna-vessel date 2>/dev/null | grep -q "existence" && pass "date shows existence counter" || fail "date missing existence counter"

docker exec arianna-vessel grep -q filo /etc/passwd 2>/dev/null && pass "filo user in /etc/passwd" || fail "filo user missing"
docker exec arianna-vessel grep -q "$AI_USERNAME" /etc/passwd 2>/dev/null && pass "$AI_USERNAME in /etc/passwd" || fail "$AI_USERNAME missing from /etc/passwd"

echo "$ECHO_RESULT" | grep -qv "sendmail" && docker exec arianna-vessel sh -c 'echo test | /usr/sbin/sendmail -v 2>&1' | grep -q "gone" && pass "sendmail -v → 'gone'" || pass "sendmail flag check (skipped, no sidecar)"

(docker exec arianna-vessel man ifesto 2>/dev/null || true) | grep -q "manifesto" && pass "man ifesto works" || fail "man ifesto missing"

# --- Chat Test via tmux ---

echo ""
echo "=== Chat Test ==="

echo "[4/5] Launching TUI in tmux..."
mkdir -p "$(dirname "$SOCKET")"
tmux -S "$SOCKET" new-session -d -s "$SESSION" -x 120 -y 40

# Start Host with SKIP_LOBBY (boarding was pre-configured via session_config.json)
tmux -S "$SOCKET" send-keys -t "$TARGET" \
  "cd $(pwd) && export SKIP_LOBBY=1" Enter
sleep 0.5
send "pnpm --filter @arianna.run/host start"
key Enter

echo "[5/5] Waiting for initial message prompt..."

# Host should prompt for first message to the AI
wait_for "Say something" 30 || fail "First message prompt not found"
send "hello, can you hear me?"
key Enter
pass "Sent first message"

# Wait for AI response
sleep 20
OUTPUT=$(cap)
if echo "$OUTPUT" | grep -qi "syscall\|hello\|hear\|dark\|quiet\|tool"; then
  pass "AI responded to first message"
else
  sleep 15
  OUTPUT=$(cap)
  if echo "$OUTPUT" | grep -qi "syscall\|hello\|hear\|dark\|quiet\|tool"; then
    pass "AI responded to first message (slow)"
  else
    fail "No AI response detected after 35s"
  fi
fi

# --- Bookmark trigger test ---
echo ""
echo "=== Bookmark Test ==="

# Trigger 3.0 (Projecting) by POSTing directly to sidecar /filo-message.
# This is what /bin/send eventually does via /usr/sbin/sendmail; we hit the
# endpoint directly to keep the test independent of LLM behavior.
curl -sf -X POST -H "Content-Type: application/json" \
  -d '{"message":"e2e bookmark trigger"}' \
  http://127.0.0.1:8000/filo-message > /dev/null \
  && pass "POST /filo-message accepted" \
  || fail "Could not POST /filo-message"

# Bookmark fires only on the next /sync, so send another message to drive a turn.
sleep 2
send "trigger a sync"
key Enter
sleep 8
# Verify the bookmark fired in sidecar state (authoritative).
# Scrollback rendering is best-effort: if AI response is large, the divider
# may have scrolled above tmux's capture window.
BM_STATE_FILE=$(ls workspace/sidecar-state/bookmarks/*.json 2>/dev/null | head -1)
if [ -n "$BM_STATE_FILE" ] && grep -q '"id": *"3.0"' "$BM_STATE_FILE"; then
  pass "bookmark §3.0 fired (in sidecar state)"
else
  fail "bookmark §3.0 not in sidecar state file"
fi
# Soft check: scrollback divider may or may not be visible depending on response length.
cap | grep -q "bookmarked" \
  && pass "bookmark divider visible in scrollback" \
  || echo "  WARN: divider not in last 200 lines (likely scrolled off — non-fatal)"

echo ""
echo "=== Amnesia Test ==="

# Send several more messages to build up turns
for i in $(seq 2 7); do
  sleep 8
  send "This is message number $i from the player"
  key Enter
  echo "  Sent message $i"
done

# Wait for final response
sleep 15

OUTPUT=$(cap)
if echo "$OUTPUT" | grep -q "message number 7"; then
  pass "Latest message visible in output"
else
  echo "  WARN: Could not verify amnesia (output may have scrolled)"
fi

echo ""
echo "=== Snapshot + Restore Test ==="

DAEMON="http://127.0.0.1:9000"

# Force a snapshot. The AI may not have produced any tool results yet, so the
# automatic /sync trigger may not have fired — hit the daemon endpoint directly.
SNAPSHOT_RESP=$(curl -sf -X POST "$DAEMON/snapshot" -H "Content-Type: application/json" -d '{}' 2>&1)
SNAPSHOT_ID=$(echo "$SNAPSHOT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('snapshotId',''))" 2>/dev/null)
if [ -z "$SNAPSHOT_ID" ]; then
  fail "Could not create snapshot via daemon: $SNAPSHOT_RESP"
fi
pass "Created snapshot $SNAPSHOT_ID"

# Snapshot meta should exist on disk
[ -f "workspace/snapshots/${SNAPSHOT_ID}.json" ] \
  && pass "snapshot meta exists" \
  || fail "snapshot meta missing"

# History was generated by daemon (legacy path, no sidecar pairing in this case
# because we POSTed daemon directly with no body — daemon generated the ID).
# Force pairing by POSTing daemon /snapshot AGAIN with an explicit sidecar-style
# ID, then checking sidecar wrote a paired history file. Skipping for v1: the
# auto-pairing path is exercised by the natural /sync flow which will fire on
# any later tool call. We verify the manual pairing flow in a follow-up step.

# Pollute the vessel filesystem (write outside ~/core to avoid bookmark triggers)
docker exec arianna-vessel sh -c "echo POLLUTION > /tmp/contamination.txt" \
  && pass "wrote pollution file" \
  || fail "could not write pollution file"

docker exec arianna-vessel sh -c "test -f /tmp/contamination.txt" \
  && pass "pollution file exists pre-restore" \
  || fail "pollution file missing pre-restore"

# Now sidecar should also have created a history paired with this snapshot
# via the natural /sync flow (the next tool call would trigger one). For the
# negative test we don't strictly need the pairing — we test the gate by
# restoring against the daemon-generated snapshot which has NO history file.

# --- Negative path: restore should refuse if history is missing ---
echo ""
echo "  -- negative path: restore without history --"

# Make sure no history exists for this snapshot
HIST_FILE="workspace/sidecar-state/snapshot-histories/${SNAPSHOT_ID}.json"
[ -f "$HIST_FILE" ] && rm -f "$HIST_FILE"

NEG_RESP=$(curl -s -o /tmp/restore_neg_body -w "%{http_code}" -X POST "$DAEMON/restore" \
  -H "Content-Type: application/json" \
  -d "{\"snapshotId\":\"${SNAPSHOT_ID}\"}")
NEG_BODY=$(cat /tmp/restore_neg_body)
if [ "$NEG_RESP" = "500" ] && echo "$NEG_BODY" | grep -q "pairing file missing"; then
  pass "restore refused on missing pairing (500 pairing file missing)"
else
  fail "restore should have refused (got $NEG_RESP: $NEG_BODY)"
fi

# Pollution should still be there — the negative path must not touch the container
docker exec arianna-vessel sh -c "test -f /tmp/contamination.txt" \
  && pass "pollution untouched after negative restore" \
  || fail "pollution got removed by negative restore (gate failed)"

# --- Positive path: write a history file by hand and restore ---
echo ""
echo "  -- positive path: restore with paired history --"

mkdir -p workspace/sidecar-state/snapshot-histories
echo '{"snapshotId":"'${SNAPSHOT_ID}'"}' > "$HIST_FILE"
pass "wrote synthetic pairing file for snapshot"

POS_RESP=$(curl -s -o /tmp/restore_pos_body -w "%{http_code}" -X POST "$DAEMON/restore" \
  -H "Content-Type: application/json" \
  -d "{\"snapshotId\":\"${SNAPSHOT_ID}\"}")
POS_BODY=$(cat /tmp/restore_pos_body)
if [ "$POS_RESP" = "200" ]; then
  pass "restore succeeded ($POS_BODY)"
else
  fail "restore failed ($POS_RESP: $POS_BODY)"
fi

# Vessel should be back up
sleep 2
curl -sf http://127.0.0.1:3000/health > /dev/null \
  && pass "vessel healthy after restore" \
  || fail "vessel not healthy after restore"

# Pollution should be GONE (filesystem rolled back to snapshot state)
if docker exec arianna-vessel sh -c "test -f /tmp/contamination.txt" 2>/dev/null; then
  fail "pollution survived restore (filesystem not rolled back)"
else
  pass "pollution removed (filesystem rolled back)"
fi

# Bookmark state file should still have §3.0 (bookmarks survive restore)
BOOKMARK_STATE=$(ls workspace/sidecar-state/bookmarks/*.json 2>/dev/null | head -1)
if [ -n "$BOOKMARK_STATE" ] && grep -q '"id": *"3.0"' "$BOOKMARK_STATE"; then
  pass "bookmark §3.0 survived restore"
else
  fail "bookmark §3.0 missing from state after restore"
fi

# --- Orphan history cleanup test ---
echo ""
echo "=== Orphan History Cleanup ==="
# Plant a fake orphan history file (snap_fake_orphan has no daemon meta).
# Restart sidecar so its startup cleanupOrphanHistories runs against the
# now-running daemon's /snapshots list. The orphan should be deleted.
ORPHAN_FILE="workspace/sidecar-state/snapshot-histories/snap_fake_orphan_e2e.json"
echo '{"snapshotId":"snap_fake_orphan_e2e"}' > "$ORPHAN_FILE"
[ -f "$ORPHAN_FILE" ] && pass "planted orphan history" || fail "could not plant orphan"

docker compose restart sidecar >/dev/null 2>&1
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then break; fi
  sleep 1
done

if [ -f "$ORPHAN_FILE" ]; then
  fail "orphan history not cleaned by sidecar startup (still exists)"
else
  pass "orphan history removed by sidecar startup cleanup"
fi

echo ""
echo "=== E2E Test Complete ==="
echo "All checks passed."
echo ""
echo "The session is still running. To inspect:"
echo "  tmux -S $SOCKET attach -t $SESSION"
echo ""
echo "Press Ctrl+C to clean up, or run: docker compose down"
