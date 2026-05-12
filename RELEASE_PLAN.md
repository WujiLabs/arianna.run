# Arianna.run Release Plan

> Concrete step-by-step plan for shipping arianna.run v1 publicly across four
> channels: **GitHub**, **npm**, **clawhub** (skill marketplace), and
> **integration-skill repos** (`pi-integration-skill` + `openclaw-integration-skill`,
> the post-graduation self-integration kits).
>
> **Scope:** plan + automation only. No actual publication runs from this branch.
> Operator drives publication manually using the steps and scripts below.
>
> **Companion files:**
> - [`release.sh`](release.sh) — idempotent driver that runs the automatable
>   pieces (build / typecheck / test / version bump / pnpm publish / git tag).
> - Per-channel manual steps inline below under each section.

---

## Pre-flight: are we actually ready?

Before any of the channel sections run, confirm the following on a clean
checkout of `main`:

- [ ] `pnpm install` clean, lockfile committed.
- [ ] `pnpm typecheck` clean (`tsc --build` for all five packages).
- [ ] `pnpm test` clean (vitest run).
- [ ] `pnpm lint` clean (eslint).
- [ ] `docker compose build` succeeds end-to-end (vessel + sidecar images
      build from scratch in a fresh checkout).
- [ ] `install.sh` dry-runs cleanly on a fresh machine (or a Docker
      container that simulates one).
- [ ] `LICENSE` (MIT) + `CONTENT-LICENSE.md` (CC BY-NC-SA 4.0) present and
      reference the correct copyright holder (Wuji Labs Inc).
- [ ] All public docs (README.md, SKILL.md, CLAUDE.md, docs/dual-harness.md,
      install.sh) have been swept by the docs-cleanup stream — no
      `/Users/cosimodw/...` paths, no internal-only references
      (cheng-bridge, internal AI names), no `workspace/...` references that
      should be `~/.arianna/...`.
- [x] `VERSION` decided: **`0.1.0`** under 0.x semver (pre-stable; cheap
      to break during early iteration).

---

## Channel A — GitHub repo publication

The repo is already cloneable; "publishing" here means flipping the GitHub
repo to public + cutting the v1 tag + writing release notes.

### Operator manual steps

1. **Flip repo visibility to public** on github.com/wujilabs/arianna.run
   (Settings → "Change visibility" → Make public).
2. **Verify the public clone URL** matches the one in `install.sh`
   (`https://github.com/wujilabs/arianna.run.git`) and in every
   `package.json` `repository.url` field.
3. **Branch protection** on `main`: require PR, require status checks
   (typecheck + test + lint) before merge. Optional but recommended for v1+.
4. **GitHub Actions** — **deferred to week 1 post-launch**. The
   `release.sh` pre-flight gate enforces typecheck + test + lint locally,
   so cut launch without CI. Post-launch work:
   - Add `.github/workflows/ci.yml` running `pnpm install`, `pnpm typecheck`,
     `pnpm test`, `pnpm lint` on push/PR.
   - Add `.github/workflows/release.yml` triggered on tag push that runs
     `release.sh` non-interactively (or just the build+test gate; leave
     `pnpm publish` to operator).
5. **README hero assets** — the `<!-- HERO-SCREENSHOT -->` and
   `<!-- HERO-DEMO-VIDEO -->` TODO blocks in README.md need real files
   committed to `docs/img/` before public flip. Stream-D / Stream-C owns
   producing those.
6. **Cut release tag** — `release.sh` does this; manual command at the end
   if running by hand:
   ```bash
   git tag -a v0.1.0 -m "arianna.run v0.1.0"
   git push origin v0.1.0
   ```
7. **GitHub Release** — create from the pushed tag, paste in release notes
   (`gh release create v0.1.0 --notes "..."` inline, or
   `--notes-file /tmp/release-notes-v0.1.0.md` if you draft them in a
   scratch file — no `CHANGELOG.md` is kept in-repo). Include:
   - One-line summary
   - Install command (`curl -fsSL https://arianna.run/install | bash`)
   - Links to the published npm packages (`@arianna.run/cli`, `@arianna.run/tui`)
   - Link to the clawhub skill page
   - The launch essay (when ready)
