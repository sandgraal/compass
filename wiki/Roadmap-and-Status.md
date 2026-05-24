# Roadmap & Status

Compass is **100% local today.** This page tracks what's shipped vs. planned. The authoritative,
PR-by-PR ledger is [`docs/implementation_plan.md`](https://github.com/sandgraal/compass/blob/main/docs/implementation_plan.md).

> **Legend:** ✅ Available today · 🔜 Planned. Items marked *(opt-in cloud)* are a deliberate,
> clearly-bounded departure from local-only — always opt-in, never the default.

## Feature matrix

| Area | Shipped (✅) | Planned (🔜) |
|---|---|---|
| **💰 Finance** | CSV/PDF/Excel ingest · auto-categorization · net worth + trajectory · 90-day forecast · subscription/price-hike audit · budgets · Schedule C/E + capex tax tagging + tax-pack export · Plaid bank-linking | receipts via email · investment holdings |
| **📚 Knowledge** | markdown notes · `[[wikilinks]]` + backlinks · TipTap editor · full-text + semantic search · Spotlight mirror | Obsidian/Notion import-export · web clipper |
| **🔐 Vault** | AES-256-GCM categories · OS-Keychain key · auto-lock · 1Password CSV import | encrypted sharing with a trusted partner |
| **📅 Calendar** | Google Calendar · Apple Calendar (local `.ics`, RRULE) | Outlook / Office 365 · CalDAV |
| **✅ Tasks & habits** | daily/weekly/monthly checklists · habit streaks · tray quick-capture · `compass://` URLs | Todoist / Things / Reminders sync · voice capture |
| **🤖 Assistant** | RAG over your notes · BYO Anthropic/OpenAI key · local Ollama | proactive insights · agentic "plan my week" |
| **🔎 Search** | global ⌘K across notes, tasks, vault titles, transactions | — |
| **🔗 Integrations** | Google · GitHub · Gmail action items · Plaid · Apple Calendar | Slack · Linear/Jira · Apple Health/Strava · browser extension |
| **🧩 Platform** | local MCP server · encrypted backup/restore · auto-update | public plugin API + marketplace · opt-in E2E-encrypted sync · mobile companion |
| **🤝 Claude** | read-only MCP for Claude Code · BYO-key Ask Compass · confirmed-write Claude Inbox | Claude Desktop + Cowork connectors · embedded Agent SDK ("plan my week") · Compass skills |

## Phase ledger (high level)

- **Phase 0 / 0+ / 0++** — agent infrastructure & Claude Code platform refresh.
- **Phase 1** — critical bug fixes.
- **Phase 2** — remaining PRD features.
- **Phase 3** — beyond-PRD product improvements.
- **Phase 4** — finance forward roadmap (net worth, forecast, tax, Plaid). *Shipped.*
- **Phase 5** — bounded UX wins (backup, global search, semantic search, Apple Calendar, tax pack,
  Ask Compass, Spotlight mirror) + strategic-review follow-ups.
- **Phase 6** — code-health debt.
- **Phase 7** — daily-driver & platform roadmap *(proposed)*: morning brief, more integrations,
  plugin API, opt-in sync, intelligence, polish.
- **Phase 8** — Claude integration *(bidirectional)*: **8.1 MCP expansion ✅**, **8.2 Claude Inbox ✅**,
  8.3 Claude Desktop connector 🔜, 8.4 Cowork plugin 🔜, 8.5 embedded Agent SDK 🔜, 8.6 Compass skills 🔜.

## Roadmap tracks (Phase 7)

- **Track A · Daily driver** — morning brief digest, evening/weekly review ritual, voice + global capture.
- **Track B · Integrations** — Notion/Obsidian, Slack, Linear/Jira, Outlook/CalDAV, Apple Health/Strava, web clipper.
- **Track C · Platform & API** — plugin/extension API, integrations marketplace, webhooks + expanded MCP.
- **Track D · Sync & reach** *(opt-in cloud)* — E2E-encrypted sync, mobile companion, encrypted sharing.
- **Track E · Intelligence** — proactive insights, agentic "plan my week".
- **Track F · Polish** — theming, mobile-responsive, accessibility pass.

## Related

- [Claude & MCP](Claude-and-MCP) · [Concepts & Architecture](Concepts-and-Architecture)
