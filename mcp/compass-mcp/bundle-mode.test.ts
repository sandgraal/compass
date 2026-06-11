/**
 * Tests for bundled-desktop-extension mode (Phase 8.3) — the tool filter
 * that drops the repo self-knowledge tools when the server runs inside the
 * one-click .mcpb bundle (no source checkout present).
 */
import { describe, expect, it } from 'vitest'
import { REPO_ONLY_TOOLS, filterToolsForBundle, isBundled } from './bundle-mode'

const TOOLS = [
  { name: 'compass_today_tasks' },
  { name: 'compass_recent_commits' },
  { name: 'compass_test_status' },
  { name: 'compass_finance_summary' },
  { name: 'compass_propose_task' }
]

describe('isBundled', () => {
  it('is true only when COMPASS_MCP_BUNDLED is exactly "1"', () => {
    expect(isBundled({ COMPASS_MCP_BUNDLED: '1' })).toBe(true)
    expect(isBundled({ COMPASS_MCP_BUNDLED: 'true' })).toBe(false)
    expect(isBundled({ COMPASS_MCP_BUNDLED: '' })).toBe(false)
    expect(isBundled({})).toBe(false)
  })
})

describe('filterToolsForBundle', () => {
  it('drops exactly the repo-only tools in bundled mode', () => {
    const filtered = filterToolsForBundle(TOOLS, true)
    const names = filtered.map((t) => t.name)
    expect(names).toEqual([
      'compass_today_tasks',
      'compass_finance_summary',
      'compass_propose_task'
    ])
    for (const dropped of REPO_ONLY_TOOLS) {
      expect(names).not.toContain(dropped)
    }
  })

  it('returns all tools (copied) when not bundled', () => {
    const filtered = filterToolsForBundle(TOOLS, false)
    expect(filtered).toEqual(TOOLS)
    expect(filtered).not.toBe(TOOLS)
  })
})
