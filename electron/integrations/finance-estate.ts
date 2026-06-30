/**
 * Estate & insurance readiness (Phase 11.7).
 *
 * The last Phase 11 surface: a readiness dashboard over data Compass already
 * holds. It does NOT read the vault (no decryption, no secrets) — the actual
 * documents live in the encrypted Vault → Legal category, and this surface just
 * directs the user there. It assembles:
 *   - an estate-document CHECKLIST (will, healthcare directive, POA, trust,
 *     beneficiary designations, a cross-border CR/US plan, digital estate) the
 *     user marks present/absent — stored in `app_settings`.
 *   - INSURANCE adequacy from the `assets` domain (type 'insurance'): coverage,
 *     renewals (expiring-soon flag), and gaps vs. a recommended set.
 *   - PROPERTY holdings (type 'property') as a title/beneficiary reminder.
 *
 * `buildEstateReadiness` is pure; a thin DB layer reads the checklist + assets.
 */

export const ESTATE_ITEMS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'will', label: 'Will / last testament', hint: 'Store the document in Vault → Legal.' },
  { key: 'healthcare-directive', label: 'Healthcare directive / living will' },
  { key: 'power-of-attorney', label: 'Power of attorney (financial)' },
  { key: 'trust', label: 'Living trust' },
  { key: 'beneficiaries', label: 'Beneficiary designations (accounts + insurance)' },
  {
    key: 'cross-border',
    label: 'CR-situs will / property-title plan (cross-border)',
    hint: 'CR forced-heirship and US estate rules differ — verify with counsel.'
  },
  { key: 'digital-estate', label: 'Digital estate / password-access plan' }
]

export const RECOMMENDED_INSURANCE: Array<{ key: string; label: string; match: string[] }> = [
  { key: 'health', label: 'Health', match: ['health', 'medical', 'caja'] },
  { key: 'life', label: 'Life', match: ['life'] },
  {
    key: 'property',
    label: 'Home / property',
    match: ['home', 'homeowner', 'property', 'dwelling', 'hazard', 'renters']
  },
  { key: 'auto', label: 'Auto / vehicle', match: ['auto', 'car', 'vehicle', 'motor'] },
  { key: 'liability', label: 'Umbrella / liability', match: ['umbrella', 'liability'] }
]

const EXPIRING_SOON_DAYS = 60
export const ESTATE_CHECKLIST_KEY = 'estateChecklist'

export type EstateChecklistState = Record<string, { present?: boolean; notes?: string }>

export type AssetRow = {
  type: string
  name: string
  value: number | null
  provider: string | null
  reference: string | null
  renewal_date: string | null
  status: string
  notes: string | null
}

export type EstateItem = {
  key: string
  label: string
  hint?: string
  present: boolean
  notes: string
}
export type InsurancePolicy = {
  name: string
  provider: string | null
  coverage: number | null
  renewalDate: string | null
  expiringSoon: boolean
}
export type PropertyItem = {
  name: string
  value: number | null
  provider: string | null
  reference: string | null
}
export type EstateReadiness = {
  estate: EstateItem[]
  insurance: { policies: InsurancePolicy[]; gaps: Array<{ key: string; label: string }> }
  properties: PropertyItem[]
  score: {
    estateDone: number
    estateTotal: number
    insuranceCovered: number
    insuranceTotal: number
  }
}

/** Whole days from `today` until `dateIso` (negative if past). null if malformed. */
function daysUntil(dateIso: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
  const to = Date.UTC(
    Number(dateIso.slice(0, 4)),
    Number(dateIso.slice(5, 7)) - 1,
    Number(dateIso.slice(8, 10))
  )
  const from = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10))
  )
  return Math.round((to - from) / (1000 * 60 * 60 * 24))
}

export function buildEstateReadiness(input: {
  checklist: EstateChecklistState
  assets: AssetRow[]
  today: string
}): EstateReadiness {
  const estate: EstateItem[] = ESTATE_ITEMS.map((i) => ({
    ...i,
    present: input.checklist[i.key]?.present ?? false,
    notes: input.checklist[i.key]?.notes ?? ''
  }))

  // Only ACTIVE assets count toward coverage (expired/cancelled don't).
  const active = input.assets.filter((a) => a.status === 'active')
  const insuranceAssets = active.filter((a) => a.type === 'insurance')

  const policies: InsurancePolicy[] = insuranceAssets.map((a) => {
    const d = a.renewal_date ? daysUntil(a.renewal_date, input.today) : null
    return {
      name: a.name,
      provider: a.provider,
      coverage: a.value,
      renewalDate: a.renewal_date,
      expiringSoon: d != null && d >= 0 && d <= EXPIRING_SOON_DAYS
    }
  })

  const haystack = (a: AssetRow): string => `${a.name} ${a.notes ?? ''}`.toLowerCase()
  const gaps = RECOMMENDED_INSURANCE.filter(
    (r) => !insuranceAssets.some((a) => r.match.some((m) => haystack(a).includes(m)))
  ).map((r) => ({ key: r.key, label: r.label }))

  const properties: PropertyItem[] = active
    .filter((a) => a.type === 'property')
    .map((a) => ({ name: a.name, value: a.value, provider: a.provider, reference: a.reference }))

  return {
    estate,
    insurance: { policies, gaps },
    properties,
    score: {
      estateDone: estate.filter((e) => e.present).length,
      estateTotal: estate.length,
      insuranceCovered: RECOMMENDED_INSURANCE.length - gaps.length,
      insuranceTotal: RECOMMENDED_INSURANCE.length
    }
  }
}

// ─── DB layer ────────────────────────────────────────────────────────────────

export type SqliteForEstate = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
}

export function getEstateChecklist(sqlite: SqliteForEstate): EstateChecklistState {
  try {
    const row = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(ESTATE_CHECKLIST_KEY) as { value?: string } | undefined
    if (!row?.value) return {}
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? (parsed as EstateChecklistState) : {}
  } catch {
    return {}
  }
}

/** Set one checklist item (read-modify-write the JSON blob in app_settings). */
export function setEstateItem(
  sqlite: SqliteForEstate,
  key: string,
  patch: { present?: boolean; notes?: string },
  now: number = Date.now()
): void {
  const state = getEstateChecklist(sqlite)
  state[key] = { ...state[key], ...patch }
  sqlite
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(ESTATE_CHECKLIST_KEY, JSON.stringify(state), now)
}

export function buildEstateReadinessFromDb(
  sqlite: SqliteForEstate,
  today: string
): EstateReadiness {
  const checklist = getEstateChecklist(sqlite)
  let assets: AssetRow[] = []
  try {
    assets = sqlite
      .prepare(
        'SELECT type, name, value, provider, reference, renewal_date, status, notes FROM assets'
      )
      .all() as AssetRow[]
  } catch {
    // `assets` may not exist on a very old DB — degrade to an empty list.
  }
  return buildEstateReadiness({ checklist, assets, today })
}
