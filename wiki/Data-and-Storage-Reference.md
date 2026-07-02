# Data & Storage Reference

Everything Compass stores lives under your OS application-data directory. On macOS (the primary
target) that's:

```
~/Library/Application Support/Compass/
├── .data/
│   ├── compass.db                    # SQLite database (better-sqlite3)
│   ├── knowledge-embeddings.json     # local semantic-search index (knowledge)
│   ├── records-embeddings.json       # local semantic-search index (Timeline records)
│   └── claude-inbox.jsonl            # append-only proposals from Claude (MCP)
├── .vault/
│   ├── key.enc                       # master key, sealed by OS Keychain
│   ├── <category>.enc                # AES-256-GCM secret blobs (financial, identity, …)
│   ├── oauth-<service>.enc           # encrypted OAuth tokens
│   ├── simplefin.enc                 # SimpleFIN Access URL
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

The DB lives at `.data/compass.db`. Key tables (34 total; latest migration `0025`):

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
| `finance_accounts` | Bank / credit / investment / debt accounts (asset class, payment day, Plaid/SimpleFIN linkage, mask, institution). |
| `simplefin_connections` | One row per SimpleFIN connection (the encrypted Access URL lives in `.vault/simplefin.enc`, **not** here). |
| `plaid_items` | One row per connected Plaid Item; sync cursor + last sync + error surface. **Tokens are NOT here** (they're in `.vault/plaid.enc`). |
| `finance_transactions` | Transactions, hashed for dedup; indexed `geo`, `purpose`, `(taxYear, taxTag)`. |
| `finance_balance_snapshots` | Per-(account, day) balance for net-worth trajectory. Source = manual / inferred / plaid. |
| `fx_rates` | Daily FX-rate snapshots (base/quote/rate), fetched or manual, powering base-currency net worth and FX gain/loss. UNIQUE on `(date, base, quote)`. |
| `forecast_overrides` | User skip / shift / override edits to the projected cash-flow stream. UNIQUE on `(account_id, date, label)`. |
| `budget_rules` | Per-category monthly budget targets. |
| `categorization_rules` | Pattern → category rules for auto-categorization. |
| `habits` | User-defined habits (icon + color). |
| `habit_entries` | Per-habit-per-day completion (boolean). |
| `claude_proposals` | Claude Inbox queue: proposals ingested from `claude-inbox.jsonl`, dedup by MCP `proposal_id`, with `status` (pending/approved/rejected/failed). |
| `linear_issues` | Assigned Linear issues (state, priority, team, due date). |
| `contacts` | vCard-structured address book (multi-valued phones/emails/addresses; `source` = manual/vcard/csv/macos/linkedin/facebook/gvoice). |
| `subscriptions` | First-class subscriptions (cost, cadence, status, next renewal) — distinct from detected recurring charges. |
| `assets` | Household inventory by `type` (insurance/vehicle/property/membership/warranty/pet/other) + renewal date. |
| `records` | The unified **Timeline** log: `source`, `type`, `occurredAt`, `payload`, content-addressed `hash` dedup (+ a `records_fts` FTS5 index). The Drop Zone's destination. |
| `derived_entities` | The cross-reference engine's cache: records projected into typed candidates (`kind` = person/merchant/place/subscription-candidate), with counts, sources, and a `promoted_id` once you promote one. Powers People and Merchants & Places. |
| `places` | The OWNED home for a promoted merchant or place (`kind` = merchant/place): name, category, address, url, rolled-up spend. The promote target for `derived_entities`. |
| `travel_segments` | Trips logged OUTSIDE the home country (country + inclusive date range), feeding the Residency tab's day-count/substantial-presence-test math. |
| `financial_goals` | Target-date savings goals (target amount, date, monthly contribution); current value is manual or auto-linked to net worth / retirement / property basis. Backs the Goals tab. |
| `rental_comps` | Comparable short-term-rental listings (zone, bedrooms, nightly rate, occupancy, rating) collected in the CR Rental Studio to price your own unit. |
| `snapshot_facts` | Static "who you are / what's set" facts from exports (ad-profile, profile, security config) behind themed pages. |

Full column-level detail and migration history:
[`docs/architecture.md`](https://github.com/sandgraal/compass/blob/main/docs/architecture.md#database-drizzle--sqlite-via-better-sqlite3)
and `electron/db/schema.ts`.

## Date handling

Date-only columns (`finance_transactions.date`, `habit_entries.date`) use the **local calendar
day**, not UTC, so they don't drift across time zones or DST. (One known exception:
`checklist_items.list_date` is currently UTC-keyed — a tracked cleanup.)

## Related

- [Security & Privacy](Security-and-Privacy) · [Backup & Restore](Backup-and-Restore) · [Developer Guide](Developer-Guide)
