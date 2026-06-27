# Compass Wiki

**Your private life, in one place — and it never leaves your machine.**

Compass is a **local-first personal life OS**: a single, fast desktop app that unifies your
finances, knowledge, calendar, tasks, habits, and an AI assistant. There is **no Compass
cloud account and no Compass server** — all your data lives on your disk. The only bytes that
ever leave your machine are OAuth tokens you explicitly grant (to pull *your own* Google /
GitHub / bank data) and BYO-key AI requests you trigger.

> This wiki is the complete user + contributor manual. The repository's [`docs/`](https://github.com/sandgraal/compass/tree/main/docs)
> folder remains the canonical design/architecture source; this wiki turns it into navigable,
> task-oriented documentation.

---

## Start here

| If you want to… | Go to |
|---|---|
| Install and take the first-run tour | **[Getting Started](Getting-Started)** |
| Understand how Compass is built and why it's private | **[Concepts & Architecture](Concepts-and-Architecture)** |
| Use a specific feature | See the **Features** list below |
| Connect Google / GitHub / your bank | **[Integrations](Integrations)** |
| Hack on the code | **[Developer Guide](Developer-Guide)** |

## Features

- **[Dashboard](Dashboard)** — your morning brief: today's tasks, money, and calendar at a glance.
- **[Planner: Daily / Weekly / Monthly](Planner-Daily-Weekly-Monthly)** — checklists, templates, reviews, and habit streaks.
- **[Knowledge Base](Knowledge-Base)** — markdown notes with `[[wikilinks]]`, backlinks, full-text + semantic search.
- **[Finance](Finance)** — net worth, 90-day cash-flow forecast, subscription audit, budgets, tax tagging, SimpleFIN/Plaid bank sync.
- **[Storehouse & Timeline](Storehouse-and-Timeline)** — Contacts, Subscriptions, Assets, and the Drop Zone that turns any data export into one searchable life Timeline.
- **[People](People)** — a unified directory of everyone across your imported data.
- **[Data Rights & Acquisition](Data-Rights-and-Acquisition)** — go *get* the data you have a right to: the Drop Zone, the Data-Rights Concierge, and assisted-login portal pulls.
- **[Vault](Vault)** — AES-256-GCM encrypted secrets; master key in the OS Keychain.
- **[Ask Compass](Ask-Compass)** — a RAG assistant grounded in *your* notes (BYO key, local-Ollama-first).
- **[Integrations](Integrations)** — Google, GitHub, SimpleFIN/Plaid, Apple Calendar, Linear, Todoist, Things, Notion, Obsidian.
- **[Claude & MCP](Claude-and-MCP)** — MCP (read + propose) for Claude Code/Desktop + the human-approved Claude Inbox.
- **[Search & Command Palette](Search-and-Command-Palette)** — global ⌘K, tray quick-capture, `compass://` URLs.
- **[Settings](Settings)** — appearance, sync, security, data, AI, updates, backup.

## Reference

- **[Security & Privacy](Security-and-Privacy)** — the threat model and the guarantees.
- **[Backup & Restore](Backup-and-Restore)** — encrypted backups, data export/wipe, auto-update.
- **[Data & Storage Reference](Data-and-Storage-Reference)** — where every file lives; the DB schema.
- **[Roadmap & Status](Roadmap-and-Status)** — the feature matrix and what's shipped vs. planned.
- **[Cross-Border & Retirement](Cross-Border-and-Retirement)** — the Phase 11 direction (multi-currency, expat tax, retirement).
- **[FAQ & Troubleshooting](FAQ-and-Troubleshooting)** — gotchas and fixes.

---

*Compass is Electron 41 + React 18 + TypeScript + Drizzle/SQLite + TipTap. Primary target is macOS;
Windows and Linux builds exist. Current version: see [`package.json`](https://github.com/sandgraal/compass/blob/main/package.json).*
