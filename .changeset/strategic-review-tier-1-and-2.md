---
'compass': minor
---

Phase 5 — strategic-review follow-ups (Tier 1 + Tier 2 + cross-platform):

- **Encrypted backup / restore (5.1)** — passphrase-derived AES-256-GCM bundle of every SQLite table, knowledge markdown file, and `.vault/*.enc` blob (master key wrapper included). One file, restorable on any new machine with just the passphrase. New `backup:create` / `backup:restore` IPC + Settings panel + 7 round-trip tests.
- **Global ⌘K search (5.2)** — Command Palette now searches knowledge bodies, vault titles (never bodies), task titles, and transaction descriptions, ranked and inlined under the existing nav commands.
- **Wikilinks + backlinks (5.3)** — `[[note]]` and `[[note|alias]]` syntax renders as clickable links in the editor; new "backlinks" panel lists every note linking to the current file. Clicking an unresolved wikilink offers to create the target.
- **Tax-pack export (5.4)** — One-click CSV-per-Schedule-C/E/capex/charitable/medical export from the YTD Tax summary card, plus a manifest. CPA-ready / TurboTax-importable.
- **Subscription price-hike alerts (5.5)** — Recent-vs-historical median comparison flags real price increases (not just noise). UI surfaces a `+X%` chip per row and a top-of-table projected annual impact banner.
- **Windows + Linux build targets (5.6)** — `electron-builder` config now emits Windows `nsis` + `portable` and Linux `AppImage` + `deb`, with `release.yml` fanning out into three OS jobs.

All landed with typecheck + 340 tests green and zero new Biome errors.
