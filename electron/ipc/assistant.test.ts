/**
 * Tests for the assistant IPC handler's pure prompt-assembly helpers.
 *
 * We don't test the live IPC surface here — that requires a full
 * Electron app context (ipcMain, the vault, semantic-search, the
 * LLM HTTP call). The end-to-end smoke test is in the PR plan.
 *
 * These tests lock in:
 *   - The system prompt's citation contract is stable.
 *   - `buildContextBlock` produces the exact format the SYSTEM_PROMPT
 *     references (numbered `[N]`, path + title header, snippet body).
 */

import { describe, expect, it } from 'vitest'
import { _internal } from './assistant'

const { buildContextBlock, gatherContext, SYSTEM_PROMPT } = _internal

describe('SYSTEM_PROMPT', () => {
  it('instructs the model to cite blocks as bracketed numbers', () => {
    // Locking this in protects the contract that buildContextBlock relies on.
    expect(SYSTEM_PROMPT).toMatch(/\[1\], \[2\]/)
  })
  it('forbids fabrication when context is missing', () => {
    expect(SYSTEM_PROMPT).toMatch(/Do not invent/i)
  })
  it('asks for citations at end of factual sentences', () => {
    expect(SYSTEM_PROMPT).toMatch(/Place the citation at the END/i)
  })
  it('requests Markdown output (the renderer escape-renders it safely)', () => {
    expect(SYSTEM_PROMPT).toMatch(/Markdown/)
  })
})

describe('buildContextBlock', () => {
  it('returns a no-context sentinel when no chunks are supplied', () => {
    expect(buildContextBlock([])).toMatch(/No numbered context blocks are available/i)
  })

  it('numbers chunks starting from 1', () => {
    const out = buildContextBlock([
      { path: 'a.md', title: 'A', snippet: 'first', score: 1 },
      { path: 'b.md', title: 'B', snippet: 'second', score: 0.8 }
    ])
    expect(out).toMatch(/\[1\]/)
    expect(out).toMatch(/\[2\]/)
    expect(out.indexOf('[1]')).toBeLessThan(out.indexOf('[2]'))
  })

  it('includes path + title in the header line', () => {
    const out = buildContextBlock([
      { path: 'profile/finances.md', title: 'Finances', snippet: 'tax notes', score: 1 }
    ])
    expect(out).toMatch(/profile\/finances\.md/)
    expect(out).toMatch(/Finances/)
    expect(out).toMatch(/tax notes/)
  })

  it('separates chunks with a horizontal rule', () => {
    const out = buildContextBlock([
      { path: 'a.md', title: 'A', snippet: 'one', score: 1 },
      { path: 'b.md', title: 'B', snippet: 'two', score: 1 }
    ])
    expect(out).toContain('---')
  })
})

describe('gatherContext', () => {
  it('throws an abort error immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(gatherContext('anything', controller.signal)).rejects.toMatchObject({
      name: 'LlmAbortError'
    })
  })
})
