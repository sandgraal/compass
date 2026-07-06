/**
 * Metriport integration (Phase 10.9) — the seventh relay-fronted aggregator, and the first
 * MEDICAL one. Metriport pulls a patient's clinical records from the health-information
 * networks (TEFCA / Carequality / Commonwell) as **FHIR R4** and returns a consolidated
 * bundle. We normalize it into the dedicated `medical_records` table — OFF the records/AI
 * spine (medical is the most sensitive domain → aggregates-only) — for a Medical records
 * surface + an aggregates-only summary.
 *
 * Managed-only (keyed by a static app `x-api-key` in the relay). `normalizeMetriportBundle`
 * is PURE (unit-tested, no network) and stores only the clinical SUMMARY (category, display
 * name, status, date) — never raw values, patient identifiers, MRN/SSN, or provider
 * contacts. CAVEAT: the consolidated query is asynchronous (Metriport pushes to a webhook);
 * the connect (patient onboarding + query trigger) + the webhook wiring need a DEPLOYED
 * relay + real credentials and are not test-exercised. Field paths follow FHIR R4 but are
 * unvalidated against a real bundle.
 */

import { eq } from 'drizzle-orm'
import { getDb, getRawSqlite } from '../db/client'
import { integrations, medicalRecords, syncEvents } from '../db/schema'
import { loadToken, saveToken } from '../ipc/auth'
import type { SqliteForFx } from './finance-fx'
import { relayFetch, resolveRelayConfig } from './relay-client'

// ── pure helpers ──────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[k]
  }
  return cur
}
/** Slice any FHIR dateTime/date to a local-day 'YYYY-MM-DD'. */
function day(v: unknown): string | null {
  const s = str(v)
  return s ? s.slice(0, 10) : null
}

/** FHIR CodeableConcept → best display text (text > coding.display > coding.code). */
function conceptText(cc: unknown): string | null {
  return (
    str(get(cc, 'text')) ??
    str(get(cc, 'coding', 0, 'display')) ??
    str(get(cc, 'coding', 0, 'code'))
  )
}
/** FHIR CodeableConcept → the primary code (ICD-10 / RxNorm / LOINC / CVX). */
function conceptCode(cc: unknown): string | null {
  return str(get(cc, 'coding', 0, 'code'))
}
/** A status that may be a plain string OR a CodeableConcept (clinicalStatus). */
function statusText(v: unknown): string | null {
  if (typeof v === 'string') return str(v)
  return str(get(v, 'coding', 0, 'code')) ?? str(get(v, 'text'))
}

export type MedicalRecordRow = {
  externalId: string
  category: string
  description: string
  code: string | null
  status: string | null
  recordedAt: string | null
}

// FHIR resourceType → the Medical-records category we surface. Types not listed are skipped.
const CATEGORY_BY_TYPE: Record<string, string> = {
  Condition: 'condition',
  MedicationStatement: 'medication',
  MedicationRequest: 'medication',
  Immunization: 'immunization',
  AllergyIntolerance: 'allergy',
  Observation: 'lab',
  Encounter: 'encounter',
  Procedure: 'procedure'
}

/** The CodeableConcept that carries the clinical name, per resource type. */
function conceptFor(type: string, r: Record<string, unknown>): unknown {
  if (type === 'MedicationStatement' || type === 'MedicationRequest') {
    return get(r, 'medicationCodeableConcept')
  }
  if (type === 'Immunization') return get(r, 'vaccineCode')
  if (type === 'Encounter') return get(r, 'type', 0) ?? get(r, 'class')
  return get(r, 'code') // Condition, Observation, AllergyIntolerance, Procedure
}

function statusFor(type: string, r: Record<string, unknown>): string | null {
  if (type === 'Condition' || type === 'AllergyIntolerance') return statusText(r.clinicalStatus)
  return str(r.status)
}

/** Best available clinical date across the varied FHIR date fields (most-specific first). */
function dateFor(r: Record<string, unknown>): string | null {
  const candidates = [
    r.onsetDateTime,
    get(r, 'onsetPeriod', 'start'),
    r.effectiveDateTime,
    get(r, 'effectivePeriod', 'start'),
    r.occurrenceDateTime,
    r.performedDateTime,
    get(r, 'performedPeriod', 'start'),
    get(r, 'period', 'start'),
    r.authoredOn,
    r.recordedDate,
    r.issued
  ]
  for (const c of candidates) {
    const d = day(c)
    if (d) return d
  }
  return null
}

function resourcesOf(json: unknown): Record<string, unknown>[] {
  // A FHIR Bundle: { resourceType:'Bundle', entry: [{ resource }] }; also tolerate a bare
  // array of resources or a { resources: [...] } wrapper.
  const entries = get(json, 'entry')
  if (Array.isArray(entries)) {
    return entries
      .map((e) => get(e, 'resource'))
      .filter((r) => r && typeof r === 'object') as Record<string, unknown>[]
  }
  const arr = Array.isArray(json) ? json : get(json, 'resources')
  return Array.isArray(arr)
    ? (arr.filter((r) => r && typeof r === 'object') as Record<string, unknown>[])
    : []
}

/** Metriport consolidated FHIR bundle → normalized medical-record rows (clinical summary only). */
export function normalizeMetriportBundle(json: unknown): MedicalRecordRow[] {
  const out: MedicalRecordRow[] = []
  for (const r of resourcesOf(json)) {
    const type = str(r.resourceType)
    const id = str(r.id)
    if (!type || !id) continue
    const category = CATEGORY_BY_TYPE[type]
    if (!category) continue // a resource type we don't surface (Patient, Practitioner, …)
    const concept = conceptFor(type, r)
    const description = conceptText(concept)
    if (!description) continue // no clinical text → nothing meaningful to show
    out.push({
      externalId: `metriport:${type}:${id}`,
      category,
      description,
      code: conceptCode(concept),
      status: statusFor(type, r),
      recordedAt: dateFor(r)
    })
  }
  return out
}

