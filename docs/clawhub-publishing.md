# Publishing `arianna-incubator` to ClawHub

Research timestamp: 2026-05-12 (master at c640e42).
Local CLI version: `clawhub` 0.9.0 (already installed at `/Users/cosimodw/Library/pnpm/clawhub`).
Local CLI version: `openclaw` 2026.3.24 (already installed at `/Users/cosimodw/Library/pnpm/openclaw`).

---

## (a) What ClawHub is

**ClawHub** (`https://clawhub.ai`) is the OpenClaw project's public skill-and-plugin registry — the official place where openclaw-compatible skill bundles are uploaded, discovered, searched, and installed. It is a hosted service (not a GitHub-PR workflow): authoring/auth happens through a web UI (GitHub OAuth), uploads happen through a REST API at `https://clawhub.ai/api/v1/...`, and a single CLI (`clawhub`) wraps both. Skills are free and published under MIT-0 (no per-skill license overrides). The same registry serves both `clawhub install <slug>` (consumer side) and `clawhub publish <path>` (author side). Source for the registry/CLI lives at `github.com/openclaw/clawhub`; docs at `https://documentation.openclaw.ai/clawhub/`. The endpoint `https://clawhub.ai/.well-known/clawhub.json` advertises `apiBase` / `authBase` / `minCliVersion` for CLI discovery.

---

## (b) Pre-publish state of the bundle

### Files present at `/Users/cosimodw/arianna.run/openclaw-skill/arianna-incubator/`

```
SKILL.md   671 lines / 64 053 bytes / 0.06 MB   (one file only)
```

### Frontmatter inventory

```yaml
name: arianna-incubator
description: 'Drive the arianna.run AI-incubation game from inside openclaw …'
metadata: { "openclaw": { ... emoji, requires, install ... } }
```

### Validation against ClawHub's publish contract

| Requirement                                                    | Bundle status                                                            | Action                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Contains `SKILL.md` (or `skill.md`)                            | ✅ present                                                                | none                                                                                                                |
| Slug matches `^[a-z0-9][a-z0-9-]*$`                            | ✅ `arianna-incubator` passes                                             | none                                                                                                                |
| Frontmatter `name` field                                       | ✅ `arianna-incubator`                                                    | none                                                                                                                |
| Frontmatter `description` field (short summary)                | ✅ ~5 sentences (~890 chars)                                              | works; the doc says "short summary" but does not impose a hard cap and registry accepted it through `inspect`-style calls. Leave as-is. |
| Frontmatter `version` field                                    | ❌ **missing**                                                            | not strictly enforced by the CLI's `publish` (version comes from `--version`), but the skill-format doc lists it as required. Optional fix: add `version: 0.1.0`. |
| License terms                                                  | ✅ no conflicting license in SKILL.md                                     | none — MIT-0 will be applied automatically by the registry. Publishing implicitly accepts MIT-0 (the CLI sets `acceptLicenseTerms: true`). |
| Total bundle size ≤ 50 MB                                      | ✅ 0.06 MB                                                                | none                                                                                                                |
| Only text-based file extensions (md, txt, json, ts, sh, etc.)  | ✅ a single `.md`                                                         | none                                                                                                                |
| `SKILL.md` describes a single skill                            | ✅                                                                        | none                                                                                                                |
| Slug not already taken on `clawhub.ai`                         | ✅ `clawhub inspect arianna-incubator` → "Skill not found"                | none — slug is currently free                                                                                       |

### Other publication-readiness flags (non-blockers)

1. **The skill instructs users to `npm install -g @arianna.run/cli` / `@arianna.run/tui`, but those packages are marked `private: true` and not on npm yet.** This is documented inside the SKILL.md itself (lines 71–92 of the bundle) with a host-side `pnpm pack` workaround. Anyone installing this skill on Day 1 will hit a broken `metadata.install` block. Consider whether to delay publication until the npm release, OR publish now with a clear "BETA / packages not yet on npm" note in the changelog.
2. **No README.md or LICENSE file in the bundle folder.** Neither is required by ClawHub — the platform synthesises listing copy from the frontmatter and forces MIT-0 — but adding a one-paragraph README aimed at humans browsing `clawhub.ai/skills/arianna-incubator` would improve the listing page.
3. **The frontmatter `metadata.openclaw.install` block points at `@arianna.run/cli` and `@arianna.run/tui`.** Once those packages are published, openclaw's `requires.anyBins` auto-install path Just Works; until then, the skill is operable only in environments where `arianna` and `arianna-tui` are already installed (e.g. the dev-docker container with packed tarballs).
4. **`name` ≠ display name.** The CLI's `--name` option sets the listing's display name (defaults to titleCased slug → "Arianna Incubator"). Recommended explicit value: `--name "Arianna Incubator"`.
5. **Tags.** The CLI defaults `--tags latest`. For discoverability, consider `--tags latest,game,incubation,docker,openclaw`.

