/**
 * Pure status derivation for the Get Your Data page. Takes already-fetched
 * facts (records facets, connected integrations, the "requested" blob) and
 * returns a status per source — no IPC, no DOM, unit-testable without
 * mocking Electron.
 */

import { DATA_RIGHTS_DOMAINS, type DataRightsDomain, type DataRightsSource } from './data-rights'

export type DataRightsStatus = 'not-started' | 'requested' | 'imported'

export interface DataRightsStatusInputs {
  /** Distinct `records.source` values currently in the DB (from records:facets). */
  importedSources: Set<string>
  /** Integration ids the user has actually connected (per-user state — NOT
   *  INTEGRATION_REGISTRY's static "is this implemented" flag). */
  connectedIntegrations: Set<string>
  /** Source ids explicitly marked "requested" (from the data-rights app_settings blob). */
  requestedIds: Set<string>
}

/** `imported` always wins over a stale `requested` mark. */
export function getDataRightsStatus(
  source: DataRightsSource,
  inputs: DataRightsStatusInputs
): DataRightsStatus {
  const isImported =
    source.method === 'live'
      ? Boolean(source.integrationId && inputs.connectedIntegrations.has(source.integrationId))
      : recordsSourceIds(source).some((id) => inputs.importedSources.has(id))
  if (isImported) return 'imported'
  if (inputs.requestedIds.has(source.id)) return 'requested'
  return 'not-started'
}

function recordsSourceIds(source: DataRightsSource): string[] {
  if (!source.recordsSourceId) return []
  return Array.isArray(source.recordsSourceId) ? source.recordsSourceId : [source.recordsSourceId]
}

export interface DataRightsProgress {
  total: number
  imported: number
  byDomain: Record<DataRightsDomain, { total: number; imported: number }>
}

export function summarizeDataRightsProgress(
  sources: DataRightsSource[],
  inputs: DataRightsStatusInputs
): DataRightsProgress {
  const byDomain = Object.fromEntries(
    DATA_RIGHTS_DOMAINS.map((d) => [d, { total: 0, imported: 0 }])
  ) as Record<DataRightsDomain, { total: number; imported: number }>

  let imported = 0
  for (const s of sources) {
    const bucket = byDomain[s.domain]
    bucket.total++
    if (getDataRightsStatus(s, inputs) === 'imported') {
      imported++
      bucket.imported++
    }
  }
  return { total: sources.length, imported, byDomain }
}