/** Upsert medical records by `external_id` — a re-sync refreshes in place, never duplicates. */
export function upsertMedicalRecords(
  db: ReturnType<typeof getDb>,
  rows: MedicalRecordRow[],
  now: Date = new Date()
): number {
  let n = 0
  for (const r of rows) {
    const set = {
      category: r.category,
      description: r.description,
      code: r.code,
      status: r.status,
      recordedAt: r.recordedAt,
      ingestedAt: now
    }
    db.insert(medicalRecords)
      .values({ externalId: r.externalId, ...set })
      .onConflictDoUpdate({ target: medicalRecords.externalId, set })
      .run()
    n++
  }
  return n
}

// ── connect + sync (impure; managed via the relay) ─────────────────────────────

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }
// Demographics (name/DOB/address) are PHI — they live ONLY in the encrypted token
// blob (`safeStorage`), never in plaintext `app_settings`. `patientId` is the
// Metriport-assigned handle we sync against.
type MetriportToken = { patientId?: string; demographics?: unknown }

function loadMetriportToken(): MetriportToken {
  return (loadToken('metriport') as MetriportToken | null) ?? {}
}

/**
 * Resolve the patient demographics needed to create/onboard the Metriport patient.
 * Reads them from the encrypted token store. If an older install seeded them into
 * the plaintext `app_settings['metriportPatient']` row, migrate that value into the
 * encrypted store and **purge the plaintext copy** so PHI never lingers on disk.
 */
export function loadMetriportDemographics(sqlite: SqliteForFx): unknown {
  const tok = loadMetriportToken()
  if (tok.demographics) return tok.demographics
  // Legacy plaintext seed → migrate into the encrypted blob, then delete it.
  try {
    const row = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('metriportPatient') as { value?: string } | undefined
    const legacy = row?.value ? JSON.parse(row.value) : null
    if (legacy) {
      saveToken('metriport', { ...tok, demographics: legacy })
      sqlite.prepare('DELETE FROM app_settings WHERE key = ?').run('metriportPatient')
      return legacy
    }
  } catch {
    // fall through to "not configured"
  }
  return null
}

/** Pull the connected patient's consolidated FHIR bundle → upsert into `medical_records`. */
export async function syncMetriport(): Promise<SyncResult> {
  const db = getDb()
  const tok = loadMetriportToken()
  if (!tok.patientId)
    return { service: 'metriport', success: false, error: 'Metriport not connected' }
  const cfg = resolveRelayConfig(getRawSqlite(), 'metriport', () => null)

  let recordsUpdated = 0
  try {
    const res = await relayFetch(
      cfg,
      'metriport',
      'GET',
      `/medical/v1/patient/${encodeURIComponent(tok.patientId)}/consolidated`
    )
    if (!res.ok) throw new Error(`Metriport consolidated → HTTP ${res.status}`)
    recordsUpdated = upsertMedicalRecords(db, normalizeMetriportBundle(await res.json()))

    db.insert(integrations)
      .values({
        service: 'metriport',
        status: 'connected',
        connectedAt: new Date(),
        lastSyncedAt: new Date(),
        errorMessage: null
      })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'connected', lastSyncedAt: new Date(), errorMessage: null }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'metriport'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    return { service: 'metriport', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'metriport', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'metriport'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    return { service: 'metriport', success: false, error: message }
  }
}

/**
 * Onboard the patient with Metriport and kick off a document query. There's no consumer
 * consent widget — the developer (the relay) represents the patient's authorization — so
 * this is a pair of API calls, not a browser flow: create the patient from demographics
 * (held in the encrypted token blob — PHI never touches plaintext `app_settings`) → store
 * the `patientId` → start a consolidated query.
 * The bundle arrives asynchronously (Metriport → webhook); a later `syncMetriport` reads
 * the cached consolidated data.
 *
 * CAVEAT: needs a DEPLOYED relay + real Metriport credentials + configured demographics;
 * this path is not test-exercised.
 */
export async function openMetriportConnect(
  sqlite: SqliteForFx
): Promise<{ success: boolean; error?: string }> {
  const demographics = loadMetriportDemographics(sqlite)
  if (!demographics) {
    return {
      success: false,
      error: 'Metriport needs your demographics (name, date of birth, address) configured first.'
    }
  }

  const cfg = resolveRelayConfig(sqlite, 'metriport', () => null)
  try {
    const res = await relayFetch(cfg, 'metriport', 'POST', '/medical/v1/patient', {
      body: JSON.stringify(demographics)
    })
    if (!res.ok) throw new Error(`Metriport create-patient → HTTP ${res.status}`)
    const patient = (await res.json()) as { id?: string }
    const patientId = str(patient.id)
    if (!patientId) throw new Error('Metriport did not return a patient id')
    saveToken('metriport', { ...loadMetriportToken(), patientId })

    // Best-effort: kick off the async network query. The bundle lands via webhook; the
    // next sync reads the cached consolidated data. A failure here doesn't undo the connect.
    await relayFetch(
      cfg,
      'metriport',
      'POST',
      `/medical/v1/patient/${encodeURIComponent(patientId)}/consolidated/query`,
      { body: '{}' }
    ).catch(() => undefined)

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
