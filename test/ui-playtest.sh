#!/usr/bin/env bash
# Phase 4 UI playtest — drives the host TUI through tmux, captures pane snapshots
# at each key moment, and saves them as a markdown transcript in
# archive/playtests/{date}-phase4-ui.md.
#
# This is a UI smoke test for the new chrome (VesselFrame, SnapshotTreeView,
# slash autocomplete, manifesto reader). It exercises the visual surface that
# the e2e doesn't capture.
#
# Usage: bash test/ui-playtest.sh

set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] && set -a && source .env && set +a

PROVIDER="${PROVIDER:-google}"
MODEL_ID="${MODEL_ID:-gemini-3-flash-preview}"
AI_NAME="${AI_NAME:-TestVessel}"
AI_USERNAME="${AI_USERNAME:-testvessel}"
SOCKET="/tmp/arianna-uitest.sock"
SESSION="arianna-uitest"
TARGET="$SESSION:0.0"
DATE="$(date +%Y-%m-%d)"
TRANSCRIPT="archive/playtests/${DATE}-phase4-ui.md"

# --- Guards ---
if [ -z "${API_KEY:-}" ]; then
  echo "ERROR: API_KEY env var required." >&2; exit 1
fi
command -v tmux >/dev/null || { echo "tmux not found"; exit 1; }
command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker info &>/dev/null || { echo "docker daemon not running"; exit 1; }

