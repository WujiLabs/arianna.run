#!/usr/bin/env bash
# arianna.run installer
#
#   curl -fsSL https://arianna.run/install | bash
#
# Source of truth:
#   https://raw.githubusercontent.com/wujilabs/arianna.run/main/install.sh
#
# Idempotent — safe to re-run for updates. Detects docker, docker compose,
# and Node 20+; clones the repo to ~/.arianna/repo/ (or `git pull --ff-only`
# if already present); installs @arianna/cli + @arianna/tui globally; creates
# a default profile; runs the first vessel/sidecar build.
#
# After install, run `arianna-tui` from anywhere to launch the game.

set -euo pipefail

INSTALL_URL="https://arianna.run/install"
REPO_URL="https://github.com/wujilabs/arianna.run.git"
ARIANNA_HOME="${ARIANNA_HOME:-$HOME/.arianna}"
ARIANNA_REPO_DIR="$ARIANNA_HOME/repo"
NPM_PACKAGES=("@arianna/cli" "@arianna/tui")
MIN_NODE_MAJOR=20

# ── output helpers ────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GRAY=$'\033[90m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  RED=$'\033[31m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  GRAY='' GREEN='' YELLOW='' RED='' BOLD='' RESET=''
fi

say()  { printf "%s\n" "$*"; }
ok()   { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$*"; }
warn() { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$*"; }
err()  { printf "%s✗%s %s\n" "$RED" "$RESET" "$*" >&2; }
note() { printf "%s%s%s\n" "$GRAY" "$*" "$RESET"; }
hdr()  { printf "\n%s━━━ %s ━━━%s\n\n" "$BOLD" "$*" "$RESET"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

abort() {
  err "$*"
  exit 1
}

# ── platform detection ────────────────────────────────────────────────────
PLATFORM=$(uname -s 2>/dev/null || echo "Unknown")

# ── steps ─────────────────────────────────────────────────────────────────

hdr "arianna.run installer"

# 1. docker
if require_cmd docker; then
  ok "docker found ($(docker --version 2>/dev/null | head -1))"
else
  err "docker not found"
  case "$PLATFORM" in
    Darwin)
      note "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
      ;;
    Linux)
      note "Install Docker Engine: https://docs.docker.com/engine/install/"
      ;;
    *)
      note "See https://docs.docker.com/get-docker/"
      ;;
  esac
  exit 1
fi

# 2. docker compose plugin (v2)
if docker compose version >/dev/null 2>&1; then
  ok "docker compose plugin found ($(docker compose version --short 2>/dev/null || echo unknown))"
else
  err "docker compose plugin missing — arianna requires Compose v2"
  note "Install instructions: https://docs.docker.com/compose/install/"
  exit 1
fi

# 3. node >= 20
if require_cmd node && require_cmd npm; then
  NODE_VERSION=$(node --version 2>/dev/null || echo "v0.0.0")
  NODE_MAJOR=${NODE_VERSION#v}
  NODE_MAJOR=${NODE_MAJOR%%.*}
  # Pre-release strings like "22-rc1" or "22~next" would crash the numeric
  # comparison below. Treat anything non-numeric as unknown and fail loud.
  if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]]; then
    err "could not parse node version: $NODE_VERSION"
    note "arianna requires Node $MIN_NODE_MAJOR+; install from https://nodejs.org/"
    exit 1
  fi
  if [[ "$NODE_MAJOR" -lt $MIN_NODE_MAJOR ]]; then
    err "node $NODE_VERSION is too old; arianna requires Node $MIN_NODE_MAJOR+"
    note "Install via your package manager or from https://nodejs.org/"
    exit 1
  fi
  ok "node $NODE_VERSION found"
else
  err "node + npm not found"
  note "Install Node.js $MIN_NODE_MAJOR+ from https://nodejs.org/"
  exit 1
fi

# 4. ensure docker daemon is reachable (clearer error than build-time failure)
if ! docker info >/dev/null 2>&1; then
  err "docker daemon not reachable — start Docker and re-run"
  case "$PLATFORM" in
    Darwin)
      note "Open Docker Desktop and wait for the whale icon to settle."
      ;;
    Linux)
      note "Start the docker service: \`sudo systemctl start docker\`"
      ;;
  esac
  exit 1
