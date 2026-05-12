#!/usr/bin/env bash
# arianna.run release driver
#
# Idempotent automation for the npm + git-tag pieces of the release. The
# clawhub publish step + GitHub repo flip + GitHub release are operator-
# driven (see RELEASE_PLAN.md). This script handles only what is safe and
# reversible to automate.
#
# Modes:
#   ./release.sh --dry-run                Default. Build + gate + show what
#                                         would be published; no writes to
#                                         git, no writes to npm.
#   ./release.sh --publish                Real publish to npm. Still does
#                                         not git push or create a GitHub
#                                         release; those are manual.
#   ./release.sh --publish --push         Also push the version-bump
#                                         commit and the tag to origin.
#
# Flags:
#   --version <semver>   Force a specific version. Otherwise read from the
#                        first publishable package.json (@arianna/cli).
#   --bump <patch|minor|major>
#                        Bump the existing version by the given semver
#                        increment before publishing. Mutually exclusive
#                        with --version.
#   --skip-tests         Skip vitest + lint gate. NOT RECOMMENDED. The
#                        typecheck gate still runs.
#   -h, --help           Show this help.
#
# Exit codes:
#   0  success (dry-run completed, or publish completed)
#   1  pre-flight gate failed (clean tree, build, typecheck, test, lint)
#   2  npm publish failed (registry rejected, network, auth)
#   3  user input invalid (bad flag combo, bad version string)
#
# Pre-conditions:
#   - You are on the branch you intend to release from.
#   - git tree is clean (no uncommitted changes).
#   - `pnpm` is on PATH.
#   - `npm whoami` succeeds (for --publish mode).
#
# Post-conditions (--publish mode):
#   - @arianna/types, @arianna/cli, @arianna/tui published to npm at the
#     resolved version, with `--access public`.
#   - A version-bump commit is on HEAD.
#   - A git tag `v<version>` is created locally (pushed only if --push).
#   - `private: true` flips in publishable package.jsons are reverted.

set -euo pipefail

# ── parse args ─────────────────────────────────────────────────────────
MODE="dry-run"
PUSH="no"
FORCE_VERSION=""
BUMP=""
SKIP_TESTS="no"

usage() {
  sed -n '2,46p' "$0"   # echo back the header comment as --help
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  MODE="dry-run" ;;
    --publish)  MODE="publish" ;;
    --push)     PUSH="yes" ;;
    --version)  FORCE_VERSION="${2:-}"; shift ;;
    --bump)     BUMP="${2:-}"; shift ;;
    --skip-tests) SKIP_TESTS="yes" ;;
    -h|--help)  usage ;;
    *) echo "unknown flag: $1" >&2; exit 3 ;;
  esac
  shift
done

if [[ -n "$FORCE_VERSION" && -n "$BUMP" ]]; then
  echo "error: --version and --bump are mutually exclusive" >&2
  exit 3
fi
if [[ "$PUSH" == "yes" && "$MODE" != "publish" ]]; then
  echo "error: --push requires --publish (you'd be pushing a dry-run bump)" >&2
  exit 3
fi

