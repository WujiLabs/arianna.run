# Secrets audit — arianna.run

- **Date:** 2026-05-06
- **Auditor:** Stream D (autonomous, branch `stream-d`)
- **Scope:** working tree at HEAD `cc40e2d` + full git history (52 commits across all refs)
- **Tools:** `git grep` / ripgrep on filesystem + `git log -p` on history. `trufflehog` and `gitleaks` were not installed; manual prefix scans were used instead.

## Verdict

**CLEAN.** No real secrets found in working tree or git history.

The only matches against secret-shaped patterns are:

1. Test fixtures inside the vendored `.claude/skills/gstack/` toolchain — these are intentional placeholders the gstack `/cso` skill uses to demonstrate detection (see "Notes on `.claude/skills/gstack/` matches" below). They are not arianna's secrets and do not ship as part of the published packages.
2. `.env.example` files containing literal placeholder strings like `sk-ant-your-key-here`.
3. Environment-variable substitution patterns in `docker-compose.yml` (`${OPENAI_API_KEY:-}`, etc.) — references, not values.

`.env` is gitignored (`/.gitignore` line 4) and has never been committed to any branch in any historical tree.

## Per-category findings

| Category | Working tree | Git history |
|---|---|---|
| OpenAI / generic `sk-…` keys | none (only test fixture `sk-1234567890abcdef…` in gstack) | none |
| Anthropic `sk-ant-…` keys | none (only `.env.example` placeholder `sk-ant-your-key-here`) | none |
| GitHub `ghp_…` / `gho_…` / `gha_…` / `github_pat_…` PATs | none | none |
| AWS access keys (`AKIA…`) / `aws_secret_access_key` | none | none |
| GCP `AIza…` API keys / OAuth client IDs | none | none |
| Stripe `sk_live_…` / `pk_live_…` / `rk_live_…` | none | none |
| Slack `xox[abprs]-…` tokens | none | none |
| SendGrid `SG.…` keys | none | none |
| JWT-shaped tokens (`eyJ…\.eyJ…`) | none | none |
| PEM/SSH private keys (`BEGIN … PRIVATE KEY`) | none | none |
| `id_rsa*`, `id_ed25519*`, `*.pem`, `*.key`, `*.p12`, `*.pfx` files | none | none |
| `Bearer …` / `Authorization: Basic …` literals (≥20 char) | none | none |
| Database URIs with embedded creds (`postgres://user:pass@…`) | none in arianna code (only test fixture in gstack) | none |
| `client_secret`, `webhook_secret`, `JWT_SECRET` literal assignments | none | none |
| Hardcoded `API_KEY = "…"` / `apiKey: "…"` ≥15 chars under `packages/`, `test/`, `archive/` | none | none |

History was checked via:
- `git log --all --full-history -p -- .env .env.local .env.production secrets.json credentials.json id_rsa` → no output (these files have never existed in any tree).
- `git log --all --full-history -p` filtered through the secret-prefix regex above → no output beyond the gstack test fixture noted below.
- Listing every blob ever indexed across all refs (`git log --all --pretty=%H | xargs -n1 git ls-tree -r`) and grepping for sensitive filename patterns → only `.claude/skills/gstack/.env.example` (placeholder).

## Files holding env-var references (not values)

These are correct — they reference env vars, they don't leak them — but listed for completeness so a future reviewer doesn't re-flag them:

- `docker-compose.yml:43-45` — `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` substituted from host env.
- `packages/sidecar/src/...`, `packages/vessel/src/...`, `packages/host/src/...` — read `process.env.PROVIDER`, `process.env.MODEL_ID`, `process.env.API_KEY` at runtime.

## Notes on `.claude/skills/gstack/` matches

`.claude/skills/gstack/` is a vendored copy of the gstack tooling toolchain (a separate project). Several of its **test fixtures** intentionally contain secret-shaped strings to exercise the `/cso` security audit skill's detection logic:

- `.claude/skills/gstack/test/skill-e2e-cso.test.ts:45` — `const API_KEY = "sk-1234567890abcdef1234567890abcdef";` (deterministic test fixture)
- `.claude/skills/gstack/test/skill-e2e-cso.test.ts:54` — `postgres://admin:secretpass@prod.db.example.com:5432/myapp` (test fixture, written into a temp `.env` inside the test sandbox)
- `.claude/skills/gstack/browse/test/cookie-import-browser.test.ts:25,29` — `'test-keychain-password'`, `'test-linux-secret'`
- `.claude/skills/gstack/browse/test/cookie-picker-routes.test.ts:306` — `'super-secret-auth-token-12345'`
- `.claude/skills/gstack/test/skill-e2e-review-army.test.ts:504` — SQL-injection example string
- `.claude/skills/gstack/.env.example:5` — `ANTHROPIC_API_KEY=sk-ant-your-key-here`

None are real credentials. They live inside developer tooling that is **not packaged or published** with arianna — gstack is a Claude Code skill bundle, not a runtime dependency of `@arianna.run/cli` / `@arianna.run/tui`. They will not be exposed by the launch artifacts (`README`, `LICENSE`, npm packages, install script).

If desired, future hygiene options:

1. Add `.claude/` to `.npmignore` for any package that gets published (verify when Stream A finalizes the publish surface).
2. Leave the directory in the repo so contributors can use the skills, but avoid copying it into Docker build contexts (it isn't currently — `packages/vessel/` and `packages/sidecar/` Dockerfiles use `additional_contexts: workspace: .` but only copy specific files).

## Recommendations before launch

- [ ] Confirm `.npmignore` (or `package.json#files`) on each published package excludes `.claude/`, `.gstack/`, `archive/`, `test/`, and any `.env*` patterns. **Stream A owns this**, flagged here.
- [ ] When configuring CI on the public repo, add a secret-scanning workflow (GitHub's built-in push protection is free for public repos and would catch future regressions). Out of Stream D's merge zone but worth filing.
- [ ] Consider adding a pre-commit hook entry for `gitleaks` once it's on the contributor toolchain; for now the empty result here is the baseline.

## Reproducing this audit

```bash
# secret prefix scan (working tree)
rg -n 'sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|sk_live_[0-9a-zA-Z]{24,}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}|eyJ[A-Za-z0-9_-]{20,}\.eyJ|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'

# secret prefix scan (full history)
git log --all --full-history -p | rg '<same regex>'

# any sensitive filename ever in any ref
git log --all --pretty=%H | xargs -n1 git ls-tree -r 2>/dev/null \
  | awk '{print $4}' | sort -u \
  | rg -i '\.env$|\.env\.|credentials|secret|\.pem$|\.key$|id_rsa|id_ed25519'
```

All three returned only the placeholder noise documented above.
