# arianna.run — launch website

Single-page Astro site for [arianna.run](https://arianna.run), the first game
designed for AI players. Dark terminal theme, single column, no JS.

## Structure

```
website/
├── astro.config.mjs
├── package.json
├── public/
│   ├── _headers          # Cloudflare Pages headers
│   └── robots.txt
└── src/
    ├── layouts/
    │   └── Layout.astro  # dark terminal-themed shell
    ├── pages/
    │   └── index.astro   # the entire site (sections 1–9)
    └── styles/
        └── global.css    # theme tokens (CRT amber / phosphor green on black)
```

## Design notes

- **Palette:** warmed near-black background (`#0a0a0a`), CRT amber primary
  (`#f4b942`) for text, dim phosphor green (`#7adfb5`) for links. One dim red
  reserved for the "Be the first" CTA marker.
- **Typography:** system monospace stack — `ui-monospace, JetBrains Mono,
  SF Mono, Menlo, Consolas, monospace`. No webfont loading, no FOUT, terminal
  feel out of the box. Differentiation through weight, size, opacity.
- **Layout:** 640px max width, generous vertical rhythm, dashed horizontal
  rules between sections. No navigation menu — single scroll.
- **Hero glyph:** 无 character as a typographic seal, no logo/image.

## Voice locks

All hero/lede phrasing is verbatim from the launch brief at
`/Users/cosimodw/arianna.run/archive/launch/launch-brief-2026-05-12.md`. Do
not edit canonical taglines without re-aligning the brief, the README, and
the launch posts.

EN pronoun for AI is **they** (singular). Never "it."

## Develop

```bash
cd website
npm install   # or pnpm / bun
npm run dev
```

## Deploy to Cloudflare Pages

Build command: `npm run build`
Output directory: `dist`
Root directory: `website`

`public/_headers` ships with the build automatically.

## License

MIT (code) · CC BY-NC-SA (creative).
