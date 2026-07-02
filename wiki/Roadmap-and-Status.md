# Roadmap & Status

Compass is **100% local today.** This page tracks what's shipped vs. planned. The authoritative,
PR-by-PR ledger is [`docs/implementation_plan.md`](https://github.com/sandgraal/compass/blob/main/docs/implementation_plan.md);
the strategy behind the next phase is the June expert panel,
[`docs/strategic-review-2026-06.md`](https://github.com/sandgraal/compass/blob/main/docs/strategic-review-2026-06.md).

> **Current release: v0.16.0.** **Legend:** ✅ shipped · 🟡 partial · 🔜 planned · ⬜ not started. Items
> marked *(opt-in cloud)* are a deliberate, clearly-bounded departure from local-only — always opt-in.

## Feature matrix

| Area | Shipped (✅) | Ahead (🔜) |
|---|---|---|
| **💰 Finance** | CSV/PDF/Excel ingest · auto-categorization · net worth + trajectory · 90-day forecast (base-currency rollup) · subscription/price-hike audit · budgets · Schedule C/E + capex tax tagging + tax-pack export · **SimpleFIN** bank+card sync (recommended; incl. Amex) · **Plaid** (advanced) · investment holdings (generic brokerage-CSV import) · **multi-currency** (`fx_rates`, live FX fetch, unrealized FX gain/loss) · **expat tax** (FBAR/FATCA + foreign-accounts vault) · **CR Airbnb/property P&L** + Schedule E depreciation · **[Retirement](Cross-Border-and-Retirement)** — long-horizon accumulation/decumulation projection with SS claiming-age + sequence-of-returns stress · **CR Rental Studio** — short-term-rental pricing/P&L | email receipts · live brokerage/IRS/crypto feeds |
| **🗂️ Storehouse** | Contacts + Universal Export · Subscriptions · **Merchants & Places** (surfaced from the Timeline) · Assets · **unified Overview home page** (`/overview`, the app's default landing route) · **cross-reference engine** (derived People/Merchants/Places/Subs projected from the Timeline, one-click promote) · **Drop Zone** + **Timeline** (~44 recognizers) · **People** directory · "on this day" · Data-Rights Concierge · assisted-login portal pull (SSA, *beta*) | documents store · medical records · reverse connectors (CardDAV) |
| **📚 Knowledge** | markdown notes · `[[wikilinks]]` + backlinks · TipTap editor · full-text + semantic search · Spotlight mirror · Obsidian bridge · Notion import | Notion export · web clipper |
| **🔐 Vault** | AES-256-GCM categories · OS-Keychain key · auto-lock · 1Password CSV import | encrypted sharing with a trusted partner |
| **📅 Calendar** | Google Calendar · Apple Calendar (local `.ics`, RRULE) | Outlook / Office 365 · CalDAV |
| **✅ Tasks & habits** | daily/weekly/monthly checklists · habit streaks · tray quick-capture · multi-type capture (task/note/expense) · `compass://` URLs · Todoist · Things 3 | Apple Reminders · voice capture |
| **🤖 Assistant** | RAG over your notes · BYO Anthropic/OpenAI key · local Ollama · agentic mode (tool-use → Claude Inbox) · proactive insights · Morning Brief (low-cash + price-hike alerts) | richer agent tools |
| **🔎 Search** | global ⌘K across notes, tasks, vault titles, transactions · Timeline FTS + semantic | — |
| **🔗 Integrations** | Google · GitHub · Gmail · SimpleFIN · Plaid · Apple Calendar · Linear · Todoist · Things · Notion · Obsidian | Slack · Jira · Strava/Apple Health · browser extension |
| **🧩 Platform** | local MCP server · encrypted backup/restore · auto-update · sidebar grouped into 7 domain sections (Home, People & Places, Money, Planner, Knowledge, Your Data, System) | plugin API + marketplace · webhooks · E2E-encrypted sync *(opt-in cloud)* · mobile companion |
| **🤝 Claude** | MCP (read + propose) · Claude Inbox · `.mcpb` Desktop bundle · end-user plugin + 5 skills · embedded agentic Ask Compass · `compass_timeline` tool | more agent tools |

## Phase ledger (high level)

- **Phases 0–8** — ✅ **complete.** Agent infra · critical fixes · PRD features · beyond-PRD polish ·
  finance forward (net worth, forecast, tax, Plaid, **SimpleFIN**) · code-health debt · daily-driver
  (Track A/E) · **bidirectional Claude integration** (MCP, Inbox, `.mcpb`, plugin, skills, agent).
- **Phase 7** — 🟡 **in progress.** Track A ✅ · B 🟡 (Obsidian/Notion-import/Linear/Todoist/Things
  shipped; Slack/Jira/Reminders/Outlook/web-clipper open) · C 🟡 · D ⬜ (sync/mobile) · E ✅ · F 🟡.
- **Phase 9 — The Storehouse** — 🟡 **~70%.** Contacts, Subscriptions, Assets, overview ✅; documents,
  medical, reverse-connectors open. See **[Storehouse & Timeline](Storehouse-and-Timeline)**.
- **Storehouse redesign** — ✅ **shipped.** Cross-reference engine that projects the Timeline into
  derived People/Merchants/Places/Subscriptions with one-click promote; Subscriptions and
  Merchants & Places surfaced directly from the Timeline; sidebar regrouped into 7 domain
  sections; unified **Overview** home page (`/overview`) as the new default landing route. See
  **[Storehouse & Timeline](Storehouse-and-Timeline)**.
- **Phase 10 — The Acquisition Engine** — 🟡 **~40%.** Drop Zone + Timeline + ~44 recognizers ✅;
  Data-Rights Concierge ✅; CRED sandbox ✅ (gated); Converse/Connect/Curate ✅; deeper sources + full
  CRED open. See **[Data Rights & Acquisition](Data-Rights-and-Acquisition)**.
- **Phase 11 — Life Planning & Cross-Border** — ✅ **complete (2026-06-30).** All 7 items shipped:
  multi-currency, expat tax (FBAR/FATCA), Airbnb/CR-property P&L, long-horizon retirement
  projection, residency/days-in-country, goals, estate. See
  **[Cross-Border & Retirement](Cross-Border-and-Retirement)**.
- **Retirement + CR Rental Studio** — ✅ **shipped (v0.16.0).** The retire-early-hub engine ported
  into Compass as two new top-level pages: **Retirement** (tax-aware Monte-Carlo-style projection,
  deep-integrated with net worth/FX) and **CR Rental Studio** (short-term-rental pricing/P&L),
  superseding the standalone Phase 11.4 retirement engine.

## Related

- [Claude & MCP](Claude-and-MCP) · [Concepts & Architecture](Concepts-and-Architecture) ·
  [Cross-Border & Retirement](Cross-Border-and-Retirement)
