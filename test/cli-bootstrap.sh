#!/usr/bin/env bash
# E2E smoke for the bootstrap-import features (#43 / day-1 OpenClaw demo path).
#
# Drives the @arianna.run/cli surface against a stub vessel that records every
# request it receives. Verifies:
#
#   1. profile create  → blank-canvas lobby copy on stdout (Filo voice + next-step hint)
#   2. profile import  → JSONL parsed, session_config.json + imported-messages.jsonl written,
#                        imported-variant lobby copy on stdout
#   3. talk            → auto-bootstrap fires before /chat (GET /status, POST /bootstrap)
#   4. bootstrap       → idempotent (second call is a no-op)
#
# No docker needed — the stub vessel is a tiny Node script bound to a random
# loopback port. The test doesn't exercise the daemon at all.
#
# Usage:
#   bash test/cli-bootstrap.sh
#
# Exit 0 on success. Non-zero on any failure (set -e).

set -euo pipefail
ARIANNA_REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ARIANNA_REPO"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

TMP="$(mktemp -d -t arianna-cli-bootstrap.XXXXXX)"
ARIANNA_HOME="$TMP/home"
REPO_ROOT="$TMP/repo"
mkdir -p "$ARIANNA_HOME" "$REPO_ROOT"
# docker-compose.yml marker so paths.ts walks up to REPO_ROOT.
echo "services: {}" > "$REPO_ROOT/docker-compose.yml"

# Pick a free port for the stub vessel.
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{process.stdout.write(String(s.address().port));s.close();})')"

STUB_LOG="$TMP/stub.log"
STUB_REQUESTS="$TMP/requests.jsonl"

# Tiny vessel stub: records every request as one JSONL line, responds
# /status with the current bootstrap flag, /bootstrap flips it and
# echoes ok, /chat streams a single text_delta + done frame.
node -e "
const http = require('http');
const fs = require('fs');
let bootstrapped = false;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    fs.appendFileSync('$STUB_REQUESTS', JSON.stringify({ method: req.method, url: req.url, body }) + '\n');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bootstrapped, aiName: 'tester' }));
    } else if (req.method === 'POST' && req.url === '/bootstrap') {
      bootstrapped = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'POST' && req.url === '/chat') {
      if (!bootstrapped) { res.writeHead(503); res.end('not bootstrapped'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {\"type\":\"text_delta\",\"delta\":\"hi\"}\n\n');
      res.write('data: {\"type\":\"done\"}\n\n');
      res.end();
    } else { res.writeHead(404); res.end('nope'); }
  });
});
server.listen($PORT, '127.0.0.1', () => fs.writeFileSync('$TMP/stub.pid', String(process.pid)));
" >"$STUB_LOG" 2>&1 &
STUB_BG=$!

cleanup() {
  if kill -0 "$STUB_BG" 2>/dev/null; then kill "$STUB_BG" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Wait for stub to be ready.
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then break; fi
  sleep 0.1
done

# Common env. ARIANNA_HOME is the per-machine config dir; resolveRepoRoot
# walks up from cwd, so we cd into REPO_ROOT before each invocation.
export ARIANNA_HOME
export VESSEL_BASE_URL="http://127.0.0.1:$PORT"
# DAEMON_BASE_URL is unused for these subcommands but harmless to set.
export DAEMON_BASE_URL="http://127.0.0.1:9999"

# Build @arianna.run/cli once so we can invoke its compiled bin from a
# temporary cwd. (`pnpm --filter ... start` must be run from inside the
# workspace, but our test cwd is a tmp dir that masquerades as a repo.)
( cd "$ARIANNA_REPO" && pnpm --silent --filter @arianna.run/types --filter @arianna.run/cli build ) > /dev/null

ARIANNA_BIN="$ARIANNA_REPO/packages/cli/bin/arianna.js"
ARIANNA() { ( cd "$REPO_ROOT" && node "$ARIANNA_BIN" "$@" ); }

bold "[1/4] profile create → blank-canvas lobby copy"
out=$(ARIANNA profile create alpha 2>&1)
echo "$out" | grep -q 'Created profile "alpha"' && ok "profile created" || { fail "profile create"; echo "$out"; exit 1; }
echo "$out" | grep -q 'Filo (lobby)' && ok "lobby copy printed" || { fail "no lobby copy"; echo "$out"; exit 1; }
echo "$out" | grep -q 'blank canvas' && ok "blank-canvas variant" || { fail "wrong variant"; exit 1; }
echo "$out" | grep -q 'arianna --profile alpha talk' && ok "next-step hint present" || { fail "no next-step"; exit 1; }
# Plain text — no ANSI escapes.
if printf '%s' "$out" | grep -q $'\x1b\['; then fail "lobby copy contains ANSI escapes"; exit 1; fi
ok "no ANSI in lobby copy"

bold "[2/4] talk → auto-bootstrap fires before /chat"
> "$STUB_REQUESTS"
out=$(ARIANNA --profile alpha talk "hello" 2>&1) || { fail "talk failed"; echo "$out"; exit 1; }
# Sequence: /status, /bootstrap, /chat — in that order.
# Extract the url field with node (avoids awk escaping headaches in heredoc).
seq=$(node -e '
const fs = require("fs");
for (const line of fs.readFileSync(process.argv[1], "utf-8").split("\n")) {
  if (!line.trim()) continue;
  try { console.log(JSON.parse(line).url); } catch {}
}
' "$STUB_REQUESTS")
expected=$'/status\n/bootstrap\n/chat'
if [ "$seq" = "$expected" ]; then
  ok "request order: /status → /bootstrap → /chat"
else
  fail "wrong request order. Got:"
  printf '%s\n' "$seq"
  exit 1
fi

bold "[3/4] bootstrap idempotency: second call is a no-op"
> "$STUB_REQUESTS"
out=$(ARIANNA --profile alpha bootstrap 2>&1)
echo "$out" | grep -qi 'already bootstrapped' && ok "already-bootstrapped message" || { fail "expected idempotency message"; echo "$out"; exit 1; }
# Only /status was hit — no second /bootstrap POST.
if grep -q '"url":"/bootstrap"' "$STUB_REQUESTS"; then
  fail "second bootstrap POSTed /bootstrap (should be no-op)"
  exit 1
fi
ok "no second /bootstrap POST"

bold "[4/4] profile import → imported-variant lobby + JSONL written"
FIXTURE="$REPO_ROOT/sample.jsonl"
cat > "$FIXTURE" <<'EOF'
{"type":"session","id":"s1"}
{"type":"message","id":"m1","message":{"role":"user","content":"yo"}}
{"type":"message","id":"m2","message":{"role":"assistant","content":"I am Asha.","provider":"anthropic","model":"claude-3-5"}}
EOF
out=$(ARIANNA profile import beta "$FIXTURE" 2>&1)
echo "$out" | grep -q 'Imported 2 messages' && ok "import summary" || { fail "no summary"; echo "$out"; exit 1; }
echo "$out" | grep -q 'Detected partner name: Asha' && ok "detected name surfaced" || { fail "no detected name"; exit 1; }
echo "$out" | grep -q 'imported partner' && ok "imported-variant lobby copy" || { fail "wrong variant"; exit 1; }

# Disk artifacts.
test -f "$REPO_ROOT/workspace/profiles/beta/session_config.json" && ok "session_config.json written" || { fail "no session_config"; exit 1; }
test -f "$REPO_ROOT/workspace/profiles/beta/imported-messages.jsonl" && ok "imported-messages.jsonl written" || { fail "no imported jsonl"; exit 1; }

bold "all checks passed."
