/**
 * Tests for the assistant key vault. We mock electron `safeStorage`
 * the same way `crypto-vault.test.ts` does and point `VAULT_DIR` at a
 * tmp directory per test so the on-disk blob is real but disposable.
 *
 * Focus: round-trip integrity of the multi-provider blob, masking,
 * active-provider invariants, and the never-leak-raw-key guarantee
 * (everything the IPC bridge sees comes through `getAssistantStatus`).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let TMP_VAULT_DIR: string

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`SAFE:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8')
      if (!s.startsWith('SAFE:')) throw new Error('mock safeStorage: invalid blob')
      return s.slice('SAFE:'.length)
    }
  }
}))

vi.mock('../paths', () => ({
  get VAULT_DIR() {
    return TMP_VAULT_DIR
  }
}))

const vault = await import('./assistant-vault')

beforeEach(() => {
  TMP_VAULT_DIR = mkdtempSync(join(tmpdir(), 'compass-assistant-vault-'))
})

afterEach(() => {
  try {
    rmSync(TMP_VAULT_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('assistant key vault round-trip', () => {
  it('reports no configured providers on a fresh vault', () => {
    const s = vault.getAssistantStatus()
    expect(s.configuredProviders).toEqual([])
    expect(s.activeProvider).toBeNull()
    expect(s.masks).toEqual({})
  })

  it('saves + masks an Anthropic key and makes it active by default', () => {
    vault.setAssistantKey('anthropic', 'sk-ant-aaaaaaaaaaaaaaaaaaaabbbbbbbb1234')
    const s = vault.getAssistantStatus()
    expect(s.configuredProviders).toEqual(['anthropic'])
    expect(s.activeProvider).toBe('anthropic')
    expect(s.masks.anthropic).toMatch(/^sk-…\w{4}$/)
    // The actual key is never returned by getAssistantStatus.
    expect(JSON.stringify(s)).not.toContain('aaaaaaaa')
  })

  it('supports two providers without overwriting each other', () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    vault.setAssistantKey('openai', `sk-${'b'.repeat(32)}`)
    const s = vault.getAssistantStatus()
    expect(s.configuredProviders.sort()).toEqual(['anthropic', 'openai'])
    expect(s.activeProvider).toBe('anthropic') // first one set
    expect(s.masks.anthropic).toBeDefined()
    expect(s.masks.openai).toBeDefined()
  })

  it('switches the active provider', () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    vault.setAssistantKey('openai', `sk-${'b'.repeat(32)}`)
    vault.setActiveProvider('openai')
    const s = vault.getAssistantStatus()
    expect(s.activeProvider).toBe('openai')
  })

  it('refuses to activate an unset provider', () => {
    expect(() => vault.setActiveProvider('anthropic')).toThrow(/no key configured/i)
  })

  it('refuses to persist obviously-too-short keys', () => {
    expect(() => vault.setAssistantKey('anthropic', 'short')).toThrow(/too short/i)
  })

  it('clears a single provider and re-elects the active one', () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    vault.setAssistantKey('openai', `sk-${'b'.repeat(32)}`)
    vault.setActiveProvider('openai')
    vault.clearAssistantKey('openai')
    const s = vault.getAssistantStatus()
    expect(s.configuredProviders).toEqual(['anthropic'])
    expect(s.activeProvider).toBe('anthropic')
  })

  it('clearAll wipes everything but keeps the file on disk', () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    vault.clearAllAssistantKeys()
    const s = vault.getAssistantStatus()
    expect(s.configuredProviders).toEqual([])
    expect(s.activeProvider).toBeNull()
    expect(s.lastClearedAt).not.toBeNull()
  })

  it('persists + reads back per-provider model', () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    vault.setProviderModel('anthropic', 'claude-opus-4-2')
    const s = vault.getAssistantStatus()
    expect(s.models.anthropic).toBe('claude-opus-4-2')
  })

  it('readActiveKeyInternal returns the raw key only for in-process use', () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    const internal = vault.readActiveKeyInternal()
    expect(internal).not.toBeNull()
    expect(internal!.provider).toBe('anthropic')
    expect(internal!.key.startsWith('sk-ant-')).toBe(true)
  })

  it('readActiveKeyInternal returns null when no key is set', () => {
    expect(vault.readActiveKeyInternal()).toBeNull()
  })

  it('readKeyInternal returns a non-active provider when configured', () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    vault.setAssistantKey('openai', `sk-${'b'.repeat(32)}`)
    // anthropic was first, so it's active; we still want to read openai for Test.
    const openai = vault.readKeyInternal('openai')
    expect(openai).not.toBeNull()
    expect(openai!.provider).toBe('openai')
    expect(openai!.key.startsWith('sk-')).toBe(true)
  })

  it('readKeyInternal returns null for an unconfigured provider', () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    expect(vault.readKeyInternal('openai')).toBeNull()
  })

  it('round-trips through the on-disk blob (re-import works)', async () => {
    vault.setAssistantKey('anthropic', `sk-ant-${'a'.repeat(32)}`)
    vault.setProviderModel('anthropic', 'claude-haiku-4-5-20251001')
    // Second import to simulate a process restart.
    vi.resetModules()
    const fresh = await import('./assistant-vault')
    const s = fresh.getAssistantStatus()
    expect(s.configuredProviders).toEqual(['anthropic'])
    expect(s.models.anthropic).toBe('claude-haiku-4-5-20251001')
  })
})

describe('maskKey helper', () => {
  it('returns dots for very short input', () => {
    expect(vault._internal.maskKey('short')).toBe('••••')
  })
  it('keeps a sk-prefix + last 4 chars for typical keys', () => {
    expect(vault._internal.maskKey('sk-ant-aaaaaaaaaaaaaaaaaaaabbbbbbbb1234')).toBe('sk-…1234')
  })
})
