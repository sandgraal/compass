import { describe, expect, it } from 'vitest'
import { DATA_RIGHTS_DOMAINS, DATA_RIGHTS_SOURCES, type DataRightsSource } from './data-rights'
import {
  type DataRightsStatusInputs,
  getDataRightsStatus,
  summarizeDataRightsProgress
} from './data-rights-status'

describe('data-rights catalog', () => {
  it('has well-formed entries with required copy', () => {
    expect(DATA_RIGHTS_SOURCES.length).toBeGreaterThan(15)
    for (const s of DATA_RIGHTS_SOURCES) {
      expect(
        Boolean(s.id && s.name && s.what && s.how && s.format && s.intoCompass && s.payoff)
      ).toBe(true)
      expect(DATA_RIGHTS_DOMAINS).toContain(s.domain)
      expect(['live', 'export', 'rights']).toContain(s.method)
    }
  })

  it('uses https for every request link', () => {
    for (const s of DATA_RIGHTS_SOURCES) {
      if (s.url) expect(s.url).toMatch(/^https:\/\//)
    }
  })

  it('has unique ids', () => {
    const ids = DATA_RIGHTS_SOURCES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only uses domains from DATA_RIGHTS_DOMAINS', () => {
    const domains = new Set(DATA_RIGHTS_SOURCES.map((s) => s.domain))
    for (const d of domains) expect(DATA_RIGHTS_DOMAINS).toContain(d)
  })

  it('every live source has an integrationId, every non-live source has no integrationId', () => {
    for (const s of DATA_RIGHTS_SOURCES) {
      if (s.method === 'live') expect(s.integrationId).toBeTruthy()
      else expect(s.integrationId).toBeUndefined()
    }
  })
})

describe('getDataRightsStatus', () => {
  const exportSource: DataRightsSource = {
    id: 'test-export',
    name: 'Test export',
    domain: 'Financial',
    method: 'export',
    what: '',
    how: '',
    format: 'CSV',
    intoCompass: '',
    recordsSourceId: 'test-export-source',
    payoff: ''
  }
  const multiSourceExport: DataRightsSource = {
    ...exportSource,
    id: 'test-multi',
    recordsSourceId: ['a', 'b']
  }
  const liveSource: DataRightsSource = {
    id: 'test-live',
    name: 'Test live',
    domain: 'Financial',
    method: 'live',
    what: '',
    how: '',
    format: '',
    intoCompass: '',
    integrationId: 'test-integration',
    payoff: ''
  }

  function inputs(overrides: Partial<DataRightsStatusInputs> = {}): DataRightsStatusInputs {
    return {
      importedSources: new Set(),
      connectedIntegrations: new Set(),
      requestedIds: new Set(),
      ...overrides
    }
  }

  it('defaults to not-started', () => {
    expect(getDataRightsStatus(exportSource, inputs())).toBe('not-started')
  })

  it('is requested once marked, even with no records yet', () => {
    expect(
      getDataRightsStatus(exportSource, inputs({ requestedIds: new Set(['test-export']) }))
    ).toBe('requested')
  })

  it('is imported once its records source appears in facets', () => {
    expect(
      getDataRightsStatus(
        exportSource,
        inputs({ importedSources: new Set(['test-export-source']) })
      )
    ).toBe('imported')
  })

  it('imported wins over a stale requested mark', () => {
    expect(
      getDataRightsStatus(
        exportSource,
        inputs({
          importedSources: new Set(['test-export-source']),
          requestedIds: new Set(['test-export'])
        })
      )
    ).toBe('imported')
  })

  it('matches on any of multiple recordsSourceId values', () => {
    expect(
      getDataRightsStatus(multiSourceExport, inputs({ importedSources: new Set(['b']) }))
    ).toBe('imported')
  })

  it('live sources are imported only via connectedIntegrations, not records facets', () => {
    expect(
      getDataRightsStatus(liveSource, inputs({ importedSources: new Set(['test-integration']) }))
    ).toBe('not-started')
    expect(
      getDataRightsStatus(
        liveSource,
        inputs({ connectedIntegrations: new Set(['test-integration']) })
      )
    ).toBe('imported')
  })
})

describe('summarizeDataRightsProgress', () => {
  it('counts every domain, including ones with zero matching sources', () => {
    const summary = summarizeDataRightsProgress(DATA_RIGHTS_SOURCES, {
      importedSources: new Set(),
      connectedIntegrations: new Set(),
      requestedIds: new Set()
    })
    expect(summary.total).toBe(DATA_RIGHTS_SOURCES.length)
    expect(summary.imported).toBe(0)
    for (const domain of DATA_RIGHTS_DOMAINS) {
      expect(summary.byDomain[domain]).toBeDefined()
    }
  })

  it('counts imported sources correctly', () => {
    const amazon = DATA_RIGHTS_SOURCES.find((s) => s.id === 'amazon')
    if (!amazon || !amazon.recordsSourceId) throw new Error('fixture missing')
    const sourceId = Array.isArray(amazon.recordsSourceId)
      ? amazon.recordsSourceId[0]
      : amazon.recordsSourceId
    const summary = summarizeDataRightsProgress(DATA_RIGHTS_SOURCES, {
      importedSources: new Set([sourceId]),
      connectedIntegrations: new Set(),
      requestedIds: new Set()
    })
    expect(summary.imported).toBe(1)
    expect(summary.byDomain.Financial.imported).toBe(1)
  })
})
