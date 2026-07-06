import { describe, expect, it } from 'vitest'
import { INTEGRATION_REGISTRY } from './integration-registry'
import { INTEGRATION_SETUP, RELAY_AGGREGATOR_IDS, getIntegrationSetup } from './integration-setup'

const CONNECTED_IDS = Object.values(INTEGRATION_REGISTRY)
  .filter((m) => m.connected)
  .map((m) => m.id)

describe('integration-setup catalog', () => {
  it('has a setup entry for every connected registry integration', () => {
    for (const id of CONNECTED_IDS) {
      expect(getIntegrationSetup(id), `missing setup for ${id}`).toBeDefined()
    }
  })

  it('has no setup entry that lacks a registry integration', () => {
    for (const id of Object.keys(INTEGRATION_SETUP)) {
      expect(INTEGRATION_REGISTRY[id], `orphan setup for ${id}`).toBeDefined()
    }
  })

  it('does not define setup for roadmap (not-connected) integrations', () => {
    for (const meta of Object.values(INTEGRATION_REGISTRY)) {
      if (!meta.connected) {
        expect(INTEGRATION_SETUP[meta.id], `unexpected setup for stub ${meta.id}`).toBeUndefined()
      }
    }
  })

  it('marks exactly the 7 relay aggregators as requiresRelay', () => {
    const requiresRelay = Object.values(INTEGRATION_SETUP)
      .filter((s) => s.requiresRelay)
      .map((s) => s.id)
      .sort()
    expect(requiresRelay).toEqual([...RELAY_AGGREGATOR_IDS].sort())
  })

  it('only marks terra + snaptrade as byoSupported (the documented BYO paths)', () => {
    const byo = Object.values(INTEGRATION_SETUP)
      .filter((s) => s.byoSupported)
      .map((s) => s.id)
      .sort()
    expect(byo).toEqual(['snaptrade', 'terra'])
  })

  it('has well-formed entries', () => {
    for (const s of Object.values(INTEGRATION_SETUP)) {
      expect(s.id.length).toBeGreaterThan(0)
      expect(s.steps.length).toBeGreaterThan(0)
      expect(Array.isArray(s.prerequisites)).toBe(true)
      expect(Array.isArray(s.whatYoullNeed)).toBe(true)
      expect(Array.isArray(s.fields)).toBe(true)
      // Every step with a link uses https.
      for (const step of s.steps) {
        if (step.href) expect(step.href).toMatch(/^https:\/\//)
      }
      if (s.docUrl) expect(s.docUrl).toMatch(/^https:\/\//)
      if (s.signupUrl) expect(s.signupUrl).toMatch(/^https:\/\//)
    }
  })

  it('gives every generic form field a stable key + label', () => {
    for (const s of Object.values(INTEGRATION_SETUP)) {
      const keys = s.fields.map((f) => f.key)
      expect(new Set(keys).size, `dup field keys in ${s.id}`).toBe(keys.length)
      for (const f of s.fields) {
        expect(f.key.length).toBeGreaterThan(0)
        expect(f.label.length).toBeGreaterThan(0)
      }
    }
  })
})
