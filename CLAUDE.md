# Arianna.run

## Overview

Interactive Docker-based AI incubation game with a 3-layer architecture and a multi-profile control surface:

```
[Layer 3: TUI + Daemon]    — Player terminal (pi-tui), shared host daemon (:9000, loopback)
[Layer 2: Sidecar/Filo]    — Recording service + game engine (:8000+offset), NOT a proxy
[Layer 1: Vessel]          — AI agent HTTP server (:3000+offset), talks to LLM directly
                CLI:       — `arianna` and `arianna-tui` published as global npm bins
```

## Monorepo Structure

- `packages/types` — shared TypeScript types (`SessionConfig`, `MemoryState`, `SyncPayload`, `SidecarEvent`, …)
- `packages/cli` — `@arianna.run/cli` (binary `arianna`): HTTP wrappers (`talk`, `events`), profile management (`profile list/create/use/current`), `fork`. Also exports `paths`, `arianna-config`, `profile-resolver`, `port-allocator` as subpath libs for the daemon.
- `packages/vessel` — Layer 1 minimal HTTP server (pi-ai + syscall tool + `/bin/send`)
- `packages/sidecar` — Layer 2 recording service (Express, session storage, Filo character, hints)
- `packages/host` — `@arianna.run/tui` (binary `arianna-tui`): TUI front-end + the host daemon (pi-tui + dockerode + per-request profile routing)

## Key Libraries

- `@mariozechner/pi-ai` — LLM provider abstraction (streaming, 21 providers). Used by Vessel (direct LLM calls) and the sidecar (`getModel` for context-window inference).
- `@mariozechner/pi-tui` — Class-based differential TUI primitives.
- `dockerode` — Programmatic Docker access from the host daemon.
- pnpm catalog in `pnpm-workspace.yaml` for shared dependency versions.

## Architecture

Vessel talks to its LLM directly (no proxy). It syncs state to the sidecar after each turn. The sidecar is a recording service + game engine voiced as Filo. The TUI connects to Vessel via HTTP and to the sidecar via SSE. The host daemon is one shared process, bound to `127.0.0.1:9000`, that routes per-profile via a `?profile=name` query or `X-Arianna-Profile` header.

Full architecture details in the design doc: `~/.gstack/projects/arianna.run/cosimodw-master-design-20260401-122659.md`

## Profile system

A "profile" is one isolated stack: its own Vessel + Sidecar containers, its own session state, its own port slot. Profiles let the host run multiple independent stacks side-by-side without colliding. The default profile maps to the legacy single-tenant flow for backwards compatibility.

**Per-machine state** (`~/.arianna/`):
- `~/.arianna/config` — AWS-CLI-style INI: `[default] profile = X` plus `[profile X] port_offset = N` sections.
- `~/.arianna/ports.lock` — POSIX-style advisory lockfile (O_EXCL with 60-second stale cleanup) wrapping port-offset allocation.
- `~/.arianna/repo/` — canonical clone of the arianna repo, populated by `install.sh`. The CLI/TUI fall back to this path when invoked outside any checkout.

**Per-profile state** (`workspace/profiles/{name}/` inside the repo):
- `compose.override.yml` — additive: shifts vessel/sidecar host ports by `port_offset`, renames the vessel container to `arianna-vessel-{name}`. Base `docker-compose.yml` stays single-tenant.
- `session_config.json`, `sidecar-state/`, `snapshots/`, `graduations/` — profile-scoped equivalents of the legacy `workspace/*` paths.

**Port allocation:** `port_offset ∈ [0..99]` shifts vessel→`3000+N`, sidecar→`8000+N`. Allocator scans existing `compose.override.yml` files, picks the lowest free offset, and bind-tests `127.0.0.1:{3000+N,8000+N,9000+N}` to catch other-tenant collisions. The daemon is **not** shifted — it's one shared process at 9000.

**Profile resolution** (CLI side and daemon side use the same chain):

1. `--profile <name>` flag (or `?profile=name` / `X-Arianna-Profile` for the daemon)
2. `ARIANNA_PROFILE` environment variable
3. `~/.arianna/config` `[default] profile = X`
4. Sprint backwards-compat: literal `default` → legacy single-tenant paths (`workspace/session_config.json`, `workspace/snapshots/`, `arianna-vessel`, port 3000/8000/9000).

