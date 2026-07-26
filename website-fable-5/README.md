# Skein website — Fable 5 rewrite

A ground-up rewrite of the Skein marketing, introduction, and usage site,
authored by **Claude Fable 5** (the folder name marks the authorship). It is a
zero-dependency static artifact: serve this directory as the document root; no
build step, no remote fonts, no analytics, no third-party scripts.

## Design language

Neutral near-black surfaces (no blue cast), one luminous mint accent used
sparingly (an italic accent word per headline, stat numbers, the primary CTA),
micro mono-caps labels, tight display type, hairline borders, a faint masked
grid texture behind the hero and CTA, and floating evidence chips around the
terminal. Light theme derives from the same tokens.

## Bilingual (EN / 中文)

Every visible string exists twice in the DOM, tagged `lang="en"` /
`lang="zh-CN"`; CSS shows exactly one based on the `html[lang]` attribute. A
pre-paint inline script picks the language from `localStorage["skein-lang"]`
or `navigator.language`, so the first paint is already in the right language,
no-JS readers get complete English content, and both languages stay indexable.
The header toggle (中 / EN) persists the choice; `check.mjs` enforces string
parity between the two languages on every page.

## Pages

- `index.html` — marketing landing page (hero terminal story, workflow, capabilities, trust, quickstart, FAQ).
- `guide.html` — introduction and everyday usage: install, connections, the command table, TUI keys, the headless exit-code contract, recovery, and invariants.
- `404.html` — branded not-found page.

## What this rewrite fixes over `website/`

- One shared design system (`styles.css`) instead of two divergent ones; both pages cross-link and carry distinct titles, descriptions, and canonicals.
- Provider claims are consistent everywhere (OpenAI Responses, OpenAI Chat, Anthropic Messages, Gemini — plus compatible relays for the OpenAI and Anthropic protocols), matching `src/providers/`.
- No version-pinned counts that rot ("NNN tests", "vitest NNN passed", release literals); `check.mjs` enforces this.
- Content is visible without JavaScript: the reveal animation's hidden state is gated on an `html.js` class set by a pre-paint inline script.
- The theme toggle persists (`localStorage["skein-theme"]`) and initializes before first paint on every page — no flash, shared across pages.
- A purpose-made 1200×630 social card (`assets/skein-og-card.png`) replaces the square mascot render for link unfurls.
- `check.mjs` verifies *both* pages and cross-checks the guide's exit-code table against `src/cli/headless-contract.ts` and `docs/headless-output.schema.json`, so usage documentation cannot drift from the product.

## Local verification

    node website-fable-5/check.mjs
    python3 -m http.server 4174 --directory website-fable-5

Open http://127.0.0.1:4174/.

## Deployment assumptions

- Canonical URL: https://lixiang12345.github.io/skein/ (this folder is a drop-in
  replacement candidate for `website/`; point the Pages workflow at it, or copy
  its contents over `website/`, to publish).
- Custom error page: `404.html`.
- Hosts that honor `_headers` get the included security and cache policy;
  GitHub Pages ignores that file.

## Regenerating the social card

`assets/og-card.html` is the card source. Re-render it with headless Chrome:

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --headless --screenshot=website-fable-5/assets/skein-og-card.png \
      --window-size=1200,630 --hide-scrollbars \
      "file://$(pwd)/website-fable-5/assets/og-card.html"
