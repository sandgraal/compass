/**
 * Embeddings module tests. We never call the real Ollama endpoint —
 * every test passes an `embed` stub that returns a deterministic
 * vector keyed on the input. The actual cross-process call shape is
 * locked in by `embedText` itself (covered by the hand-test in the
 * PR plan).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internal, buildEmbeddingsIndex, cosineSimilarity, semanticSearch } from './embeddings'

const { chunkMarkdown } = _internal

// Deterministic embed stub: maps a string to a small fixed-length
// vector where each dimension corresponds to a known keyword. Lets
// us hand-check that a query about "tax" prefers a chunk that
// actually mentions tax over one that doesn't.
const KEYWORDS = ['tax', 'budget', 'health', 'meeting', 'project', 'cron', 'travel', 'finance']

function makeEmbed(): (text: string) => Promise<number[]> {
  return async (text: string) => {
    const lc = text.toLowerCase()
    const vec = KEYWORDS.map((kw) => {
      // count occurrences, then normalise so longer chunks don't dominate
      const matches = lc.split(kw).length - 1
      return matches
    })
    const total = vec.reduce((s, v) => s + v, 0)
    if (total === 0) {
      // Random unit-ish vector for things we don't know about — keeps
      // cosine non-zero so the "no match" case stays distinct from a
      // pure-zero one.
      return KEYWORDS.map((_, i) => (i === lc.length % KEYWORDS.length ? 0.1 : 0))
    }
    return vec.map((v) => v / total)
  }
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0)
  })

  it('returns 0 for an empty vector', () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('returns 0 when one side is all-zero', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
  })

  it('returns 0 on length mismatch (no crash)', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
  })
})

describe('chunkMarkdown', () => {
  it('merges small adjacent paragraphs into a single chunk', () => {
    // Three short paragraphs together are far below the target size,
    // so the merger packs them into one chunk separated by blank lines.
    const md = 'First paragraph.\n\nSecond paragraph.\n\nThird.'
    expect(chunkMarkdown(md)).toEqual(['First paragraph.\n\nSecond paragraph.\n\nThird.'])
  })

  it('starts a new chunk when adding a paragraph would exceed the target', () => {
    // Two big-but-under-target paragraphs → two chunks.
    const big = 'x'.repeat(500)
    const chunks = chunkMarkdown(`${big}\n\n${big}`)
    expect(chunks.length).toBe(2)
  })

  it('merges small adjacent paragraphs up to the target size', () => {
    // 12 paragraphs of ~60 chars each → merge into a couple of chunks
    const para = 'x'.repeat(60)
    const md = Array(12).fill(para).join('\n\n')
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.length).toBeLessThanOrEqual(3)
    expect(chunks.every((c) => c.length <= 800)).toBe(true)
  })

  it('hard-splits a paragraph that exceeds the hard max', () => {
    const huge = 'a'.repeat(4000)
    const chunks = chunkMarkdown(huge)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(1500)
  })

  it('returns an empty array for empty content', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('  \n\n  \n')).toEqual([])
  })
})

describe('buildEmbeddingsIndex + semanticSearch', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'compass-embed-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeFile(rel: string, content: string): void {
    const full = join(tmp, rel)
    mkdirSync(join(tmp, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }

  it('builds an index over the knowledge dir', async () => {
    writeFile('profile/finances.md', '# Finances\n\nBudget for the year.\n\nTax rules apply.')
    writeFile('work/projects.md', '# Projects\n\nMeeting cadence.\n\nProject milestones.')
    const { index, result } = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'test-model',
      embed: makeEmbed()
    })
    expect(result.builtFiles).toBe(2)
    expect(result.skippedFiles).toBe(0)
    expect(index.chunks.length).toBeGreaterThanOrEqual(2)
    expect(index.model).toBe('test-model')
    expect(Object.keys(index.fileMtimes).length).toBe(2)
  })

  it('reuses chunks for unchanged files (incremental)', async () => {
    writeFile('a.md', 'Tax content here.')
    const first = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'test-model',
      embed: makeEmbed()
    })
    let embedCalls = 0
    const trackingEmbed = makeEmbed()
    const wrapped = async (text: string) => {
      embedCalls++
      return trackingEmbed(text)
    }
    const second = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'test-model',
      embed: wrapped,
      existing: first.index
    })
    expect(second.result.skippedFiles).toBe(1)
    expect(second.result.builtFiles).toBe(0)
    expect(embedCalls).toBe(0)
  })

  it('rebuilds when the model changed', async () => {
    writeFile('a.md', 'Tax content here.')
    const first = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'old-model',
      embed: makeEmbed()
    })
    const second = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'new-model',
      embed: makeEmbed(),
      existing: first.index
    })
    expect(second.result.builtFiles).toBe(1)
    expect(second.result.skippedFiles).toBe(0)
    expect(second.index.model).toBe('new-model')
  })

  it('ranks the topically-relevant chunk first', async () => {
    writeFile('finances.md', '# Finances\n\nTax filings and tax deductions matter.')
    writeFile('projects.md', '# Projects\n\nProject milestones and meeting notes.')
    const { index } = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'm',
      embed: makeEmbed()
    })
    const hits = await semanticSearch('tax', {
      knowledgeDir: tmp,
      model: 'm',
      embed: makeEmbed(),
      index,
      minScore: 0
    })
    expect(hits).not.toBeNull()
    expect(hits![0].path).toBe('finances.md')
  })

  it('returns null when there is no index', async () => {
    const hits = await semanticSearch('tax', {
      knowledgeDir: tmp,
      model: 'm',
      embed: makeEmbed(),
      index: null
    })
    expect(hits).toBeNull()
  })

  it('refuses to mix models', async () => {
    writeFile('a.md', 'Tax content.')
    const { index } = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'm-a',
      embed: makeEmbed()
    })
    const hits = await semanticSearch('tax', {
      knowledgeDir: tmp,
      model: 'm-b',
      embed: makeEmbed(),
      index
    })
    expect(hits).toBeNull()
  })

  it('deduplicates by path so one doc with many high-scoring chunks does not flood', async () => {
    writeFile('fat.md', ['# Fat doc', 'tax tax tax tax', 'budget budget', 'tax again'].join('\n\n'))
    writeFile('thin.md', 'tax')
    const { index } = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'm',
      embed: makeEmbed()
    })
    const hits = await semanticSearch('tax', {
      knowledgeDir: tmp,
      model: 'm',
      embed: makeEmbed(),
      index,
      minScore: 0
    })
    expect(hits).not.toBeNull()
    const fatCount = hits!.filter((h) => h.path === 'fat.md').length
    expect(fatCount).toBe(1)
  })

  it('drops empty / short queries', async () => {
    writeFile('a.md', 'tax')
    const { index } = await buildEmbeddingsIndex({
      knowledgeDir: tmp,
      model: 'm',
      embed: makeEmbed()
    })
    const empty = await semanticSearch('', { index, embed: makeEmbed() })
    expect(empty).toEqual([])
    const oneChar = await semanticSearch('a', { index, embed: makeEmbed() })
    expect(oneChar).toEqual([])
  })
})