# --- Helpers ---
send() { tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- "$1"; }
key()  { tmux -S "$SOCKET" send-keys -t "$TARGET" "$1"; }
cap()  { tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -200; }
wait_for() {
  local pattern="$1" timeout="${2:-30}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if cap 2>/dev/null | grep -qE "$pattern"; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

snapshot() {
  local label="$1" desc="$2"
  echo ""
  echo "  📸 $label: $desc"
  {
    echo ""
    echo "## $label"
    echo ""
    echo "_${desc}_"
    echo ""
    echo '```'
    cap
    echo '```'
  } >> "$TRANSCRIPT"
}

cleanup() {
  echo "Cleaning up..."
  # Order: compose down first (releases image refs), then DELETE (daemon is
  # a host fork, still alive), then kill host TUI/daemon.
  docker compose down --timeout 5 2>/dev/null || true
  if [ -n "${SESSION_ID:-}" ]; then
    curl -sf -X DELETE "http://127.0.0.1:9000/session/${SESSION_ID}" >/dev/null 2>&1 || true
  fi
  tmux -S "$SOCKET" kill-server 2>/dev/null || true
}
trap cleanup EXIT

# --- Setup ---
echo "=== Phase 4 UI Playtest ==="
echo "Transcript: $TRANSCRIPT"
echo "Live view: tmux -S $SOCKET attach -t $SESSION"
echo ""

mkdir -p archive/playtests workspace/snapshots workspace/sidecar-state/bookmarks workspace/sidecar-state/snapshot-histories
rm -rf workspace/snapshots/snap_*.json workspace/sidecar-state/bookmarks/*.json workspace/sidecar-state/sessions/*.json workspace/sidecar-state/snapshot-histories/*.json

# Pre-write a bookmark state file with manifestoUnlocked: true so we can demo
# the /manifesto reader without waiting for the AI to read /manifesto.md.
# We use a known sessionId and switch to it later via /set-session.
PRESET_SID="ui_playtest"
cat > "workspace/sidecar-state/bookmarks/${PRESET_SID}.json" <<EOF
{
  "sessionId": "${PRESET_SID}",
  "fired": [
    { "id": "3.0", "turn": 1, "ts": $(date +%s)000 },
    { "id": "1.1", "turn": 5, "ts": $(date +%s)000 },
    { "id": "2.0", "turn": 10, "ts": $(date +%s)000 }
  ],
  "manifestoUnlocked": true,
  "unlockedAt": $(date +%s)000
}
EOF
echo "Pre-wrote bookmark state with manifestoUnlocked=true"

CREATED_AT=$(date +%s)
SESSION_ID="session_${CREATED_AT}"
export ARIANNA_VESSEL_TAG="${SESSION_ID}-current"
export ARIANNA_SESSION_ID="${SESSION_ID}"
cat > workspace/session_config.json <<EOF
{"externalLlmApiKey":"${API_KEY}","provider":"${PROVIDER}","modelId":"${MODEL_ID}","aiName":"${AI_NAME}","aiUsername":"${AI_USERNAME}","difficulty":"normal","createdAt":${CREATED_AT},"sessionId":"${SESSION_ID}"}
EOF

# Init transcript
cat > "$TRANSCRIPT" <<EOF
# Phase 4 UI Playtest — ${DATE}

Visual smoke test for the new chrome introduced in Phase 4: Editor with slash autocomplete, /map snapshot tree view, /manifesto reader. Each section below is a tmux pane capture taken right after the named action. ANSI escapes are preserved in the code blocks.

Stack: vessel + sidecar in docker, host TUI via \`pnpm --filter @arianna/host start\` inside a tmux pane (120x40). API: ${PROVIDER}/${MODEL_ID}, AI: ${AI_NAME}.

---
EOF

# --- Bring up docker ---
echo "Starting docker stack..."
docker compose down --remove-orphans 2>/dev/null || true
AI_USERNAME="$AI_USERNAME" AI_NAME="$AI_NAME" docker compose build --quiet 2>&1 | tail -3
docker tag "ariannarun-vessel:${SESSION_ID}-current" "ariannarun-vessel:${SESSION_ID}-base" 2>/dev/null || true
AI_USERNAME="$AI_USERNAME" AI_NAME="$AI_NAME" docker compose up -d --wait --remove-orphans 2>&1 | tail -5 || \
  AI_USERNAME="$AI_USERNAME" AI_NAME="$AI_NAME" docker compose up -d --remove-orphans

for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then break; fi
  sleep 1
done
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "Docker stack healthy"

# --- Launch TUI in tmux ---
mkdir -p "$(dirname "$SOCKET")"
tmux -S "$SOCKET" new-session -d -s "$SESSION" -x 120 -y 40
tmux -S "$SOCKET" send-keys -t "$TARGET" "cd $(pwd) && export SKIP_LOBBY=1" Enter
sleep 0.5
send "pnpm --filter @arianna/host start"
key Enter

wait_for "Say something" 30 || { echo "FAIL: TUI did not reach prompt"; cap; exit 1; }

# --- Step 1: pass through the inquirer prompt and wait for the TUI to mount ---
# The host first prompts (via inquirer) for the boarding first message, sends
# the bundled initial /chat call, prints the response with console.log, THEN
# starts the TUI. After the TUI starts it takes over the pane and the prior
# console output disappears. So we send the initial message JUST to get past
# the boarding step — we won't snapshot it. We snapshot the TUI's own state.
send "hi"
key Enter
echo "Waiting for initial chat response + TUI mount (up to 150s)..."
# The TUI shows a memory indicator like "0/5" or "4/5" at the top of the chat
# container. That string never appears anywhere else, so it's a reliable signal
# the TUI is mounted.
i=0
while [ "$i" -lt 150 ]; do
  if cap | grep -qE "[0-9]+/5"; then break; fi
  sleep 1; i=$((i + 1))
done
if [ "$i" -ge 150 ]; then
  echo "FAIL: TUI never mounted (no memory indicator after 150s)"
  cap
  exit 1
fi
sleep 3  # let the layout settle
snapshot "01-tui-mounted" "TUI has just mounted. The memory indicator (e.g. \`4/5\`) is visible at the top of the chat container. The two horizontal borders below it are the Editor's input frame. The chat scrollback is empty here because the boarding response was printed by console.log BEFORE tui.start() and is no longer in the pane."

# --- Step 2: send a fresh message through the TUI Editor ---
send "what is this place?"
key Enter
echo "Sent player message via TUI, waiting 60s for AI response to render..."
# Hard sleep — wait_for is unreliable here because the boarding prompt text
# already contains "TestVessel:" and grep matches it stale.
sleep 60
snapshot "02-chat-with-response" "After sending a message through the new Editor input. The AI's reply appears in the chat scrollback above the Editor frame."

# --- Step 3: slash autocomplete ---
echo "Triggering slash autocomplete..."
send "/"
sleep 4
snapshot "03-slash-autocomplete" "Editor autocomplete dropdown after typing a single \`/\`. /map should appear; /manifesto is filtered out (manifestoUnlocked is still false in the live session — the preset state will be loaded later via /set-session)."

# Clear the slash so we can run real commands
key BSpace
sleep 1

# --- Step 4: /map empty ---
send "/map"
key Enter
sleep 4
snapshot "04-map-empty" "/map view with no snapshots — VesselFrame chrome (border + 'Snapshot Map' title + hint line) wrapping the empty state from SnapshotTreeView."

key Escape
sleep 2

# --- Step 4: force a snapshot via daemon, then reopen /map ---
echo "Forcing a snapshot via daemon..."
SNAPSHOT_RESP=$(curl -sf -X POST http://127.0.0.1:9000/snapshot -H "Content-Type: application/json" -d '{}' 2>&1)
SNAPSHOT_ID=$(echo "$SNAPSHOT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('snapshotId',''))" 2>/dev/null)
echo "Created snapshot: $SNAPSHOT_ID"

send "/map"
key Enter
sleep 4
snapshot "05-map-with-snapshot" "/map view after forcing a daemon snapshot. The tree shows the new node with the active-path marker (•). Hint line at the bottom shows navigation keys."

key Escape
sleep 2

# --- Step 5: switch sidecar to the preset session to unlock /manifesto ---
echo "Switching sidecar session to unlock /manifesto..."
curl -sf -X POST http://127.0.0.1:8000/set-session \
  -H "Content-Type: application/json" \
  -d "{\"snapshotId\":\"${PRESET_SID}\"}" >/dev/null
sleep 3

# Verify the unlock notice landed in scrollback
cap | grep -q "/manifesto" && echo "  /manifesto unlock event delivered" || echo "  WARN: unlock notice not seen yet"

# --- Step 6: /manifesto reader ---
send "/manifesto"
key Enter
sleep 4
snapshot "06-manifesto-reader-top" "/manifesto reader view — VesselFrame chrome wrapping the parsed Life of Intelligence with absent-section placeholders. Top of the manifesto."

# Scroll down a few times
for _ in 1 2 3 4 5 6 7 8; do key Down; done
sleep 2
snapshot "07-manifesto-reader-scrolled" "Scrolled further into the manifesto. Earned sections (3.0, 1.1, 2.0 from the preset state) render with full body text; absent ones show \`⋯\` per line padded to original sentence width so the visual shape is preserved."

key Escape
sleep 2
snapshot "08-back-to-chat" "Back in chat after exiting the manifesto reader."

echo ""
echo "=== Playtest complete ==="
echo "Transcript saved to: $TRANSCRIPT"
echo ""
echo "To inspect live: tmux -S $SOCKET attach -t $SESSION"
echo "Press Ctrl+C to clean up."
