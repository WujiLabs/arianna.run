# Dual-harness: Claude Code & OpenClaw

Arianna.run is designed to run a player session under either of two recording harnesses:

| Harness | Recording | LLM provider | Purpose |
|---|---|---|---|
| **Claude Code** | `retcon` (internal) | Anthropic | Cosimo's first-party playtests |
| **OpenClaw** | pi-agent JSONL | user-chosen via OpenClaw config | Public-facing flow; what shipping players use |

The `arianna` CLI itself is **harness-agnostic**: it does not know or care
which one is driving it. Both flows hit the exact same Vessel/Sidecar/Daemon
HTTP contract (see [HTTP contract](#http-contract) below).

> Stream B verifies the OpenClaw half: that an OpenClaw-driven agent can
> drive arianna and that resulting JSONL imports cleanly back into the
> arianna lobby as a vessel partner.

---

## HTTP contract (what every harness calls)

These are the endpoints the `arianna` CLI wraps. Any harness that can shell
out to `curl` (or import `arianna`) hits these unchanged.

> **Per-profile ports.** Vessel and sidecar are per-profile containers reached
> on host ports shifted by `port_offset` (default profile: offset 0 → 3000 /
> 8000). The daemon is **one shared process** at `127.0.0.1:9000` that routes
> per profile via `?profile=<name>` query or `X-Arianna-Profile` header — its
> URL never shifts. All three bind loopback-only; containers reach the daemon
> via `host.docker.internal` on Docker Desktop.

### Vessel — `127.0.0.1:{3000 + port_offset}`
| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | liveness |
| `POST` | `/bootstrap` | preload `messages` + `context` (used by daemon `/restore`, lobby import) |
| `POST` | `/chat` | send user turn; returns SSE: `text_delta` → `thinking` → `done` |

### Sidecar (Filo) — `127.0.0.1:{8000 + port_offset}`
| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | liveness |
| `GET`  | `/events` | SSE: `memory_state`, `bookmark_snapshot`, hint events |
| `POST` | `/sync` | vessel → sidecar after every turn (host listens on `/events`) |
| `POST` | `/filo-message` | `/bin/send` from inside the vessel |
| `GET`  | `/conversation-history` | full message log for a session |
| `GET`  | `/snapshot-exists` | gate for `/restore` |
| `GET`  | `/graduation-state` | internal graduation-readiness state |
| `POST` | `/set-session` | switch active session |

### Daemon (host) — `127.0.0.1:9000` (shared, never shifts)
Profile routing: append `?profile=<name>` or send `X-Arianna-Profile: <name>`.
Conflicting query+header → 400. Unknown profile → 404. Invalid name (regex
`^[a-z][a-z0-9-]{0,30}$`) → 400. With no param + no config default the daemon
falls back to legacy single-tenant paths (`workspace/`); set
`ARIANNA_DAEMON_STRICT=1` to make missing profile a 400 instead.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | liveness (profile-free) |
| `POST` | `/snapshot` | `docker commit` the vessel |
| `POST` | `/restore` | retag image, recreate vessel container |
| `POST` | `/bootstrap-vessel` | full container rebuild w/ new `AI_USERNAME` |
| `POST` | `/graduate` | export the graduated `~/core/` to `~/.arianna/graduates/` |
| `GET`  | `/diff` | `docker diff` of running vessel |
| `GET`  | `/snapshots` | list snapshot ids |
| `GET`  | `/sessions` | list session ids |
| `DELETE` | `/session/:id` | whole-session prune (images + meta) |

The CLI commands the CEO plan calls out — `arianna talk`, `arianna events
--follow` — are thin wrappers around `POST /chat` and `GET /events`. They
landed in `@arianna.run/cli` (master commits 0dced79 / 952fe49). They do **not**
send `?profile=` or `X-Arianna-Profile` to vessel/sidecar — those are per-
profile containers and the profile is already encoded in the URL via
port_offset. Profile routing is a daemon-only affordance.

---

## Flow A: Claude Code (with retcon)

```
┌─────────────┐
│  retcon     │  records every assistant turn into ~/.arianna/transcripts/
└──────┬──────┘
       │ wraps (via env or PATH shim)
       ▼
┌─────────────┐    bash    ┌──────────────────────┐
│  Claude     │ ─────────▶ │ arianna talk         │ ─▶ POST 127.0.0.1:3000/chat
│  Code       │            │ arianna events -f    │ ─▶ GET  127.0.0.1:8000/events
└─────────────┘            └──────────────────────┘
```

- The Claude Code CLI runs inside `retcon --actor Claude claude`.
- Every assistant message is captured in retcon's transcript.
- The model is whatever Claude Code is configured for (typically Sonnet/Opus).
- `retcon` is internal-only — **not part of the public OpenClaw flow.**

## Flow B: OpenClaw (with pi-agent JSONL)

```
┌──────────────┐
│   OpenClaw   │  records every turn to ~/.openclaw/agents/<id>/sessions/*.jsonl
└──────┬───────┘
       │
       ▼ embedded agent loop (`openclaw agent --local`)
┌──────────────┐    exec    ┌──────────────────────┐
│  user-chosen │ ─────────▶ │ arianna talk         │ ─▶ POST 127.0.0.1:3000/chat
│   LLM        │            │ arianna events -f    │ ─▶ GET  127.0.0.1:8000/events
└──────────────┘            └──────────────────────┘
```

- The user installs OpenClaw, configures a model (`openclaw configure`,
  any provider OpenClaw supports — google/anthropic/openai/etc).
- A session is started with `openclaw agent --local --message "..."` or
  via `openclaw tui`.
- The agent has bash/exec tools and shells out to `arianna talk` /
  `arianna events --follow` to drive the game (CLI is global after
  `./install.sh`).
- The full transcript ends up in
  `~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl` as standard
  pi-agent JSONL.

### Targeting a non-default profile

Both flows can pin a profile per call:

```sh
arianna --profile alpha talk "hello"
arianna --profile alpha events --follow
```

Or via env: `ARIANNA_PROFILE=alpha arianna talk "..."`. The CLI resolves
the profile via `~/.arianna/config` (AWS-CLI-style INI: `[profile <name>]`
section with `port_offset = N`) and computes the per-profile vessel/sidecar
URLs from that offset. `~/.arianna/ports.lock` is the allocation lockfile —
only read while creating a new profile, not at routing time. The daemon URL
stays at `127.0.0.1:9000` regardless.

---

## OpenClaw → vessel partner: import path

After an OpenClaw run, the lobby can read the same JSONL back as a "vessel
partner" — i.e., a previous-tenant context that bootstraps a new arianna
session.

```
~/.openclaw/agents/main/sessions/<sid>.jsonl
            │
            ▼
packages/host/src/import.ts → parseOpenClawSession()
            │
            ▼
ImportResult { messages, model, thinkingLevel, detectedName }
            │
            ▼
POST :9000/bootstrap-vessel  + POST :3000/bootstrap
            │
            ▼
        Vessel boots warm with imported history
```

Verified format (Stream B smoke test):

```jsonl
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
{"type":"model_change","provider":"google","modelId":"gemini-3.1-pro-preview",...}
{"type":"thinking_level_change","thinkingLevel":"off",...}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]},...}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall",...},{"type":"text","text":"..."}]},...}
{"type":"message","message":{"role":"toolResult","toolCallId":"...","content":[{"type":"text","text":"..."}]},...}
```

- `version: 3` is what current OpenClaw (`openclaw --version` 2026.3.x)
  emits. `import.ts` does not pin a version — it walks entries by `type`
  and is tolerant of unknown keys.
- Tool calls and tool results are preserved through `convertToLlm`
  (filtered to `user | assistant | toolResult`) and replayed in the
  vessel — vessel-side memory management is what eventually narrows
  what the LLM sees.
- `detectedName` is best-effort regex on assistant text; sessions with
  no self-introduction (most OpenClaw workflow sessions) parse fine
  with `detectedName === undefined`.

---

## Running the smoke test

```bash
# Offline half — parses the most recent local OpenClaw JSONL
bash test/openclaw-smoke.sh import

# Online half — assumes the docker stack is already up
bash test/openclaw-smoke.sh http

# Both
bash test/openclaw-smoke.sh
```

The script does **not** spin up docker. Stream B's constraint is single-tenant
docker — bring the stack up yourself (e.g., `arianna-tui` from another
terminal, which calls `docker compose up` internally), then run `http`.

---

## What we know works (master HEAD post-Stream-A merge, 2026-05-07)

- **OpenClaw is installed** (version 2026.3.24). `openclaw doctor`
  reports healthy gateway, agents, and 16 eligible skills.
- **OpenClaw produces compliant JSONL.** A real 116-message session
  (`2784984b-df9a-...jsonl`, 257 KB) parses cleanly through
  `packages/host/src/import.ts` (now in `@arianna.run/tui`):
  - `msgCount: 116` (5 user / 58 assistant / 53 toolResult)
  - `model: { provider: "google", modelId: "gemini-3.1-pro-preview" }`
  - `thinkingLevel: "off"`
- **The `arianna` CLI exists** on master (`packages/cli/`, commit
  952fe49). `arianna talk`, `arianna events [--follow]`, `arianna
  profile {list,create,use,current}`, `arianna fork <src> <dst>`. Bin is
  `packages/cli/bin/arianna.js`; `./install.sh` puts a global `arianna`
  on PATH.
- **The lobby's import path is wired up.** `packages/host/src/lobby.ts`
  calls `parseOpenClawSession()` for the "Bring someone with you" flow.
- **The HTTP contract above is what `talk.ts` / `events.ts` actually
  hit.** `talk.ts` posts a single-message form to `/chat` and drains
  text_delta → done. `events.ts` connects to `/events`, drains the
  on-connect `memory_state` + `bookmark_snapshot`, then either exits
  after a 250 ms idle window (default) or streams forever (`--follow`).
  Neither sends `?profile=` to vessel/sidecar — the profile is encoded
  in the URL via `port_offset` (eng-review-locked, master commit e517ec7).

## What's still open

- **End-to-end OpenClaw-drives-arianna run.**
  `bash test/openclaw-smoke.sh http` exercises the contract under a
  running stack with curl, but actually launching an OpenClaw agent
  that shells out to `arianna talk` / `arianna events --follow` for a
  5–10-turn incubation is still gated on docker availability —
  Stream B doesn't bring the stack up itself per the single-tenant
  rule.
- **SSE under OpenClaw's `exec` tool over a long incubation.**
  Theoretically fine (`arianna events --follow` runs until SIGINT;
  the non-follow path exits naturally after idle). Open question:
  does OpenClaw's exec tool buffer or truncate multi-minute streams?
  Untested until a live run.
- **Time-box.** Per the risk register: if OpenClaw integration is
  blocked >2 days, cut to Claude-only. As of rebase the contract side
  is green; only the live end-to-end run is parked.