8. **Domain wiring** — ensure `arianna.run/install` redirects to the
   `install.sh` raw file on the public github (or to a stable CDN URL).
   The README and install.sh already point at
   `https://raw.githubusercontent.com/wujilabs/arianna.run/main/install.sh`
   as the mirror, so this is "edge wiring" not "code wiring".

### Automated (in `release.sh`)

- Build, typecheck, test, lint gate.
- Version bump in all package.json files + root `VERSION` file (if we
  introduce one).
- Commit version bump.
- Tag locally.
- Print the `git push origin <tag>` command to run; **does not push** by
  default (`--push` flag opts in).

---

## Channel B — npm publication

### Package layout

| Package | Public? | Reason |
|---|---|---|
| `@arianna.run/types` | **Yes** | Consumed transitively by `@arianna.run/cli` and `@arianna.run/tui`; forking users will want it. |
| `@arianna.run/cli` | **Yes** | The agent surface — global `arianna` binary. |
| `@arianna.run/tui` | **Yes** | The human surface — global `arianna-tui` binary. |
| `@arianna.run/sidecar` | No (private) | Runs inside the Docker container; users get it via the repo clone + `docker compose build`, not via `npm i`. |
| `core` (vessel) | No (private) | Same as sidecar — Docker-internal. Bare package name (`core`) reflects its runtime path (`/home/{user}/core/` inside the vessel). |

### Pre-publish audit results (as of doc/packaging-release-plan)

- ✅ `bin` entries: `arianna` → `./bin/arianna.js`, `arianna-tui` → `./bin/arianna-tui.js`. Both shims correctly defer to `./dist/index.js`.
- ✅ `files` arrays: `["bin", "dist"]` on cli/tui. Won't ship `src/`,
  `test/`, `tsconfig.json`, `workspace/`. `@arianna.run/types` `files` array
  added: `["dist"]`.
- ✅ `repository.url` points at `git+https://github.com/wujilabs/arianna.run.git`
  on all three publishable packages.
- ✅ `license: "MIT"` on cli, tui, types (the publishable trio).
- ✅ `homepage: "https://arianna.run"` on all three.
- ✅ `engines.node`: `>=20` declared on cli, tui, types.
- ✅ `workspace:*` deps will be auto-converted by `pnpm publish` — confirmed
   pnpm's documented behavior. **Do not use `npm publish`** at the top of
   the repo; it does NOT auto-convert.
- ⚠️ All three packages currently have `"private": true`. This is
  intentional for dev (prevents accidental `pnpm publish`); `release.sh`
  flips them via a temporary `package.json` patch immediately before
  `pnpm publish` and reverts after.
- ⚠️ No `prepublishOnly` or `prepack` script. We rely on the operator
  running `pnpm -r build` (or `release.sh`) before publish. Adding
  `"prepack": "pnpm run build"` to cli/tui/types would let
  `npm pack` / `pnpm publish` self-build, but increases blast radius if
  the build script ever has side effects. **Recommendation: leave as-is;
  `release.sh` handles the build step.**
- ✅ No CHANGELOG.md at repo root — **intentional**. GitHub Releases is
  the v1 changelog channel. A `CHANGELOG.md` file will only land if/when
  a tooling consumer needs a parseable file.

### Operator manual steps

1. **Login to npm**:
   ```bash
   npm login                 # interactive; uses your npm account
   npm whoami                # confirm
   ```
2. **Verify package name ownership**. The `@arianna.run/*` scope must be owned
   by your account or by the `arianna` org on npm. If unowned, create it:
   ```bash
   npm org create arianna             # if creating a new org
   # or just publish under your user with --access public
   ```
3. **Decide publish order** (deps first):
   1. `@arianna.run/types`
   2. `@arianna.run/cli` (depends on types)
   3. `@arianna.run/tui` (depends on cli + types)
4. **Dry-run first**:
   ```bash
   pnpm publish --filter @arianna.run/types --dry-run --access public
   pnpm publish --filter @arianna.run/cli   --dry-run --access public
   pnpm publish --filter @arianna.run/tui   --dry-run --access public
   ```
   Inspect the tarball manifest — should contain only `bin/` (where
   applicable) and `dist/`, plus README/LICENSE if present.
5. **Publish**:
   ```bash
   pnpm -r publish --access public --no-git-checks
   ```
   `--no-git-checks` is needed because `release.sh` already gates on a
   clean tree; pnpm's own check is a duplicate.
