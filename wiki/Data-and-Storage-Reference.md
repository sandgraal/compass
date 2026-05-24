# Data & Storage Reference

Everything Compass stores lives under your OS application-data directory. On macOS (the primary
target) that's:

```
~/Library/Application Support/Compass/
├── .data/
│   ├── compass.db                    # SQLite database (better-sqlite3)
│   ├── knowledge-embeddings.json     # local semantic-search index
│   └── claude-inbox.jsonl            # append-only proposals from Claude (MCP)
├── .vault/
│   ├── key.enc                       # master key, sealed by OS Keychain
│   ├── <category>.enc                # AES-256-GCM secret blobs (financial, identity, …)
│   ├── oauth-<service>.enc           # encrypted OAuth tokens
│   ├── plaid.enc                     # Plaid access tokens
│   └── assistant.enc                 # BYO AI key
└── knowledge-base/
    └── <category>/*.md               # plain-markdown notes (+ .prev snapshots)
```

> **`COMPASS_HOME`** env var redirects the *entire* store to a throwaway directory — used for tests,
> demo seeding, and screenshots so the real store is never touched. See [FAQ & Troubleshooting](FAQ-and-Troubleshooting).

## Encryption at a glance

| Store | Encrypted? | Key |
|---|---|---|
| `compass.db` | No | — |
| `knowledge-base/*.md` | No (you own them) | — |
| `knowledge-embeddings.json`, `claude-inbox.jsonl` | No (no secrets) | — |
| `.vault/*.enc` | **Yes** (AES-256-GCM) | master key in OS Keychain via `safeStorage` |

## Database schema (SQLite via Drizzle)

The DB lives at `.data/compass.db`. Key tables:

| Table | Purpose |
|---|---|
| `integrations` | One row per service (google, github, …): status, scopes, last sync, per-integration `syncIntervalMinutes`. |
| `sync_events` | Append-only log of every sync attempt (records updated, errors). |
| `checklist_items` | Daily/weekly/monthly tasks. `source` = manual / github / calendar / gmail. |
| `checklist_templates` | User-edited markdown templates per list type. |
| `calendar_events` | Cached calendar events from any source. |
| `github_items` | Issues + PRs + project items. |
| `gmail_actions` | Action items extracted from Gmail. |
| `drive_files` | Google Drive file index. |
| `knowledge_files` | Index of `knowledge-base/*.md` (path, title, word count). |
| `knowledge_suggestions` | Pending edits proposed by the regex / Ollama suggestion pipeline. |
| `app_settings` | Key/value (`syncInterval`, `theme`, weekly goals, `quickCaptureShortcut`, …). |
| `finance_accounts` | Bank / credit / investment / debt accounts (asset class, payment day, Plaid linkage, mask, institution). |
| `plaid_items` | One row per connected Plaid Item; sync cursor + last sync + error surface. **Tokens are NOT here** (they're in `.vault/plaid.enc`). |
| `finance_transactions` | Transactions, hashed for dedup; indexed `geo`, `purpose`, `(taxYear, taxTag)`. |
| `finance_balance_snapshots` | Per-(account, day) balance for net-worth trajectory. Source = manual / inferred / plaid. |
| `forecast_overrides` | User skip / shift / override edits to the projected cash-flow stream. UNIQUE on `(account_id, date, label)`. |
| `budget_rules` | Per-category monthly budget targets. |
| `categorization_rules` | Pattern → category rules for auto-categorization. |
| `habits` | User-defined habits (icon + color). |
| `habit_entries` | Per-habit-per-day completion (boolean). |
| `claude_proposals` | Claude Inbox queue: proposals ingested from `claude-inbox.jsonl`, dedup by MCP `proposal_id`, with `status` (pending/approved/rejected/failed). |

Full column-level detail and migration history:
[`docs/architecture.md`](https://github.com/sandgraal/compass/blob/main/docs/architecture.md#database-drizzle--sqlite-via-better-sqlite3)
and `electron/db/schema.ts`.

## Date handling

Date-only columns (`finance_transactions.date`, `habit_entries.date`) use the **local calendar
day**, not UTC, so they don't drift across time zones or DST. (One known exception:
`checklist_items.list_date` is currently UTC-keyed — a tracked cleanup.)

## Related

- [Security & Privacy](Security-and-Privacy) · [Backup & Restore](Backup-and-Restore) · [Developer Guide](Developer-Guide)
