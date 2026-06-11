/**
 * Tests for the .mcpb manifest builder (Phase 8.3): schema validity against
 * the official @anthropic-ai/mcpb v0.3 JSON schema, plus the invariants the
 * bundle relies on (entry point, bundled-mode env flag, macOS targeting).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManifest } from '@anthropic-ai/mcpb/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMcpbManifest } from './mcpb-manifest'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compass-mcpb-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('buildMcpbManifest', () => {
  it('produces a manifest that passes official schema validation', () => {
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(buildMcpbManifest('1.2.3'), null, 2), 'utf8')
    expect(validateManifest(manifestPath)).toBe(true)
  })

  it('pins the invariants the bundle relies on', () => {
    const m = buildMcpbManifest('0.6.0')
    expect(m.version).toBe('0.6.0')
    expect(m.manifest_version).toBe('0.3')
    // entry point and launch args must agree, and stay .mjs (the bundled
    // server is ESM — esbuild output keeps import.meta usable)
    expect(m.server.entry_point).toBe('server/index.mjs')
    expect(m.server.mcp_config.args).toEqual(['${__dirname}/server/index.mjs'])
    // bundled mode drops the repo self-knowledge tools (bundle-mode.ts)
    expect(m.server.mcp_config.env.COMPASS_MCP_BUNDLED).toBe('1')
    // Compass app data lives at ~/Library/Application Support — macOS only
    expect(m.compatibility.platforms).toEqual(['darwin'])
  })
})