# ── output helpers ─────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; GRAY=$'\033[90m'; RESET=$'\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; GRAY=''; RESET=''
fi
hdr()  { printf "\n%s━━━ %s ━━━%s\n\n" "$BOLD" "$*" "$RESET"; }
ok()   { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$*"; }
warn() { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$*"; }
err()  { printf "%s✗%s %s\n" "$RED" "$RESET" "$*" >&2; }
note() { printf "%s%s%s\n" "$GRAY" "$*" "$RESET"; }

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Packages that go to npm. Order matters: deps first.
PUBLISH_PKGS=(
  "packages/types"
  "packages/cli"
  "packages/host"
)

# ── pre-flight ─────────────────────────────────────────────────────────
hdr "pre-flight: release.sh ($MODE${PUSH:+, push=$PUSH})"

# Are we in a git repo?
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "not inside a git repository"
  exit 1
fi

# Clean tree?
if [[ -n "$(git status --porcelain)" ]]; then
  err "git tree is not clean — commit or stash first"
  git status --short
  exit 1
fi
ok "git tree clean"

# pnpm installed?
if ! command -v pnpm >/dev/null 2>&1; then
  err "pnpm not on PATH — install via \`npm i -g pnpm\` or corepack"
  exit 1
fi
ok "pnpm: $(pnpm --version)"

# npm auth (only for real publish)
if [[ "$MODE" == "publish" ]]; then
  if ! npm whoami >/dev/null 2>&1; then
    err "npm not logged in — run \`npm login\` first"
    exit 1
  fi
  ok "npm authenticated as: $(npm whoami)"
fi

# ── resolve target version ─────────────────────────────────────────────
CURRENT_VERSION="$(node -p "require('./packages/cli/package.json').version")"

if [[ -n "$FORCE_VERSION" ]]; then
  TARGET_VERSION="$FORCE_VERSION"
elif [[ -n "$BUMP" ]]; then
  case "$BUMP" in
    patch|minor|major)
      TARGET_VERSION="$(node -e "
        const [maj, min, pat] = require('./packages/cli/package.json').version.split('.').map(Number);
        const out = '$BUMP' === 'major' ? [maj+1, 0, 0]
                  : '$BUMP' === 'minor' ? [maj, min+1, 0]
                  : [maj, min, pat+1];
        console.log(out.join('.'));
      ")"
      ;;
    *) err "invalid --bump value: $BUMP (expected patch|minor|major)"; exit 3 ;;
  esac
else
  TARGET_VERSION="$CURRENT_VERSION"
fi

