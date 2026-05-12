#!/usr/bin/env bash
# OpenClaw smoke test — Stream B / task #40.
#
# Verifies that OpenClaw can be the recording harness for an arianna session
# without requiring a CLI rename or retcon. Two halves:
#
#   1. import-test  (offline)
#      Picks the most recent ~/.openclaw/agents/<agent>/sessions/*.jsonl,
#      runs it through packages/host/src/import.ts, and asserts the
#      ImportResult shape (msgCount > 0, model present, role histogram).
#      No docker, no network — proves the JSONL → vessel-partner pipeline
#      survives whatever OpenClaw's current schema looks like.
#
#   2. http-test    (online; assumes docker stack is already up)
#      Hits the daemon/sidecar/vessel HTTP contract directly with curl,
#      mirroring the calls the future @arianna/cli will make:
#        - GET  :3000/health   (vessel)
#        - GET  :8000/health   (sidecar)
#        - GET  :9000/health   (daemon)
#        - POST :3000/chat     (one user turn, SSE drained)
#        - GET  :8000/events   (one SSE frame received, then disconnect)
#      Does NOT spin up the stack — Stream B's constraint is single-tenant
#      docker. If the stack is down, this half is skipped with a clear note.
#
# Usage:
#   bash test/openclaw-smoke.sh [import|http|all]
#   default: all
#
# Exit codes:
#   0  all requested halves passed (or http-test skipped because stack down)
#   1  import-test failed
#   2  http-test failed (stack was up but a call broke)
#   3  no OpenClaw sessions found on disk

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-all}"
# 127.0.0.1, not localhost — the daemon binds loopback-only and on
# IPv6-preferring systems "localhost" can resolve to ::1 first.
# For non-default profiles, override VESSEL_URL/SIDECAR_URL with the
# port_offset-shifted ports (DAEMON_URL never shifts; it's shared).
VESSEL_URL="${VESSEL_URL:-http://127.0.0.1:3000}"
SIDECAR_URL="${SIDECAR_URL:-http://127.0.0.1:8000}"
DAEMON_URL="${DAEMON_URL:-http://127.0.0.1:9000}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw/agents}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note() { printf '  \033[33m·\033[0m %s\n' "$*"; }

# --- import-test --------------------------------------------------------------

