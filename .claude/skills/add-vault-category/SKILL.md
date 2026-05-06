---
name: add-vault-category
description: Adds a new vault category (e.g. "academic", "subscriptions") with field templates. Auto-loads when user asks to add a vault category, encrypted data type, or new sensitive entry kind.
---

# Adding a vault category

## Files you'll touch

| File | What you add |
|---|---|
| `electron/ipc/vault.ts` | Append to `VAULT_CATEGORIES` array |
| `src/pages/Vault.tsx` | Append to `FIELD_TEMPLATES` and `CATEGORY_ICONS` |

## Step 1 — Backend (`electron/ipc/vault.ts`)

```typescript
const VAULT_CATEGORIES = [
  // existing entries...
  {
    id: '<id>',                 // lowercase, single word
    label: '<Label>',           // user-facing
    icon: '<lucide-icon-name>', // matches lucide-react export
    description: '<one-line>'
  }
]
```

The `id` is what gets used as the encrypted blob filename: `.vault/<id>.enc`.

## Step 2 — Frontend (`src/pages/Vault.tsx`)

Add the icon to `CATEGORY_ICONS`:
```typescript
import { ..., NewIcon } from 'lucide-react'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  // existing entries...
  '<id>': <NewIcon size={16} />
}
```

Add the field template to `FIELD_TEMPLATES`:
```typescript
'<id>': [
  { key: 'name', label: 'Name' },
  { key: 'identifier', label: 'Identifier', sensitive: true },  // sensitive = masked + reveal toggle
  { key: 'expiryDate', label: 'Expiry Date' },
  { key: 'notes', label: 'Notes' }
]
```

Field guidelines:
- `key` is the persisted JSON key (lowercase camelCase)
- `label` is user-facing
- `sensitive: true` triggers masking + reveal-eye + clipboard-clear-after-30s
- Always include a `notes` field for freeform context
- Order matters — most-important field first; it's used as the entry's display title

## Step 3 — Optional: 1Password CSV mapping

If your category corresponds to a 1Password item type, update `vault:import-1password-csv` in `electron/ipc/vault.ts` to route to your new category. Currently:
- Logins → `credentials`
- Credit cards → `financial`

Add a new branch like:
```typescript
} else if (type.includes('software license')) {
  // route to your new 'license' category
}
```

## Step 4 — Verify

```bash
npm run typecheck && npm run check
```

Then in the app:
1. Open Vault → new category appears in sidebar
2. Click "+ Add entry" → form shows your fields
3. Save → reload → entry persists encrypted
4. Edit → history snapshot captures previous values

## Hard rules

- **All sensitive fields stay encrypted at rest.** The category file is a single AES-256-GCM blob; no per-field encryption.
- **Don't break existing categories.** Adding entries is additive — never delete or rename existing category IDs (would orphan blob files).
- **Match the visual pattern.** Use the same `Card` + `EntryCard` + reveal/copy pattern; don't invent a new UI per category.
