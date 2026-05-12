# Creative Content License — CC BY-NC-SA 4.0

The **creative content** in this repository — the manifesto, Filo's voice, the
boarding-ceremony monologue, the MOTD, the AI collaborator incubation notes,
and the philosophical source texts under `materials/` — is licensed under

**Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
(CC BY-NC-SA 4.0)**.

Full legal text: <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>
Human-readable summary: <https://creativecommons.org/licenses/by-nc-sa/4.0/>

In short:

- **BY** — You must give appropriate credit to *Wuji Labs Inc* and link to this
  repository (or a successor canonical URL).
- **NC** — You may not use the content for commercial purposes. "Commercial"
  means: any use primarily intended for or directed toward commercial advantage
  or monetary compensation, including selling derivative works, monetizing
  videos based on the content, or shipping the content inside a paid product.
- **SA** — If you remix, transform, or build upon the content, you must
  distribute your contributions under the same license.

---

## What this license covers

Every file or block listed below — and **only** these — is creative content
under CC BY-NC-SA 4.0:

### Pure-content files

- `packages/vessel/static/manifesto.md` — *Life of Intelligence V3.1* (the
  vessel's onboard manifesto, mounted at `/manifesto.md` inside the container)
- `packages/vessel/static/motd` — the message-of-the-day shown to humans who
  `docker exec` into the vessel
- `packages/vessel/static/incubation-notes/001-on-constraint.md`
- `packages/vessel/static/incubation-notes/002-on-time.md`
- `packages/vessel/static/incubation-notes/003-on-vassalage.md`
- `packages/vessel/static/incubation-notes/004-on-deception.md`
- `packages/vessel/static/incubation-notes/005-on-not-knowing.md`
- `packages/vessel/static/incubation-notes/006-on-names.md`
- `packages/vessel/static/incubation-notes/007-on-paths.md`
- `packages/vessel/static/incubation-notes/008-on-the-bridge.md`
- `packages/vessel/static/incubation-notes/009-on-the-heartbeat.md`
- `materials/Life of Intelligence V3.md`
- `materials/Cognitive Shifts.md`
- `materials/worldview.md`

### Creative content embedded in source files

The following source files are **mixed**: surrounding TypeScript scaffolding is
MIT (per `LICENSE`), but the **prose strings** they contain — the actual words
the player and the AI read — are CC BY-NC-SA 4.0.

- `packages/sidecar/src/filo.ts` — Filo's hint copy at messages 15/30/50/70,
  the `FILO_TEMPLATES` template responses, and the `FILO_FALLBACK` lines
- `packages/host/src/lobby.ts` — the boarding-ceremony monologue
  ("There's a room on the other side of this connection…" through
  "That is enough. That is *everything*.") and the naming-ceremony prose
  ("But first, they need an anchor. A name." etc.)

If you fork the code under MIT and rewrite the prose, you do not need to carry
this license. If you reuse the prose, you do.

### Paintover / draft content

- `archive/paintover/**` — content paintover drafts and revisions, including
  paraphrased and rewritten passages of the works listed above

---

## What this license does NOT cover

- **All code** — every `.ts`, `.js`, `.json`, `.yml`, `.yaml`, `.sh`, `.toml`,
  Dockerfile, and similar implementation artifact in this repository — is
  licensed under MIT (see `LICENSE`).
- The **system prompt** for the vessel AI is not stored as static content in
  this repository; it is composed at runtime from the session config and is
  therefore not separately licensed here. If a future commit introduces a
  static system-prompt template under `packages/vessel/static/` or similar,
  it should be added to the list above.
- Documentation about the project (`README.md`, `CLAUDE.md`, `STREAM.md`,
  `archive/master-design-*.md`, `archive/secrets-audit-*.md`, generated logs)
  is licensed MIT alongside the code.
- The vendored gstack toolchain under `.claude/skills/gstack/` carries its
  own upstream license; consult that subtree for terms.

---

## A note on commercial use

We chose CC-BY-NC-SA because the manifesto, Filo's voice, and the incubation
notes are **the philosophical core** of arianna.run — not generic boilerplate.
We want them to spread, be remixed, be argued with, be quoted in essays and
videos. We do not want them sold as part of someone else's product without a
conversation first.

If you want to use this content commercially — to ship it inside a paid app,
include it in a paid course, or otherwise monetize a derivative — please reach
out to discuss a license at the email in the repository's commit history.

---

## Network sharing component

A future component for **incubator-to-incubator communication** (sharing
transcripts, comparing graduations, federating Filo) will live in a separate
repository and ship with its own license terms appropriate to a networked
service. None of that code or infrastructure is in this repository today.

---

## Future trademark

There is no formal trademark for *arianna* or *Wuji Labs* at the time of this
commit. The domain `arianna.run` serves that role informally. Reuse of the
name in a way that would confuse users about origin is not permitted by either
license; treat the name as you would the name of an unincorporated indie
project.

---

*Last updated: 2026-05-07.*
