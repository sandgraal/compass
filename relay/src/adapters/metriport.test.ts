import { describe, expect, it } from 'vitest'
import { getAdapter } from './index.js'
import { METRIPORT_ADAPTER } from './metriport.js'

describe('Metriport adapter — allowlist (deny by default)', () => {
  it('allows a patient consolidated-data GET', () => {
    expect(METRIPORT_ADAPTER.allows('GET', '/medical/v1/patient/pat-1/consolidated')).toBe(true)
    expect(METRIPORT_ADAPTER.allows('GET', '/medical/v1/patient/AB_c-9/consolidated')).toBe(true)
  })

  it('allows the patient-create + start-query POSTs', () => {
    expect(METRIPORT_ADAPTER.allows('POST', '/medical/v1/patient')).toBe(true)
    expect(METRIPORT_ADAPTER.allows('POST', '/medical/v1/patient/pat-1/consolidated/query')).toBe(
      true
    )
  })

  it('refuses everything else', () => {
    expect(METRIPORT_ADAPTER.allows('GET', '/medical/v1/patient/pat-1')).toBe(false) // demographics
    expect(METRIPORT_ADAPTER.allows('GET', '/medical/v1/patient//consolidated')).toBe(false) // empty id
    expect(METRIPORT_ADAPTER.allows('POST', '/medical/v1/patient/pat-1/consolidated')).toBe(false) // wrong method
    expect(METRIPORT_ADAPTER.allows('DELETE', '/medical/v1/patient/pat-1/consolidated')).toBe(false)
    expect(METRIPORT_ADAPTER.allows('GET', '/medical/v1/document')).toBe(false)
    expect(METRIPORT_ADAPTER.allows('GET', '/admin')).toBe(false)
  })
})

describe('Metriport adapter — auth + cost', () => {
  it('injects the x-api-key from env', () => {
    expect(METRIPORT_ADAPTER.authHeaders({ METRIPORT_API_KEY: 'mk_1' })['x-api-key']).toBe('mk_1')
  })

  it('degrades to an empty key (never crashes) when env is missing', () => {
    expect(METRIPORT_ADAPTER.authHeaders({})['x-api-key']).toBe('')
  })

  it('costs 1 and flags only the patient-create connect', () => {
    expect(METRIPORT_ADAPTER.costOf('GET', '/medical/v1/patient/x/consolidated')).toBe(1)
    expect(METRIPORT_ADAPTER.isConnect('POST', '/medical/v1/patient')).toBe(true)
    expect(METRIPORT_ADAPTER.isConnect('POST', '/medical/v1/patient/x/consolidated/query')).toBe(
      false
    )
    expect(METRIPORT_ADAPTER.isConnect('GET', '/medical/v1/patient/x/consolidated')).toBe(false)
  })
})

describe('adapter registry', () => {
  it('resolves metriport', () => {
    expect(getAdapter('metriport')).toBe(METRIPORT_ADAPTER)
  })
})
