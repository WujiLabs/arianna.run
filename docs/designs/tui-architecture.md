# TUI Architecture (v0 — placeholder)

Working notes for the host TUI as it accumulates surfaces. **This is a v0 sketch**, not a committed design. We'll implement a first cut, feel the look, then iterate.

## Current surfaces (Phase 3b)

| Surface | Type | Trigger |
|---|---|---|
| Boarding scene | Fullscreen, sequential | Launch (unless `SKIP_BOARDING=1`) |
| Chat view | Persistent main view | Default after boarding |
| Memory indicator | Inline component in chat | Always present |
| `/map` | TBD modal | Slash command |

## Adding in Phase 3.5

| Surface | Type | Trigger |
|---|---|---|
| Bookmark divider | Inline scrollback element | SSE `bookmark` event |
| `/manifesto` | Modal pager | Slash command (gated on unlock) |

## Inline element visual weight (v0 ranking)

From loudest to quietest in chat scrollback:
1. Filo speech (`magenta`, prefix, sometimes box) — pulls attention
2. AI response (white, AI name prefix) — main signal
3. Player input (blue, "You: ") — main signal
4. System notices (yellow, bracketed, e.g. `[Reconnecting...]`) — utility
5. Bookmark divider (dim, no prefix) — ambient
6. Memory indicator (corner, color-coded) — ambient

Open question: bookmarks need to be noticeable enough that the player remembers they exist, but quieter than Filo. "Dim italic divider with the section number centered" is the v0 guess. May need to add a subtle color or unicode flourish if it disappears in practice.

## Modal pattern (v0)

Both `/map` and `/manifesto` are modals — they take over the screen, capture input, and have an exit (Esc / `q` / `/back`). pi-tui doesn't have a built-in modal stack yet; for v0, the host swaps the root container and remembers the previous one for restore on exit.

If Phase 4 adds snapshot DAG view and Phase 5 adds lobby, more modals will follow. At ~3 modals we should formalize a `ModalStack` helper. Not yet.

## Pager pattern (v0)

`/manifesto` needs scrollable Markdown. pi-tui has a `Markdown` class but no Pager. v0 plan: render the full Markdown into a Container, track an offset, slice visible lines on each render, arrow keys move offset. Crude but enough to feel out the shape. Promote to a real `Pager` class if `/map` and future surfaces need it.

## Slash command surface (v0)

| Command | Status |
|---|---|
| `/map` | Existing |
| `/manifesto` | New, gated on unlock |
| `/help` | Not yet — add when there are 3+ commands |

No discovery affordance yet. Players will learn from documentation or by trying. Acceptable for v0.

## What this doc is NOT

- A committed information architecture
- A state machine specification
- A pixel-level visual spec
- A pi-tui contribution proposal

It's a thinking surface to revisit after Phase 3.5 ships and we can see the system in motion.

## Revisit triggers

Promote to v1 (real design doc) when any of these happens:
- 3+ slash commands exist
- 2+ modal types exist
- A user (or playtest) reports getting lost
- Phase 4 lands (snapshot DAG demands real navigation)