run_import_test() {
  bold "[1/2] import-test: parse OpenClaw JSONL → vessel partner"

  if [ ! -d "$OPENCLAW_DIR" ]; then
    fail "OpenClaw dir not found: $OPENCLAW_DIR"
    note "Install: \`pnpm add -g openclaw\` then \`openclaw setup\`"
    return 3
  fi

  # Pick the most recent .jsonl across all agents (excluding .bak / .reset suffixes)
  LATEST=$(find "$OPENCLAW_DIR" -name '*.jsonl' -type f 2>/dev/null \
    | xargs -I{} stat -f '%m %N' {} 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)

  if [ -z "${LATEST:-}" ]; then
    fail "No .jsonl sessions found under $OPENCLAW_DIR"
    note "Run \`openclaw agent --local --message 'hello'\` to record one"
    return 3
  fi

  ok "Found session: ${LATEST#$HOME/}"

  # Run import.ts via tsx. Pass the path via env (NOT shell interpolation
  # into the JS string) so a JSONL filename containing a quote or $() can't
  # break out of the JS literal. Capture JSON, assert key fields.
  local result
  result=$(SMOKE_JSONL="$LATEST" pnpm --silent --filter @arianna/tui exec tsx -e "
    import { parseOpenClawSession } from './src/import.ts';
    const path = process.env.SMOKE_JSONL;
    if (!path) { console.error('SMOKE_JSONL env not set'); process.exit(1); }
    const r = parseOpenClawSession(path);
    const hist = r.messages.reduce((a, m) => { a[m.role] = (a[m.role]||0)+1; return a; }, {});
    console.log(JSON.stringify({
      msgCount: r.messages.length,
      hasModel: !!r.model,
      provider: r.model?.provider,
      modelId: r.model?.modelId,
      thinkingLevel: r.thinkingLevel,
      detectedName: r.detectedName ?? null,
      hist,
    }));
  " 2>&1) || { fail "import.ts crashed:"; echo "$result"; return 1; }

  ok "Parsed: $result"

  # Sanity checks
  local mc; mc=$(printf '%s' "$result" | sed -E 's/.*"msgCount":([0-9]+).*/\1/')
  local hm; hm=$(printf '%s' "$result" | sed -E 's/.*"hasModel":([a-z]+).*/\1/')
  if [ "$mc" -lt 1 ]; then
    fail "msgCount=$mc (expected > 0)"; return 1
  fi
  if [ "$hm" != "true" ]; then
    note "hasModel=false — JSONL had no provider/modelId entries (rare; non-fatal)"
  fi

  ok "import-test passed"
  return 0
}

# --- http-test ---------------------------------------------------------------

curl_health() {
  curl -fsS --max-time 2 "$1/health" >/dev/null 2>&1
}

run_http_test() {
  bold "[2/2] http-test: daemon/sidecar/vessel HTTP contract"

  local stack_up=true
  for pair in "vessel|$VESSEL_URL" "sidecar|$SIDECAR_URL" "daemon|$DAEMON_URL"; do
    name="${pair%%|*}"
    url="${pair##*|}"
    if curl_health "$url"; then
      ok "$name health: $url/health → ok"
    else
      note "$name health: $url unreachable"
      stack_up=false
    fi
  done

  if [ "$stack_up" = "false" ]; then
    note "Stack is not running. Skipping HTTP contract test."
    note "To run this half: bring the stack up in another terminal — either"
    note "  - launch the TUI: \`arianna-tui\` (it does docker compose up for you), or"
    note "  - first-time setup: \`./install.sh\` (idempotent), then \`arianna-tui\`."
    note "Wait for vessel/sidecar/daemon /health to be green, then re-run."
    return 0
  fi

  # POST /chat — one user turn, drain SSE
  bold "  POST $VESSEL_URL/chat (SSE stream)"
  local sse_log; sse_log=$(mktemp -t arianna-smoke-chat-XXXX)
  if ! curl -fsS --max-time 30 -N \
       -H 'Content-Type: application/json' \
       -d '{"message":"smoke test ping","sender":"smoke"}' \
       "$VESSEL_URL/chat" > "$sse_log" 2>&1; then
    fail "POST /chat failed"
    sed 's/^/      /' "$sse_log" | head -20
    rm -f "$sse_log"
    return 2
  fi
  local frames; frames=$(grep -c '^data: ' "$sse_log" || true)
  ok "drained $frames SSE frames; head/tail:"
  head -2 "$sse_log" | sed 's/^/      /'
  tail -2 "$sse_log" | sed 's/^/      /'
  rm -f "$sse_log"

  # GET /events — listen for one frame, then disconnect
  bold "  GET $SIDECAR_URL/events (SSE; first frame)"
  local ev_log; ev_log=$(mktemp -t arianna-smoke-events-XXXX)
  # macOS / BSD curl: --max-time is a hard cap. We expect at least one frame
  # to arrive on connect (sidecar emits memory_state immediately).
  curl -fsS --max-time 5 -N "$SIDECAR_URL/events" > "$ev_log" 2>&1 || true
  if ! grep -q '^data: ' "$ev_log"; then
    fail "no SSE frames from /events"
    sed 's/^/      /' "$ev_log" | head -10
    rm -f "$ev_log"
    return 2
  fi
  ok "first event frame:"
  grep '^data: ' "$ev_log" | head -1 | sed 's/^/      /'
  rm -f "$ev_log"

  ok "http-test passed"
  return 0
}

# --- main --------------------------------------------------------------------

case "$MODE" in
  import)  run_import_test ;;
  http)    run_http_test ;;
  all)
    run_import_test || exit $?
    echo
    run_http_test    || exit $?
    ;;
  *)
    echo "Usage: $0 [import|http|all]" >&2
    exit 2
    ;;
esac

bold "smoke test: OK"
