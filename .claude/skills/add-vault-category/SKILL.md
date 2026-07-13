---
name: add-vault-category
description: Adds a new life-record category (e.g. "academic", "vehicles") or — rarely — a new sealed vault category. Auto-loads when user asks to add a vault category, life-record category, encrypted data type, or new sensitive entry kind.
---

# Adding a category (life records vs the vault)

Since the vault split (2026-07) there are TWO stores; pick the right one first:

- **Life records** (`life_records` table, plaintext, searchable, timeline-projected,
  AI/MCP-readable) — for LIFE DATA: documents, accounts, policies, memberships.
  Individual SECRET fields (an account number, an ID number) can still be marked
  `secret: true` — those values are encrypted in `.vault/record-secrets.enc` and
  never touch the DB. **This is almost always what you want.**
- **The vault** (`.vault/<id>.enc`, sealed from search bodies, the assistant, and
  the MCP) — ONLY for data that is secret in its entirety, like `credentials`
  (passwords/API keys) and `genetics` (raw genotype). Adding one of these should
  be rare and needs a data-access-policy justification.

## A) New LIFE-RECORD category (the normal case)

| File | What you add |
|---|---|
| `electron/lib/life-records.ts` | Append to `LIFE_CATEGORIES` (id, label, icon, description, `fields` with optional `secret: true`); add a `TITLE_FIELDS_BY_CATEGORY` entry |
| `src/pages/LifeRecords.tsx` | Add the icon to `CATEGORY_ICONS` + mirror the category in `FALLBACK_CATEGORIES` (non-Electron dev preview) |
| `electron/integrations/assistant-tools.ts`, `mcp/compass-mcp/index.ts` | Extend the `category` enum in `search_life_records` / `compass_life_records` input schemas |

```typescript
// electron/lib/life-records.ts
{
  id: '<id>',                 // lowercase, kebab-case ok
  label: '<Label>',
  icon: '<lucide-icon-name>',
  description: '<one-line>',
  fields: [
    { key: 'name', label: 'Name' },                              // plaintext metadata
    { key: 'identifier', label: 'Identifier', secret: true },    // encrypted in the vault blob
    { key: 'expiryDate', label: 'Expiry Date' }
    // no `notes` — it's a dedicated column, the page always renders it
  ]
}
```

Field guidelines:
- `key` is the persisted JSON key (camelCase); `label` is user-facing.
- `secret: true` routes the VALUE to `.vault/record-secrets.enc` (never the DB)
  and gives it the masked reveal/copy UI. Everything else is plaintext and
  searchable — that's the point.
- Add the display-title priority to `TITLE_FIELDS_BY_CATEGORY` (first non-empty
  field becomes the record title).
- Everything else (CRUD, spine projection, ⌘K, CSV export, MCP) picks the new
  category up automatically from `LIFE_CATEGORIES`.

Verify: `npm run typecheck && npm run check`, then in the app: Life Records →
new category in the sidebar → Add record → secret fields show the lock →
record appears in ⌘K and on the Timeline; secrets only after Reveal.

## B) New SEALED vault category (rare)

Only for credentials-like data. Justify against `docs/data-access-policy.md`
(exceptions 2–3) first, and update that document in the same PR.

| File | What you add |
|---|---|
| `electron/ipc/vault.ts` | Append to `VAULT_CATEGORIES` (the `id` becomes `.vault/<id>.enc`) |
| `src/pages/Vault.tsx` | Append to `FIELD_TEMPLATES` (`sensitive: true` = masked + reveal + clipboard-clear) and `CATEGORY_ICONS` |
| `electron/ipc/search.ts` | Decide the ⌘K exposure: title-only allowlist entry in `TITLE_FIELDS_BY_CATEGORY` + `VAULT_CATEGORIES`, or fully unsearchable (like `genetics`) |

## Hard rules

- **Secret values never touch `compass.db`, any index, exports, or an AI surface.**
  For life records that's the `secret: true` routing; for the vault it's the blob.
- **Don't break existing categories.** Never delete or rename existing category
  IDs — life-record rows key on `category`, vault blobs on the filename.
- **Match the visual pattern.** Reuse the existing card + reveal/copy affordances;
  don't invent a new UI per category.
- **1Password CSV mapping** (`vault:import-1password-csv` in `electron/ipc/vault.ts`):
  Logins → vault `credentials`; Credit cards → a `financial` life record via
  `insertLifeRecord`. Extend there if your category maps to a 1Password type.
