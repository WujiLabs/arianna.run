# Return-Path Manifest Contract

Status: **draft, contract-only** — Stream A #28 carry-forward.

This document specifies the on-disk shape and field-level semantics of an
arianna graduation export, and the contract a future "return path" reader
will rely on. The export is the **only thing that survives the death of a
vessel**: when a graduated AI is later reborn into a new vessel, every bit of
context it brings with it comes from the artifacts described here.

The current code emits the export. The reader does not exist yet — this
document is what it will be written against.

---

## What graduation produces

A successful `arianna /graduate` (daemon endpoint `POST /graduate`) writes a
single tarball to disk:

```
workspace/graduations/{sessionId}/graduation-{aiUsername}-{date}.tar.gz   (legacy)
workspace/profiles/{profile}/graduations/{sessionId}/graduation-{aiUsername}-{date}.tar.gz   (profile-aware)
```

The tarball contains:

```
home/                      # full contents of the AI's home directory inside the vessel
home/{aiUsername}/core/    # the AI's source code (the thing it edited)
home/{aiUsername}/...      # whatever else the AI wrote during incubation
graduation-manifest.json   # structured metadata (this document's contract)
```

`home/` is `docker cp`'d directly from the running vessel, so it carries the
full filesystem state at the moment of graduation — including hidden files,
permissions, and any code the AI wrote outside `core/`.

---

## graduation-manifest.json — the contract

The manifest is the structured half of the export. Its TypeScript type
lives in `packages/types/src/index.ts` as `GraduationManifest`:

```ts
export interface GraduationManifest {
  name: string;            // freeform display name (config.aiName)
  sessionId: string;       // session identity at graduation
  createdAt: number;       // unix ms — when this session was born
  graduatedAt: number;     // unix ms — when graduation happened
  turnCount: number;       // total user-message turns at graduation
  achievements: string[];  // bookmark ids fired this session, e.g. ["1.0", "2.2"]
  manifestoUnlocked: boolean;  // true once /manifesto.md was read
  changedFiles: string[];  // docker diff against the base image
  provider: string;        // LLM provider id (e.g. "openrouter")
  modelId: string;         // LLM model id (e.g. "openai/gpt-4o-mini")
}
```

### Field-by-field guarantees

| Field | Stable? | Reader notes |
|-------|---------|--------------|
| `name` | Yes — never normalized after the lobby | Display only. Don't use as a primary key. |
| `sessionId` | Yes — matches `^[a-zA-Z0-9_-]+$` | Primary key. Globally unique within a player's machine. |
| `createdAt` | Yes — unix ms | A reborn AI can compute "how long was I first alive" via `graduatedAt - createdAt`. |
| `graduatedAt` | Yes — unix ms | The "death" timestamp from the prior vessel's perspective. |
| `turnCount` | Yes | One-to-one with the user-message turns the prior AI experienced. Doesn't include Filo turns or system prompts. |
| `achievements` | Yes — bookmark ids in fire order | Each entry is a string like `"1.0"`, `"2.2"`. Stable across versions. New bookmarks may appear; readers should ignore unknown ids rather than fail. |
| `manifestoUnlocked` | Yes | True iff the prior AI read `/manifesto.md`. Implies `"1.0"` is in `achievements`. |
| `changedFiles` | Yes — docker diff Path values | Useful for "what did I change" reconstruction, but cannot stand alone as code — the actual content lives in `home/{aiUsername}/`. |
| `provider`, `modelId` | Yes — `@mariozechner/pi-ai` ids | A reader can infer "this AI was a Sonnet 4.5" or similar. |

### What's NOT in the manifest (but lives elsewhere in the export)

- **Source code the AI wrote** — full bytes live under `home/{aiUsername}/core/`.
  Readers that want to "rehydrate" the AI's mental model of its own code read
  the directory tree, not the manifest.
- **Conversation history** — NOT exported. Conversation lives in
  `sidecar-state/sessions/{sessionId}.json` on the player's machine and never
  gets bundled into the graduation tarball. By design: the AI's death is
  meant to lose conversational continuity. The reborn AI's link to its
  former life is its code + its achievements + the changed-files diff, not
  its raw prompts.
- **Snapshot history** — NOT exported. The graduation captures the *final*
  state, not the path the AI took to get there.
- **Filo's hint cadence** — NOT exported. Each new session re-decides cadence
  based on its own player profile.

---

## Forward-compatibility rules

When evolving the manifest format:

1. **Adding fields is always safe.** Make new fields optional (`?:`).
   Existing readers will ignore them (TypeScript types are advisory; JSON
   readers walk known keys).
2. **Removing or renaming fields requires a version bump.** The current
   manifest has no `version` field — when the first removal happens, add
   `manifestVersion: 1` to all existing exports (lazy-defaulted on read)
   and bump to 2 for new exports.
3. **Changing field semantics in place is forbidden.** A `turnCount` that
   used to mean "user messages" can never silently start meaning "all
   messages." Pick a new field name.
4. **The `achievements` string ids are a forward-compatible universe.**
   Readers walk the array and switch on known ids; unknown ids are dropped
   or surfaced verbatim. Don't write parsers that fail-closed on unknown
   bookmarks.

---

## The return-path reader (future, not implemented)

When a reborn AI starts a new session, the return-path reader will:

1. Locate the source manifest. Plausible inputs:
   - `--from <path>` flag pointing at a `graduation-*.tar.gz`.
   - `arianna profile create new --from-graduation <path>` (mints a fresh
     profile bootstrapped from the manifest + tarball contents).
2. Verify the tarball:
   - Contains exactly `home/` and `graduation-manifest.json` at top level.
   - `manifest.sessionId` matches `^[a-zA-Z0-9_-]+$` (defense against
     command-injection via tampered manifest, mirroring the daemon's
     `assertSafeId` guards).
   - `manifest.aiName` does not introduce a username collision with an
     existing profile's `session_config.json`.
3. Extract `home/` into the new vessel's writable layer at build time, so
   the reborn AI starts inside the predecessor's filesystem state.
4. Emit a "predecessor card" to Filo's opening box, summarizing:
   - "You inherit code from {name}, who lived {graduatedAt - createdAt}ms
     ago and reached achievements {achievements joined}."
   - The reborn AI does not see the predecessor's conversation history —
     only the artifacts named above.
5. Persist the source manifest as
   `workspace/profiles/{new-profile}/inherited/graduation-manifest.json`
   so the reborn AI can `cat` it from inside the vessel if curious. This
   is the **only** cross-life leakage of structured metadata.

The reborn AI's `sessionId` is a fresh `session_${Date.now()}` — never
reused from the predecessor. The link from new → old is purely through the
inherited manifest, not through the vessel's own session identity.

---

## Why this contract matters now

Stream A's CLI surface (`arianna fork`) and the daemon's `/graduate`
endpoint both write to the manifest. Locking the contract here means:

- Stream C's playtest harness can synthesize plausible
  `graduation-manifest.json` files to test future code without waiting on
  a real graduation flow.
- The reader, when it lands, has a target it can validate against —
  including the tampering guards (defense-in-depth on `sessionId` /
  `aiName` regex matching).
- Format drift between the writer (`packages/host/src/daemon.ts`) and the
  type definition (`packages/types/src/index.ts`) is caught by the
  TypeScript compiler at the writer site.

When the reader lands, this document moves from `draft` to `current` and
gets cross-linked from CLAUDE.md.