# Sanity check the resolved version is valid semver.
if [[ ! "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  err "invalid semver: $TARGET_VERSION"
  exit 3
fi

note "current version: $CURRENT_VERSION"
note "target version:  $TARGET_VERSION"

if [[ "$MODE" == "publish" && "$TARGET_VERSION" == "$CURRENT_VERSION" ]]; then
  warn "publishing without a version bump — npm will reject if this version is already on the registry"
fi

# ── install + build gate ───────────────────────────────────────────────
hdr "build + gate"

pnpm install --frozen-lockfile
ok "pnpm install"

pnpm typecheck
ok "typecheck"

if [[ "$SKIP_TESTS" == "no" ]]; then
  pnpm test
  ok "test"
  pnpm lint
  ok "lint"
else
  warn "skipping test + lint per --skip-tests"
fi

# Build every workspace package (publishable ones AND their deps).
pnpm -r --filter='@arianna/*' --filter='core' run build
ok "all package builds clean"

# ── version bump (commit) ──────────────────────────────────────────────
if [[ "$TARGET_VERSION" != "$CURRENT_VERSION" ]]; then
  hdr "version bump"
  for pkg in "${PUBLISH_PKGS[@]}"; do
    node -e "
      const fs = require('fs');
      const path = '$pkg/package.json';
      const j = JSON.parse(fs.readFileSync(path, 'utf-8'));
      j.version = '$TARGET_VERSION';
      fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
    "
    ok "$pkg → $TARGET_VERSION"
  done
  # Also bump the internal-only packages so the workspace stays in sync.
  for pkg in packages/sidecar packages/vessel; do
    node -e "
      const fs = require('fs');
      const path = '$pkg/package.json';
      const j = JSON.parse(fs.readFileSync(path, 'utf-8'));
      j.version = '$TARGET_VERSION';
      fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
    "
    ok "$pkg → $TARGET_VERSION (internal)"
  done

  if [[ "$MODE" == "publish" ]]; then
    git add -A
    git commit -m "chore(release): v$TARGET_VERSION"
    ok "committed version bump"
  else
    note "(dry-run: would commit chore(release): v$TARGET_VERSION)"
  fi
fi

# ── flip private:true on publishable packages ─────────────────────────
flip_private() {
  local pkg="$1" target="$2"
  node -e "
    const fs = require('fs');
    const p = '$pkg/package.json';
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (j.private !== undefined) j.private = $target;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  "
}

revert_private_flips() {
  hdr "reverting private:true flips"
  for pkg in "${PUBLISH_PKGS[@]}"; do
    flip_private "$pkg" true
    ok "$pkg: private:true restored"
  done
  # If we just committed, the on-disk private:true matches the working
  # tree but NOT what we committed. That's OK — the published artifact
  # is what we care about, and the commit already has private:false
  # baked in (which we WANT in the tag, so anyone replaying from the
  # tag can build). Actually no — we want the COMMIT to keep
  # private:true so that future devs don't accidentally publish. So
  # amend the commit with the private flips reverted.
  if [[ "$MODE" == "publish" && -n "$(git status --porcelain)" ]]; then
    git add -A
    git commit --amend --no-edit
    ok "amended release commit with private:true restored"
  fi
}

if [[ "$MODE" == "publish" ]]; then
  trap revert_private_flips EXIT
fi

hdr "flipping private:false for publish"
for pkg in "${PUBLISH_PKGS[@]}"; do
  flip_private "$pkg" false
  ok "$pkg: private:false"
done

# ── npm publish ────────────────────────────────────────────────────────
hdr "npm publish (mode=$MODE)"

if [[ "$MODE" == "dry-run" ]]; then
  for pkg in "${PUBLISH_PKGS[@]}"; do
    note "would run: pnpm --filter $(node -p "require('./$pkg/package.json').name") publish --access public --no-git-checks"
    ( cd "$pkg" && pnpm publish --access public --no-git-checks --dry-run )
    ok "$pkg (dry-run)"
  done
else
  for pkg in "${PUBLISH_PKGS[@]}"; do
    NAME="$(node -p "require('./$pkg/package.json').name")"
    note "publishing $NAME@$TARGET_VERSION"
    ( cd "$pkg" && pnpm publish --access public --no-git-checks )
    ok "$NAME published"
  done
fi

# ── git tag ────────────────────────────────────────────────────────────
TAG="v$TARGET_VERSION"

if [[ "$MODE" == "publish" ]]; then
  if git rev-parse "$TAG" >/dev/null 2>&1; then
    warn "tag $TAG already exists locally — skipping create"
  else
    git tag -a "$TAG" -m "arianna.run $TAG"
    ok "created tag $TAG"
  fi

  if [[ "$PUSH" == "yes" ]]; then
    git push origin HEAD
    git push origin "$TAG"
    ok "pushed branch + tag"
  else
    note "tag $TAG created locally; to push:"
    note "  git push origin HEAD"
    note "  git push origin $TAG"
  fi
fi

# ── post-publish hand-off (clawhub, GitHub release) ────────────────────
hdr "next steps (operator-driven)"

cat <<EOF
${BOLD}Remaining manual steps for v$TARGET_VERSION:${RESET}

  ${YELLOW}1.${RESET} GitHub release:
       gh release create $TAG --title "arianna.run $TAG" --notes-file <(echo "…")

  ${YELLOW}2.${RESET} clawhub: arianna-incubator skill
       clawhub skill publish openclaw-skill/arianna-incubator \\
         --slug arianna-incubator \\
         --version $TARGET_VERSION \\
         --changelog "v$TARGET_VERSION release" \\
         --dry-run    # always dry-run first
       # then drop --dry-run

  ${YELLOW}3.${RESET} Integration skills (pi-integration, openclaw-integration):
       Live in their own repos. See RELEASE_PLAN.md § "Channel D".

  ${YELLOW}4.${RESET} Repo visibility:
       If this is the launch tag, flip the GitHub repo to public.

  ${YELLOW}5.${RESET} Smoke test on a clean box:
       curl -fsSL https://arianna.run/install | bash
       arianna-tui
EOF

ok "release.sh done"