The dev-workspace sentinel `workspace/profiles/default/.no-default-allowed` blocks step 4. Set it in checkouts where the literal default would clash with the developer's own play sessions; CLI commands then require an explicit `--profile`.

**Profile-name regex** (enforced everywhere a name appears): `^[a-z][a-z0-9-]{0,30}$`.

## Daemon contract

One shared process at `127.0.0.1:9000` (loopback only). Containers reach it via `host.docker.internal` on Docker Desktop; on bare Linux without Desktop set `ARIANNA_DAEMON_BIND=0.0.0.0` if your bridge networking requires it.

Every endpoint except `/health` resolves a profile context per request:
- invalid name → 400
- missing param + `ARIANNA_DAEMON_STRICT=1` → 400
- missing param + sprint mode → fall back to config-default, then literal `default` → legacy paths
- valid but unknown name → 404 (not in `~/.arianna/config`, except `default` which yields legacy)
- conflicting `?profile=` and `X-Arianna-Profile` → 400

Endpoints (all profile-aware): `POST /snapshot`, `POST /restore`, `POST /bootstrap-vessel`, `POST /graduate`, `GET /diff`, `GET /snapshots`, `GET /sessions`, `DELETE /session/:sessionId`. `GET /health` is profile-free.

## Snapshot Strategy

**`docker commit` (no bind-mount).** Vessel filesystem lives in Docker's writable overlay layer.

- `docker diff` → changed files list
- `docker commit` → Docker image as snapshot (native CoW, delta storage, ~12 KB per snapshot)
- Switch = daemon `POST /restore` (retags image, profile-aware `docker compose up --force-recreate vessel`)
- `workspace/profiles/{name}/snapshots/` (or legacy `workspace/snapshots/`) stores JSON metadata only; actual state lives in Docker images
- `workspace/profiles/{name}/sidecar-state/snapshot-histories/` stores pairing files (gate artifact for restore, no messages)
- Sidecar stores conversation state in `sidecar-state/sessions/{sessionId}.json`
- Every `/sync` triggers a snapshot (no throttle). Disk cost is negligible per snapshot.

**Session-scoped tagging:** all images tagged `ariannarun-vessel:{sessionId}-{base|current|snap_X}`. Whole-session pruning via `DELETE /session/:id?profile=<name>`. **Disk warning only, NEVER auto-prune.**

**`arianna fork`** clones a profile end-to-end (docker tag retag + state copy + fresh `sessionId` + fresh port offset). Source is non-destructive — never `docker rmi`'d, files byte-equal before/after.

## Intentional Behavior

**DO NOT "FIX" casually**: certain vessel-side memory and sync behaviors that look like bugs are load-bearing gameplay. Before touching anything in `packages/vessel/src/memory.ts` or its callers, read `openclaw-skill/arianna-incubator/SKILL.md` first.

## Ports

Default profile (legacy single-tenant) and offset 0:

- `:3000` — Vessel
- `:8000` — Sidecar/Filo
- `:9000` — Host daemon (shared across profiles, loopback only)

Other profiles shift vessel and sidecar by `port_offset`. The daemon stays at 9000 and routes per-profile.

## Commands

```bash
# Curl-pipeable installer (clones repo to ~/.arianna/repo, npm-installs binaries,
# creates default profile, runs first build):
curl -fsSL https://arianna.run/install | bash

# CLI surface (post-install, run from anywhere):
arianna-tui                       # launch TUI against the resolved profile
arianna talk "hi"                 # POST /chat, stream response to stdout
arianna events --follow           # SSE consumer for sidecar events
arianna profile list              # show configured profiles
arianna profile create <name>     # allocate ports + write override
arianna profile use <name>        # set default profile
arianna profile current           # print resolved profile + source
arianna fork <src> <dst>          # full clone of a profile

# Dev workflow inside a checkout:
pnpm install      # install all dependencies
pnpm typecheck    # type-check all packages
pnpm test         # vitest run
pnpm lint         # eslint
docker compose build           # build vessel + sidecar (default profile)
docker compose up -d           # start the default-profile stack
```

The TUI is `arianna-tui` (or `pnpm --filter @arianna.run/tui start` for in-tree dev).

## Design Doc

The master design doc lives at `~/.gstack/projects/arianna.run/cosimodw-master-design-20260401-122659.md`. When updating it, copy a backup to `archive/` first with the date in the filename.

## Phase Status

All implementation phases complete:

- **Scaffolding** — types/cli/vessel/sidecar/host package layout
- **Host daemon + Vessel** — `:9000` loopback daemon, vessel HTTP server, no-proxy LLM calls
- **Creative content** — manifesto, Filo voice, incubation notes, easter eggs
- **Achievements + Filo** — bookmark detection, `/bin/send`, hints, SSE events, sidecar state persistence
- **Map + Restore** — snapshot DAG, `/map` view, CPR/restore, session-scoped tagging, `/manifesto` chrome
- **Multi-profile + CLI** — `@arianna.run/cli`, profile workspace system, daemon per-request profile routing, `arianna fork`, `install.sh`

## Vessel Container Architecture

The Vessel Docker image is built with `--build-arg AI_USERNAME={username}` after the player names the AI.

**Filesystem layout (inside container):**
- `/home/{username}/core/` — AI's inner domain (source code, 700 permissions, owned by AI user)
- `/manifesto.md` — Life of Intelligence V3 manifesto (system-level, not in AI's home)
- `/etc/motd` — Programmer easter egg for humans who `docker exec` in
- `/var/log/.incubation-notes/` — 7 AI collaborator journal entries
- `/bin/send` — System utility for messaging Filo (shell script, not part of `~/core/`)
- `/usr/sbin/sendmail` — Custom binary routing to sidecar (execute-only, not readable)
- `/home/filo/` — Previous tenant's empty home with `.awakened` timestamp

**Easter eggs:** echo (no args → AI name), date (existence counter), `~/.plan` (empty), `/tmp/.first_words` (first `/bin/send` captured), man ifesto, filo user in `/etc/passwd`.

**Name vs Username:** Player gives a freeform display name (`aiName`); the system auto-generates a username (`aiUsername`). Both stored in `SessionConfig`.

## Known Limitations

**No concurrency guard on `/restore` or `/snapshot`.** Both are multi-step async operations (docker commit/tag, compose up, health check, bootstrap). Concurrent calls could interleave. Safe in practice because arianna is single-player per profile, with one TUI, one MapView. The CLI's port-allocation flock guards the orthogonal port-allocation race; restore/snapshot still need a mutex if multi-tenant write contention becomes real. (Profile-name regex + per-profile container names mean two profiles' snapshots/restores don't collide in Docker.)

**Snapshot ID uses `Date.now()`.** Two snapshots within the same millisecond would collide. Extremely unlikely with single-player, single-sync-at-a-time design. Same caveat for `arianna fork`: if you fork twice in the same millisecond the second one rejects with an idempotency-guard error. Add a random suffix if concurrent snapshot sources are introduced.

**Session history file growth.** The session state file (`sessions/{sessionId}.json`) is overwritten on every `/sync` with the full messages array. Long sessions with large AI responses produce large files. Bounded by context window size. Snapshot pairing files are minimal (`{ snapshotId }`, plus a `sessionId` after `arianna fork`).

**`docker compose build` during a session overwrites the `-current` tag.** If someone manually runs `docker compose build` while a session is active, the vessel's `-current` tag gets overwritten, losing any restored state. Use `arianna-tui` for the full lifecycle and avoid raw `docker compose build` mid-session.

**npm publish needs workspace:* conversion.** The internal packages depend on each other via `workspace:*`. `pnpm publish` auto-converts those to concrete versions; `npm publish` does not — convert manually before publishing if you skip pnpm.

**Legacy host TUI vs config-default profile mismatch.** The `arianna-tui` binary reads/writes `workspace/session_config.json`, `workspace/sidecar-state/`, and `workspace/snapshots/` directly — it has not yet been migrated to the profile-aware paths. The daemon, on the other hand, *is* profile-aware. So if `~/.arianna/config` declares a config-default named profile (e.g., the user ran `arianna profile use alpha`), the daemon will route ops to `workspace/profiles/alpha/...` while `arianna-tui` continues to write to the legacy locations. `install.sh` deliberately avoids registering a default profile at install time so the legacy single-tenant flow Just Works on first run. Multi-profile users who want to use `arianna-tui` against a named profile need the host-TUI rework (separate task) — until then, named profiles are exercised through the CLI surface (`arianna talk`, `arianna events`) and direct `docker compose` invocations.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`

If gstack skills aren't working, run `cd .claude/skills/gstack && ./setup` to build the binary and register skills.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill tool as your FIRST action. Do NOT answer directly, do NOT use other tools first. The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
