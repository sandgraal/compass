/**
 * Life records — PURE logic for the vault split (2026-07; no Electron, no
 * Drizzle, individually testable).
 *
 * The old encrypted vault held five "document" categories (financial /
 * identity / medical / legal / foreign-accounts) that were mostly ordinary
 * life data with a couple of genuinely secret field values mixed in. The
 * split moves the METADATA into the plaintext `life_records` table (usable by
 * search, the timeline, the assistant, and the MCP server) and keeps only the
 * SECRET field values encrypted, in the standalone `.vault/record-secrets.enc`
 * blob keyed by row id (see electron/ipc/life-records.ts).
 *
 * This module defines what each category looks like, which fields are secret,
 * and how a legacy vault entry splits into `{title, fields, notes, secrets}`.
 * `credentials` and `genetics` are NOT life categories — they stay whole in
 * the vault, sealed from every surface.
 */

export interface LifeCategoryField {
  key: string
  label: string
  /** Stored encrypted in `.vault/record-secrets.enc`, never in the DB row. */
  secret?: boolean
}

export interface LifeCategory {
  id: string
  label: string
  /** lucide icon name, mirrored by the renderer's icon map. */
  icon: string
  description: string
  /**
   * Field templates (sans `notes`, which is a dedicated column). Non-secret
   * fields land in the row's `fields` JSON; secret ones in the vault blob.
   */
  fields: LifeCategoryField[]
}

export const LIFE_CATEGORIES: LifeCategory[] = [
  {
    id: 'financial',
    label: 'Financial',
    icon: 'banknote',
    description: 'Bank accounts, credit cards, investments',
    fields: [
      { key: 'institution', label: 'Institution' },
      { key: 'accountType', label: 'Account Type' },
      { key: 'lastFour', label: 'Last 4 Digits' },
      { key: 'accountNumber', label: 'Account Number', secret: true },
      { key: 'routingNumber', label: 'Routing Number', secret: true }
    ]
  },
  {
    id: 'identity',
    label: 'Identity',
    icon: 'id-card',
    description: "SSN, passport, driver's license",
    fields: [
      { key: 'documentType', label: 'Document Type' },
      { key: 'number', label: 'Number', secret: true },
      { key: 'issueDate', label: 'Issue Date' },
      { key: 'expiryDate', label: 'Expiry Date' }
    ]
  },
  {
    id: 'medical',
    label: 'Medical',
    icon: 'heart-pulse',
    description: 'Insurance, prescriptions, providers',
    fields: [
      { key: 'type', label: 'Type (insurance/rx/provider)' },
      { key: 'provider', label: 'Provider / Insurer' },
      // Member/group ids are billing-fraud-grade identifiers — secret, like
      // account numbers.
      { key: 'memberId', label: 'Member ID', secret: true },
      { key: 'groupNumber', label: 'Group Number', secret: true }
    ]
  },
  {
    id: 'legal',
    label: 'Legal',
    icon: 'scale',
    description: 'Contracts, wills, property documents',
    fields: [
      { key: 'documentType', label: 'Document Type' },
      { key: 'parties', label: 'Parties Involved' },
      { key: 'date', label: 'Date' },
      { key: 'location', label: 'Stored Location' }
    ]
  },
  {
    id: 'foreign-accounts',
    label: 'Foreign Accounts',
    icon: 'globe',
    description: 'FBAR/FATCA — foreign bank/securities accounts',
    fields: [
      { key: 'institution', label: 'Institution' },
      { key: 'country', label: 'Country' },
      { key: 'accountType', label: 'Account Type (bank / securities)' },
      { key: 'maxValueUsd', label: 'Max Value During Year (USD)' },
      { key: 'accountNumber', label: 'Account Number', secret: true }
    ]
  }
]

export const LIFE_CATEGORY_IDS = LIFE_CATEGORIES.map((c) => c.id)

export function isLifeCategory(category: string): boolean {
  return LIFE_CATEGORY_IDS.includes(category)
}

/** category → keys whose VALUES stay encrypted in the vault blob. */
export const SECRET_FIELDS_BY_CATEGORY: Record<string, string[]> = Object.fromEntries(
  LIFE_CATEGORIES.map((c) => [c.id, c.fields.filter((f) => f.secret).map((f) => f.key)])
)

/**
 * Preferred display-label fields per category, in priority order — lifted from
 * the old ⌘K vault search's title allowlist so migrated entries keep the same
 * label they had as vault hits.
 */
export const TITLE_FIELDS_BY_CATEGORY: Record<string, string[]> = {
  financial: ['institution', 'accountType'],
  identity: ['documentType', 'name'],
  medical: ['provider', 'type'],
  legal: ['title', 'documentType', 'parties'],
  'foreign-accounts': ['institution', 'country']
}

const MAX_TITLE = 120

/** First non-empty title field, else the category label. */
export function deriveTitle(category: string, fields: Record<string, string>): string {
  for (const key of TITLE_FIELDS_BY_CATEGORY[category] ?? []) {
    const v = fields[key]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, MAX_TITLE)
  }
  const cat = LIFE_CATEGORIES.find((c) => c.id === category)
  return cat ? `${cat.label} record` : 'Life record'
}

/** Vault-entry bookkeeping keys that must not migrate as data fields. */
const SYSTEM_KEYS = new Set(['id', 'createdAt', 'updatedAt', '_history', '_autoSeeded'])

/** `••••1234`-style masked stub (written by the old auto-seeder) → its digits. */
const MASKED_STUB = /^[•*]+(\d{2,6})$/

export interface SplitVaultEntry {
  title: string
  /** Non-secret fields for the plaintext row. */
  fields: Record<string, string>
  notes: string | null
  /** Secret field values for `.vault/record-secrets.enc`; empty = no secrets. */
  secrets: Record<string, string>
  createdAt: number | null
  updatedAt: number | null
}

/**
 * Split one legacy vault entry into its plaintext row + secret remnant.
 * System keys are stripped; `_history` is dropped (the renamed
 * `<category>.migrated.enc` backup preserves it). A masked `••••1234`
 * accountNumber stub is NOT a secret — it becomes the plaintext `lastFour`.
 */
export function splitVaultEntry(category: string, entry: Record<string, unknown>): SplitVaultEntry {
  const secretKeys = new Set(SECRET_FIELDS_BY_CATEGORY[category] ?? [])
  const fields: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  let notes: string | null = null

  for (const [key, raw] of Object.entries(entry)) {
    if (SYSTEM_KEYS.has(key)) continue
    const value = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null
    if (value == null || !value.trim()) continue
    const v = value.trim()
    if (key === 'notes') {
      notes = v
      continue
    }
    if (secretKeys.has(key)) {
      const masked = v.match(MASKED_STUB)
      if (masked && key === 'accountNumber') {
        fields.lastFour = masked[1]
      } else {
        secrets[key] = v
      }
      continue
    }
    fields[key] = v
  }

  const asMs = (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : null

  return {
    title: deriveTitle(category, fields),
    fields,
    notes,
    secrets,
    createdAt: asMs(entry.createdAt),
    updatedAt: asMs(entry.updatedAt)
  }
}
