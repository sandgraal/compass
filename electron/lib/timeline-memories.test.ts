/**
 * Memory ranking + sensitivity guard (Timeline 2.0, PR 6). Pure: candidates
 * in, resurfacing-worthy records out — distinctive events above burst noise,
 * painful classes suppressed, user mutes respected.
 */

import { describe, expect, it } from 'vitest'
import {
  type MemoryCandidate,
  isSensitiveMemory,
  memoryScore,
  muteKey,
  rankMemories
} from './timeline-memories'

let nextId = 1
function rec(
  source: string,
  type: string,
  title: string,
  body: string | null = null
): MemoryCandidate {
  return { id: nextId++, source, type, occurredAt: Date.parse('2021-07-08T12:00:00Z'), title, body }
}

describe('memoryScore', () => {
  it('ranks a career event above a watch above a shuffle listen', () => {
    const job = memoryScore(rec('linkedin', 'job', 'Started at Initech'), 1)
    const watch = memoryScore(rec('netflix', 'watch', 'Severance S1E4'), 1)
    const listen = memoryScore(rec('amazon-music', 'listen', 'Track 17'), 40)
    expect(job).toBeGreaterThan(watch)
    expect(watch).toBeGreaterThan(listen)
  })

  it('boosts big spend found in the body', () => {
    const small = memoryScore(rec('paypal', 'payment', 'Coffee', '$4.50 sent'), 1)
    const big = memoryScore(rec('paypal', 'payment', 'House deposit', '$12,000.00 sent'), 1)
    expect(big).toBeGreaterThan(small)
    expect(big - small).toBeGreaterThanOrEqual(30)
  })

  it('penalizes burst peers and stays clamped to [0, 100]', () => {
    const lone = memoryScore(rec('spotify', 'listen', 'One Song'), 1)
    const burst = memoryScore(rec('spotify', 'listen', 'One Song'), 40)
    expect(lone).toBeGreaterThan(burst)
    expect(burst).toBeGreaterThanOrEqual(0)
    expect(memoryScore(rec('linkedin', 'job', 'A'.repeat(50), '$99,999'), 1)).toBeLessThanOrEqual(
      100
    )
  })
})

describe('isSensitiveMemory', () => {
  it('flags sensitive kinds and loss/grief language', () => {
    expect(
      isSensitiveMemory({ source: 'document', type: 'medical', title: 'Lab result', body: null })
    ).toBe(true)
    expect(
      isSensitiveMemory({
        source: 'gmail',
        type: 'email',
        title: 'Funeral arrangements for Saturday',
        body: null
      })
    ).toBe(true)
    expect(
      isSensitiveMemory({ source: 'gmail', type: 'email', title: 'Lunch?', body: 'divorce lawyer' })
    ).toBe(true)
  })

  it('flags EVERY record from the medical source, whatever the clinical category', () => {
    // The spine expansion projects medical_records with type = category
    // (medication/immunization/encounter/…); the source check must catch them all.
    for (const type of ['medication', 'immunization', 'allergy', 'encounter', 'procedure']) {
      expect(isSensitiveMemory({ source: 'medical', type, title: 'Aspirin', body: null })).toBe(
        true
      )
    }
  })

  it('leaves ordinary records alone', () => {
    expect(
      isSensitiveMemory({ source: 'netflix', type: 'watch', title: 'The Godfather', body: null })
    ).toBe(false)
    expect(
      isSensitiveMemory({
        source: 'amazon',
        type: 'order',
        title: 'Chemistry textbook',
        body: null
      })
    ).toBe(false)
  })
})

describe('rankMemories', () => {
  it('orders by score, drops sensitive records, and respects mutes', () => {
    const job = rec('linkedin', 'job', 'Started at Initech')
    const sensitive = rec('email', 'email', 'Funeral arrangements')
    const listens = Array.from({ length: 10 }, (_, i) =>
      rec('amazon-music', 'listen', `Track ${i}`)
    )
    const mutedWatch = rec('netflix', 'watch', 'Muted Show')

    const ranked = rankMemories([...listens, sensitive, job, mutedWatch], {
      cap: 5,
      mutes: { recordIds: new Set([mutedWatch.id]), sourceTypes: new Set() }
    })
    expect(ranked[0].id).toBe(job.id)
    expect(ranked.map((r) => r.id)).not.toContain(sensitive.id)
    expect(ranked.map((r) => r.id)).not.toContain(mutedWatch.id)
    expect(ranked).toHaveLength(5)
  })

  it('mutes whole source|type pairs', () => {
    const listen = rec('amazon-music', 'listen', 'Track')
    const watch = rec('netflix', 'watch', 'Show')
    const ranked = rankMemories([listen, watch], {
      cap: 10,
      mutes: { recordIds: new Set(), sourceTypes: new Set([muteKey('amazon-music', 'listen')]) }
    })
    expect(ranked.map((r) => r.id)).toEqual([watch.id])
  })
})