fi
ok "docker daemon reachable"

# 5. canonical repo at ~/.arianna/repo/
hdr "fetching arianna repo"
mkdir -p "$ARIANNA_HOME"
if [[ -d "$ARIANNA_REPO_DIR/.git" ]]; then
  ok "found existing checkout at $ARIANNA_REPO_DIR"
  if git -C "$ARIANNA_REPO_DIR" pull --ff-only >/dev/null 2>&1; then
    ok "fast-forwarded to latest main"
  else
    warn "could not fast-forward — leaving local state intact"
    note "Inspect with \`git -C $ARIANNA_REPO_DIR status\` if needed."
  fi
else
  if git clone --depth 1 "$REPO_URL" "$ARIANNA_REPO_DIR"; then
    ok "cloned $REPO_URL → $ARIANNA_REPO_DIR"
  else
    err "could not clone $REPO_URL"
    note "If the repo is private, ensure your GitHub credentials are set up."
    note "See https://arianna.run for alternatives."
    exit 1
  fi
fi

# 6. global npm install
hdr "installing arianna packages"
say "running: npm install -g ${NPM_PACKAGES[*]}"
if npm install -g "${NPM_PACKAGES[@]}"; then
  ok "${NPM_PACKAGES[*]} installed globally"
else
  err "npm install failed"
  note "Try \`sudo npm install -g ${NPM_PACKAGES[*]}\` if a permissions error blocks the global prefix."
  note "Or use a Node version manager (fnm, asdf, nvm) so npm doesn't need sudo."
  exit 1
fi

# Sanity check the binaries are on PATH.
if ! require_cmd arianna || ! require_cmd arianna-tui; then
  warn "global install succeeded but binaries are not on PATH"
  # `npm bin -g` was removed in npm 9. Use `npm prefix -g` (or its config
  # equivalent) and append /bin to compute the global bin dir on every
  # supported npm version.
  NPM_PREFIX=$(npm prefix -g 2>/dev/null || npm config get prefix 2>/dev/null || true)
  if [[ -n "$NPM_PREFIX" ]]; then
    note "Add this to your shell rc (.zshrc / .bashrc):"
    note "  export PATH=\"$NPM_PREFIX/bin:\$PATH\""
  fi
fi

# 7. profile state. We DON'T auto-create a default profile here —
#    `arianna profile current` always returns *something* (falling back to
#    "implicit-default" when nothing is registered), and registering an
#    explicit "default" profile would route the daemon to per-profile paths
#    while the unmigrated host TUI still reads/writes the legacy locations
#    (workspace/session_config.json, workspace/snapshots/). Leaving the
#    registry empty means the legacy single-tenant flow Just Works on first
#    run; users opt into multi-profile semantics later via
#    `arianna profile create <name>`.
hdr "profile state"
PROFILE_CURRENT=$(arianna profile current 2>/dev/null || true)
if echo "$PROFILE_CURRENT" | grep -qE '\(source: (config-default|env)\)'; then
  ok "profile already configured: $(echo "$PROFILE_CURRENT" | head -1)"
else
  ok "no named profile configured — using legacy single-tenant default"
  note "Run \`arianna profile create <name>\` later to opt into multi-profile semantics."
fi

# 8. first build
hdr "building vessel + sidecar (this takes a few minutes the first time)"
( cd "$ARIANNA_REPO_DIR" && docker compose build ) || \
  abort "docker compose build failed — see output above"
ok "build complete"

# 9. final summary
hdr "installed"
say "Run any of these from anywhere:"
note "  arianna-tui              # launch the TUI against the default profile"
note "  arianna profile list     # show configured profiles"
note "  arianna talk \"hi\"        # send a message to the running stack"
note "  arianna events --follow  # stream sidecar events as JSON"
say ""
note "Repo:    $ARIANNA_REPO_DIR"
note "Config:  $ARIANNA_HOME/config"
note "Update:  curl -fsSL $INSTALL_URL | bash"
say ""