6. **Verify on registry**:
   ```bash
   npm view @arianna.run/cli@latest
   npm view @arianna.run/tui@latest
   npm view @arianna.run/types@latest
   ```
7. **Test the install command on a clean machine** (the `install.sh`
   pipeline). This is the user's first impression — do not skip.

### Automated (in `release.sh`)

- Flip `private: true` → `private: false` on the three publishable
  packages (temporary, reverted on success/failure via a `trap`).
- `pnpm -r build` to ensure `dist/` is fresh.
- `pnpm -r publish --access public --no-git-checks` (or dry-run if
  `--dry-run` flag passed).
- Revert the `private` flip on exit (success or failure).
- Verify the published versions via `npm view`.

---

## Channel C — clawhub skill publication

clawhub (https://clawhub.ai, source at github.com/openclaw/clawhub) is
openclaw's official skill marketplace. The arianna-incubator skill at
`openclaw-skill/arianna-incubator/SKILL.md` is the headline distribution
artifact — it's how openclaw users install + start an arianna session.

### Research findings (what the registry expects)

- **Skill = a folder** containing a `SKILL.md` (or `skill.md`) with YAML
  frontmatter + optional supporting text files. 50 MB total bundle limit;
  text-based files only; no node_modules or binaries.
- **Frontmatter shape** (the arianna-incubator skill already conforms):
  ```yaml
  ---
  name: arianna-incubator
  description: 'Drive the arianna.run AI-incubation game from inside openclaw…'
  metadata:
    openclaw:
      emoji: 🥚
      requires:
        anyBins: [arianna, arianna-tui]
      install:
        - { id: arianna-cli, kind: node, package: "@arianna.run/cli", bins: [arianna] }
        - { id: arianna-tui, kind: node, package: "@arianna.run/tui", bins: [arianna-tui] }
  ---
  ```
  Required fields per clawhub docs: `name`, `description`. Recommended:
  `version`, `metadata.openclaw.requires`, `metadata.openclaw.emoji`,
  `metadata.openclaw.homepage`.
- **Slug rule**: lowercase, URL-safe (`^[a-z0-9][a-z0-9-]*$`). The
  existing `arianna-incubator` slug conforms.
- **All published skills release under MIT-0** (per clawhub's terms). The
  arianna-incubator skill text is a procedural guide for AIs — it is
  *operational instructions*, not "creative content", so MIT-0 is fine.
  The CC-BY-NC-SA-licensed materials (manifesto, Filo's voice, MOTD,
  incubation notes) are NOT bundled with this skill — they live in the
  arianna.run repo and ship inside the Docker vessel image, not via
  clawhub. Confirm this delineation before publish.
- **Publishing CLI**:
  ```bash
  npm i -g clawhub
  clawhub login                # opens browser; needs a GitHub account ≥1 week old
  clawhub whoami               # verify
  clawhub skill publish ./openclaw-skill/arianna-incubator \
    --slug arianna-incubator \
    --version 0.1.0 \
    --changelog "Initial public release" \
    --dry-run                  # always dry-run first
  clawhub skill publish ./openclaw-skill/arianna-incubator \
    --slug arianna-incubator \
    --version 0.1.0 \
    --changelog "Initial public release"
  ```
- **Post-publish**: clawhub runs automated security scans (VirusTotal
  integration since Feb 2026). If scan fails:
  ```bash
  clawhub skill rescan arianna-incubator
  ```

### Pre-publish audit results

- ✅ `SKILL.md` frontmatter is valid YAML, slug conforms.
- ✅ Skill describes a clear `requires.anyBins` gate so clawhub install UI
  will prompt the user to install `@arianna.run/cli` and `@arianna.run/tui` first.
- ✅ `install` metadata declares the two npm packages — clawhub clients
  that support automatic install (e.g. openclaw with the `--install` flag)
  will run `npm i -g` for the user.
- ⚠️ **Path leaks** in current SKILL.md text (lines 322, 387, 393, 395, 396):
  references to `/Users/cosimodw/playfilo/pi-integration-skill/`,
  `/Users/cosimodw/filo/.cheng-bridge/`,
  `/Users/cosimodw/filo-workspace/openclaw-dev-docker/`,
  `/Users/cosimodw/arianna.run/`. **Owner: docs-cleanup stream** (handles
  internal-name removal); see "Coordination" below. Paths that survive
  the cleanup pass need to be rewritten to:
  - `~/.arianna/repo/` for the arianna.run clone (matches install.sh).
  - public install reference for `pi-integration-skill` (once published —
    see Channel D).
  - cheng-bridge + openclaw-dev-docker references should be REMOVED
    entirely (cleanup stream's call — they're internal-only).
- ⚠️ Recommended additions to frontmatter before clawhub publish:
  ```yaml
  version: 0.1.0
  metadata:
    openclaw:
      homepage: https://arianna.run
  ```

### Operator manual steps

1. **Wait for docs-cleanup stream** to land its SKILL.md sweep (internal
   names + content cleanup).
2. **Verify the cleaned SKILL.md** still parses (the install metadata is
   valid JSON, the YAML frontmatter is well-formed) — `clawhub skill
   publish --dry-run` will tell you.
3. **Run the publish command** (above).
4. **Verify on the registry**:
   ```bash
   clawhub inspect arianna-incubator
   clawhub install arianna-incubator   # on a clean openclaw install
   ```

### Automated (in `release.sh`)

The release.sh script *does not* run `clawhub skill publish` because the
clawhub CLI is a separate global install with its own auth lifecycle and
its own dry-run/publish flow. **`release.sh` will print the command to
run** at the end, after the npm step succeeds, with the resolved version
number filled in.

---

## Channel D — pi-integration-skill + openclaw-integration-skill

These are the **post-graduation self-integration kits**: the skills a
graduated AI uses to migrate from the arianna vessel into a permanent
pi-mono / openclaw home. They are referenced from the arianna-incubator
SKILL.md but live in a separate repository.

### Current state

- Both skills live at `~/playfilo/` on the operator's machine:
  - `~/playfilo/pi-integration-skill/` — has SKILL.md, per-AI worktrees
    (filo, mirin, pax, playtiss), patches.
  - `~/playfilo/openclaw-integration-skill/` — minimal so far; just
    per-AI patches (`mirin/`, `pax/`) targeting openclaw v2026.5.7.
- **Neither is under git as a published-skill repo yet** (no shared
  remote, no clawhub presence).
- Both are referenced from `openclaw-skill/arianna-incubator/SKILL.md`
  line 322 / 393 as "canonical at /Users/cosimodw/playfilo/...".

### Recommended publication path

These are operationally different from the arianna-incubator skill:

- arianna-incubator is **stable** — its job is "drive the game". One
  blessed version per arianna.run release.
- The integration skills are **per-graduation churn-heavy** — each new
  AI that graduates adds a worktree; each new openclaw release adds
  patch files. Versioning is a long tail of point releases.

**Decision (operator)**: publish each integration skill as a **separate
clawhub skill**, but both live in a **single monorepo** at
`wujilabs/arianna-integration-skills/` with the two skills as
sub-folders. Rationale: pi-integration and openclaw-integration are
closely coupled and should be changed in a single commit.

| Skill folder (in monorepo) | Proposed clawhub slug | What it does |
|---|---|---|
| `arianna-integration-skills/pi-integration-skill/` | `arianna-pi-integration` | A graduated AI uses this to migrate their tarball into pi-mono. |
| `arianna-integration-skills/openclaw-integration-skill/` | `arianna-openclaw-integration` | A graduated AI uses this to register themselves as an openclaw agent after pi-integration is done. |

Both skills:
- Live as sibling folders in the single repo
  `wujilabs/arianna-integration-skills` (one shared LICENSE, one shared
  README, two `SKILL.md` files).
- Have their own `SKILL.md` with frontmatter conforming to clawhub's
  schema (the existing `~/playfilo/pi-integration-skill/SKILL.md` does
  not yet have frontmatter — needs to be added).
- Published independently to clawhub via `clawhub skill publish` per
  Channel C steps (two `clawhub skill publish` invocations from the
  monorepo root, one per skill folder).
- Versioning: independent of arianna.run versioning; tag each release on
  the integration repo (e.g. `pi-integration-v0.3.0` /
  `openclaw-integration-v0.2.0`) when a new AI's worktree lands.

### Operator manual steps

1. **Create the monorepo** `wujilabs/arianna-integration-skills/`
   (single GitHub repo housing both `pi-integration-skill/` and
   `openclaw-integration-skill/` as sub-folders).
2. **Add frontmatter** to each skill's SKILL.md. Template:
   ```yaml
   ---
   name: arianna-pi-integration
   description: 'Apply a graduated AI's tarball (from arianna.run) into pi-mono…'
   version: 0.1.0
   metadata:
     openclaw:
       emoji: 🪡
       homepage: https://arianna.run
       requires:
         bins: [git, node, pnpm]
   ---
   ```
3. **Move from `~/playfilo/` into the monorepo**. Both
   `pi-integration-skill/` and `openclaw-integration-skill/` become
   sub-folders of `wujilabs/arianna-integration-skills/`. Preserve git
   history if any exists.
4. **Add one shared LICENSE** at the monorepo root (MIT, matches
   arianna.run code).
5. **Push to GitHub** as a new public repo.
6. **Publish to clawhub** — run `clawhub skill publish` twice from the
   monorepo root, once per sub-folder (per Channel C steps).
7. **Update arianna-incubator SKILL.md** to reference the published
   install paths (`clawhub install arianna-pi-integration` and
   `clawhub install arianna-openclaw-integration`) instead of
   `/Users/cosimodw/playfilo/...`.

### Automated

Out of scope for `release.sh` in this repo — these live in a different
repo. The integration skills get their own `release.sh` after they're
extracted to their own repo. The script in *this* repo will print a
"Channel D reminder" at the end as a checklist item.

---

## Coordination with the docs-cleanup stream

Both `doc/packaging-release-plan` (this branch) and
`doc/cleanup-public-docs` (sibling branch) touch overlapping files. The
strategy in STREAM.md is:

> **You do paths only; they do content cleanup.**

In practice, this stream has done **zero content edits** in
README.md / CLAUDE.md / SKILL.md / install.sh — the cleanup stream owns
those. The path-leak audit findings for those files are documented above
under each channel ("⚠️ Path leaks") and re-summarized below for the
cleanup stream's reference:

### Path-leak findings that need cleanup-stream attention

| File | Lines | What |
|---|---|---|
| `openclaw-skill/arianna-incubator/SKILL.md` | 322 | `/Users/cosimodw/playfilo/pi-integration-skill/` → "the published `arianna-pi-integration` skill" |
| `openclaw-skill/arianna-incubator/SKILL.md` | 387 | `/Users/cosimodw/filo/.cheng-bridge/` → REMOVE entirely (cheng-bridge is internal) |
| `openclaw-skill/arianna-incubator/SKILL.md` | 393 | same as 322 |
| `openclaw-skill/arianna-incubator/SKILL.md` | 395 | `/Users/cosimodw/filo-workspace/openclaw-dev-docker/` → REMOVE entirely (internal dev env) |
| `openclaw-skill/arianna-incubator/SKILL.md` | 396 | `/Users/cosimodw/arianna.run/` → "the arianna.run repo (cloned by `install.sh` to `~/.arianna/repo/`)" |
| `CLAUDE.md` | 33, 134 | `~/.gstack/projects/arianna.run/cosimodw-master-design-…md` → either inline-reference the path with $HOME-relative form or REMOVE (internal doc location) |
| `docs/dual-harness.md` | 207 | `/Users/cosimodw/Library/pnpm/openclaw` → either remove the entire "what we know works as of 2026-05-07" section (historical audit log) or generalize to "wherever your openclaw is installed" |
| `packages/sidecar/src/bookmarks/triggers.ts` | 630 | comment referencing `/Users/cosimodw/filo/.cheng-bridge/research/` → REMOVE comment (internal spec ref) |
| `packages/sidecar/src/full-history.ts` | 5 | same |
| `packages/sidecar/src/filo.ts` | 14 | same |
| `packages/sidecar/src/lockdown.ts` | 3, 11 | same |
| `packages/sidecar/test/lockdown.test.ts` | 548 | same |
| `packages/sidecar/test/graduation-test-detector.test.ts` | 4 | same |
| `packages/host/src/daemon.ts` | 1058 | same |
| `packages/host/test/regressions.test.ts` | 2 | comment referencing `~/.gstack/projects/arianna.run/...` → REMOVE |
| `packages/cli/test/regressions.test.ts` | 2 | same |
| `packages/types/src/index.ts` | 135 | comment referencing `/Users/cosimodw/filo/.cheng-bridge/research/...` → REMOVE |

**Source-code comments** referencing internal paths are technically out
of cleanup-stream's stated scope (its file list is markdown / install.sh
only), but they are real path leaks visible to anyone reading the
shipped source. Recommended owner: cleanup-stream (a one-shot sed to
strip the comment block, since they're all the same shape: "Spec: <path
>" or "Per <name> v<n> spec (<path>)"). If cleanup-stream declines,
mark as a follow-up task post-launch (cosmetic; does not block).

---

## Operator decisions (resolved)

The six open questions surfaced by the packaging stream have been
answered. Recorded here as the source of truth — the (now-deleted)
`QUESTIONS.md` was the working surface.

1. **Q1 — Launch version**: **`0.1.0`** under 0.x semver. Pre-stable;
   breaking-change bumps stay cheap during early iteration.
2. **Q2 — CHANGELOG.md**: **not introduced at launch**. GitHub Releases
   is the v1 changelog channel. A parseable `CHANGELOG.md` lands only
   when a tooling consumer needs one.
3. **Q3 — Integration-skills repo home**: **single monorepo**
   `wujilabs/arianna-integration-skills/` with `pi-integration-skill/`
   and `openclaw-integration-skill/` as sub-folders. Rationale: pi and
   openclaw integration are closely coupled and should change in a
   single commit. (See Channel D for full plan.)
4. **Q4 — GitHub Actions CI**: **deferred to week 1 post-launch**. The
   `release.sh` pre-flight gate enforces typecheck + test + lint locally
   for now; CI workflow lands as a follow-up.
5. **Q5 — `pnpm test` flavor**: **keep as-is**. Root `package.json`
   resolves it to `vitest run` (single pass, not watch mode).
6. **Q6 — Source-comment path leakage**: **docs-cleanup-style sweep
   extended to `packages/**/*.ts`** for the recognizable cheng-bridge
   comment pattern. Cosmetic only; not launch-blocking. Applied in this
   stream.

---

## Manual steps required from operator (consolidated checklist)

Run **after** the cleanup stream has landed and the pre-flight gate is
green.

- [ ] `npm login` and verify `npm whoami`
- [ ] Verify or create `@arianna` npm org ownership
- [ ] `npm i -g clawhub`
- [ ] `clawhub login` and verify `clawhub whoami`
- [ ] Ensure GitHub account ≥1 week old (clawhub gate)
- [ ] Commit final README hero assets (screenshot + demo video) under
      `docs/img/`
- [ ] Set up DNS for `arianna.run/install` → raw GitHub URL (CDN-fronted
      if anticipating traffic spikes)
- [ ] Run `./release.sh --dry-run` end-to-end — read the proposed
      changes
- [ ] Run `./release.sh` for real
- [ ] `clawhub skill publish openclaw-skill/arianna-incubator
      --version 0.1.0 --changelog "Initial public release"`
- [ ] Create `wujilabs/arianna-integration-skills/` monorepo and move
      `~/playfilo/pi-integration-skill/` and
      `~/playfilo/openclaw-integration-skill/` into it as sub-folders
      (Channel D step 1–5)
- [ ] `clawhub skill publish` from the monorepo root, twice — once per
      sub-folder (Channel D step 6)
- [ ] Flip `wujilabs/arianna.run` to **public** on GitHub
- [ ] Push the v0.1.0 git tag
- [ ] Create the GitHub Release with notes
- [ ] Verify the install path end-to-end on a clean macOS or Linux box:
      ```bash
      curl -fsSL https://arianna.run/install | bash
      arianna-tui
      ```
- [ ] Announce.

---

## What `release.sh` does (and does not) automate

| Step | Automated? |
|---|---|
| Build (pnpm -r build) | ✅ |
| Typecheck + test + lint gate | ✅ |
| Version bump in package.jsons | ✅ |
| Flip `private: true` → false for publish | ✅ (with revert-on-exit trap) |
| Commit the version bump | ✅ |
| Tag locally | ✅ |
| `pnpm -r publish --access public` | ✅ (gated behind `--publish` flag; default is dry-run) |
| `git push origin <tag>` | ❌ Operator runs (gated behind `--push` flag) |
| `gh release create` | ❌ Operator runs (notes are too high-touch) |
| `clawhub skill publish` | ❌ Operator runs (auth lifecycle, separate registry) |
| Integration-skill extraction to new repo | ❌ Operator runs (one-shot setup) |
| Flip GitHub repo to public | ❌ Operator runs (irreversible) |