### Recommended publish invocation (one-shot)

```bash
clawhub publish /Users/cosimodw/arianna.run/openclaw-skill/arianna-incubator \
  --slug arianna-incubator \
  --name "Arianna Incubator" \
  --version 0.1.0 \
  --tags latest,game,incubation,docker,openclaw \
  --changelog "Initial publication. NOTE: requires @arianna.run/cli and @arianna.run/tui — not yet on npm; install via host-side pnpm pack tarballs (see SKILL.md §Installing the arianna CLI inside openclaw)."
```

---

## (c) Manual steps the operator (Cosimo) must do

These are the steps a follow-up agent **cannot** do on Cosimo's behalf — they require a human in a browser with Cosimo's identity, eyes, and any optional consent.

### M1 — Create / confirm a ClawHub account

- **Where:** `https://clawhub.ai` → "Sign in" (top right). Auth is GitHub-OAuth-only; there is no email/password form.
- **What to do:** Click "Sign in with GitHub" and authorize the ClawHub OAuth app against your GitHub account.
- **Success criteria:** After GitHub redirects back, you land on `clawhub.ai` as a signed-in user. Visit `https://clawhub.ai/account` (or click your avatar) and confirm a **handle** is set. If prompted, choose a handle — this will become the owner namespace shown on your skill's listing page (e.g. `clawhub.ai/skills/arianna-incubator` will display "by @your-handle").
- **Artifact to capture:** Your `@handle`. (You'll want it for the README + the follow-up prompt.)
- **Cost:** Free. No payment. ClawHub does not support paid skills.

### M2 — Accept any first-login ToS / Terms of Use that the site shows

- **Where:** Same browser session as M1; ClawHub may surface a one-time consent banner.
- **What to do:** Read and accept whatever the UI presents. (As of this research the site shows no explicit `/tos` page from the navigation; the publish API also sets `acceptLicenseTerms: true` automatically, which is the per-skill MIT-0 acceptance. There may be a site-level ToS gating account creation — accept if shown.)
- **Success criteria:** No persistent "you must accept terms" banner; you can navigate to `/skills/publish` without being bounced back.
- **Artifact to capture:** None (the registry remembers the acceptance under your account).

### M3 — Mint a CLI API token (only if you want the follow-up agent to publish non-interactively)

This step is **optional** if you'll run `clawhub login` yourself in your own terminal (browser flow). It is **required** if you want a follow-up agent or CI to publish without you watching.

- **Where:** `https://clawhub.ai/settings/tokens` (or "Settings → API tokens" from the avatar menu).
- **What to do:**
  1. Click "Create token" (or similar).
  2. Label it something like `arianna-incubator-publish-2026-05-12` so it's revocable later.
  3. Copy the resulting `clh_...` token immediately — ClawHub will only show it once.
- **Success criteria:** The new token appears in the list with your label and the prefix `clh_`.
- **Artifact to capture:** The full `clh_...` token string. **Treat as a secret.** Anyone with this token can publish, delete, and transfer skills under your account.
- **Revocation:** Same page — "Revoke" next to the token row. The CLI tells you exactly this on logout: "Token still valid until revoked (Settings → API tokens)."

### M4 — Decide on the version + changelog text

- **What to do:** Pick the semver to publish as. Recommended: `0.1.0` for the first public publication. Draft a one-paragraph changelog that mentions the npm-not-yet-published caveat (see § b above).
- **Success criteria:** You have a `--version` string and a `--changelog` string ready to paste.
- **Artifact to capture:** The two strings (paste them into the follow-up prompt).

### M5 — Decide whether to add `version:` to the SKILL.md frontmatter before publish

- **What to do:** This is a judgment call. Pro: matches the doc spec. Con: it's one more thing to keep in sync with `--version` on every future publish, and the registry does not enforce it. **Recommended: skip it** — the CLI's `--version` flag is what the registry actually stores.
- **Success criteria:** You've made the call; the bundle is in the state you want.

### M6 — Decide whether to publish from the live repo path or a clean copy

- **What to do:** The CLI's `listTextFiles` walks the folder, respecting `.gitignore` and skipping hidden directories. The folder currently has **only `SKILL.md`** so this isn't a real risk, but if you later add scratch files, copy the folder to a clean path before publishing.
- **Success criteria:** You've confirmed `ls /Users/cosimodw/arianna.run/openclaw-skill/arianna-incubator/` shows only files you want shipped.

---

## (d) Automatable steps for the follow-up agent

Picks up after M3 (token obtained) or after M1+M2 if Cosimo prefers to run `clawhub login` himself. Assumes the agent has shell access on the same Mac and can read the bundle path.

### A1 — Verify CLI is present and recent enough

```bash
clawhub -V
# expect: 0.9.0  (or newer)
```

The `.well-known/clawhub.json` advertises `minCliVersion: "0.1.0"`, so 0.9.0 is fine. If the binary is missing, install with `npm i -g clawhub` (or `pnpm add -g clawhub`).

**Error modes:** Command not found → install via npm/pnpm. Version older than `minCliVersion` → upgrade.

### A2 — Authenticate (one of two paths)

**Headless (uses the token from M3):**
```bash
clawhub login --token clh_xxxxxxxxxxxxxxxx
# expect: "OK. Logged in as @<handle>."
```

**Browser (interactive — only works if Cosimo is at the terminal):**
```bash
clawhub login
# CLI prints: "Opening browser: https://clawhub.ai/cli/auth?..."
# Browser opens, completes GitHub OAuth + loopback callback,
# CLI prints: "OK. Logged in as @<handle>."
```

Token gets written to `~/Library/Application Support/clawhub/config.json` on macOS (override via `CLAWHUB_CONFIG_PATH`).

**Error modes:**
- `Token required (use --token or remove --no-input)` → A1's check passed but `--no-input` is interfering; drop it or pass `--token`.
- `state mismatch` / `Invalid redirect URL` on browser flow → restart from scratch (`clawhub logout` then `clawhub login`).
- Token rejected by `/api/v1/whoami` → token was revoked or mistyped; re-mint in M3.

### A3 — Verify login

```bash
clawhub whoami
# expect: your-handle
```

**Error modes:** `Not logged in. Run: clawhub login` → A2 didn't persist the token, retry.

### A4 — Confirm the slug is still free (idempotency guard)

```bash
clawhub inspect arianna-incubator
# expect: "✖ Skill not found ..."   (means slug is free)
# OR:     metadata for an existing skill (means someone else grabbed it — STOP)
```

**Error modes:**
- "Skill not found" → green light, proceed.
- Skill exists but owner is someone else → escalate to operator (slug conflict; cannot proceed).
- Skill exists and owner is your handle → this is a re-publish; bump `--version` (e.g. `0.1.1`) and add a `--changelog` describing the delta.

### A5 — (Optional) Dry-run with the `sync` command

`clawhub publish` itself has no `--dry-run`, but `clawhub sync` does. To preview what files would upload:

```bash
clawhub sync \
  --root /Users/cosimodw/arianna.run/openclaw-skill \
  --dry-run \
  --all
# Lists the files that would be packaged.
```

Skip this if you already trust the bundle contents (it's one file).

### A6 — Publish

```bash
clawhub publish /Users/cosimodw/arianna.run/openclaw-skill/arianna-incubator \
  --slug arianna-incubator \
  --name "Arianna Incubator" \
  --version 0.1.0 \
  --tags latest,game,incubation,docker,openclaw \
  --changelog "<the changelog string from M4>"
# expect on success:
#   OK. Published arianna-incubator@0.1.0 (<versionId>)
```

The CLI POSTs a multipart form to `https://clawhub.ai/api/v1/skills` with `acceptLicenseTerms: true` baked in.

**Error modes:**
- `SKILL.md required` → bundle path wrong, or `.gitignore` ignored the file.
- `--version must be valid semver` → fix the version string.
- `No files found` → bundle path empty after ignore-filtering.
- 401 / "Not logged in" → token expired or revoked; redo A2.
- 409 / "slug already taken" → A4 missed it, escalate.
- 413 / "bundle too large" → impossible at 0.06 MB; investigate.
- 429 / rate limited → wait per `reset in Ns` from the response and retry.

### A7 — Confirm the listing is live

```bash
clawhub inspect arianna-incubator
# expect: metadata block, latestVersion: 0.1.0, owner: @your-handle
```

Also reachable in a browser at `https://clawhub.ai/skills/arianna-incubator`.

**Error modes:** Returns "Skill not found" → propagation lag; wait 30s and retry. If still missing after a minute, the publish failed silently; check the publish command's exit code and stderr.

### A8 — Report back

Output to the operator:
- The `versionId` printed by A6.
- The public URL `https://clawhub.ai/skills/arianna-incubator`.
- The bundle path and version published.
- A reminder that the listed `metadata.install` packages (`@arianna.run/cli`, `@arianna.run/tui`) are not yet on npm — so anyone who clicks "Install" will need the host-side tarball workaround until those packages publish.

---

## (e) Handoff checkpoint

> **Operator:** Once you've completed steps **M1 → M5** above and have these artifacts in hand:
>
> 1. Your ClawHub `@handle` (from M1)
> 2. A `clh_...` API token (from M3) — only needed if you want me to publish non-interactively; if you'd rather run `clawhub login` yourself, just confirm "I logged in"
> 3. The `--version` string you chose (recommended: `0.1.0`)
> 4. The `--changelog` text you drafted
> 5. Confirmation that you reviewed `M5` (left `version:` out of frontmatter) and `M6` (bundle folder contains only `SKILL.md` — no scratch files)
>
> Paste those into a follow-up prompt like:
>
> > "Publish arianna-incubator to clawhub. Handle: @your-handle. Token: clh_xxx (or: I'm already logged in via browser). Version: 0.1.0. Changelog: <text>. Bundle is clean. Proceed from step A1."
>
> The follow-up agent will then run A1 → A8 and report the public URL + versionId.

---

## (f) Open questions / flagged ambiguities

1. **Is a site-level ToS shown on first login?** The homepage and `/cli/auth` did not surface one in the WebFetch reads, but the GitHub-OAuth flow may prompt for one on first sign-in. *Resolves by:* doing M1 and noting whether a ToS banner appears.
2. **Exact location of the "Create API token" page.** The CLI's `logout` message references "Settings → API tokens" and the README mentions revocation there, but the URL was not directly enumerated in the docs we fetched. Best guess: `https://clawhub.ai/settings/tokens`. *Resolves by:* signing in and looking under the avatar menu.
3. **Is a handle required at first publish?** ClawHub's `/api/v1/whoami` schema returns `handle: "string|null"` — so a handle is technically optional in the data model. Whether the publish endpoint refuses uploads from accounts without a handle is unverified. *Resolves by:* the first publish attempt; if it 4xxs with "handle required", go set a handle and retry.
4. **Does the registry enforce frontmatter `version` independently of `--version`?** The local CLI's `publish.js` does not read frontmatter for version — only `--version` matters at the CLI boundary. The documentation says `version` is required in frontmatter. This is a CLI/docs mismatch. *Resolves by:* the first publish — if it succeeds without frontmatter `version`, the docs are aspirational rather than enforced.
5. **Whether to wait for `@arianna.run/cli` and `@arianna.run/tui` to be on npm before publishing.** This is a product/timing call, not a technical blocker. The skill bundle ships with explicit "packages not yet on npm" instructions in its own body (lines 71–92), so it is honest about the gap. *Resolves by:* an operator decision — publish now and update later, or wait.
6. **Whether ClawHub keeps a public "delete from registry" path.** The CLI exposes `clawhub delete <slug>` (soft-delete) and `clawhub hide <slug>` (hide from listings) for owners. Whether full hard-delete is available, and whether it leaves a tombstone slug, is not documented in the surfaces examined. *Resolves by:* attempting `clawhub delete arianna-incubator` after publish, or by reading the registry source at `github.com/openclaw/clawhub`.
7. **`clawhub login --device` flow.** The web docs mention a `--device` headless interactive flow that prints a code to visit at `<site>/cli/device`, but the locally installed CLI v0.9.0 does not expose that flag — only `--token` and the browser flow. Possibly a newer-CLI-only feature. Not blocking, since `--token` works.
