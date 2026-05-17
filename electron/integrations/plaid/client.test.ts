/**
 * Tests for the Plaid SDK client wrapper.
 *
 * The vault is mocked so we don't have to wire the safeStorage stub
 * here; the config loader is exercised against a real tmp file
 * (lighter than mocking) so we get coverage of the integration
 * between config + client.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlaidEnvironments } from 'plaid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let TMP: string
let configPath: string
let mockSecret: string | null = null

vi.mock('./vault', () => ({
  getPlaidSecret: vi.fn(() => mockSecret)
}))

vi.mock('./config', async (importOriginal) => {
  const original = await importOriginal<typeof import('./config')>()
  return {
    ...original,
    get DEFAULT_CONFIG_PATH() {
      return configPath
    },
    readPlaidConfig: (path?: string) => original.readPlaidConfig(path ?? configPath)
  }
})

const { getPlaidClient, isPlaidConfigured, PlaidNotConfiguredError } = await import('./client')

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'compass-plaid-client-'))
  configPath = join(TMP, 'plaid.env')
  mockSecret = null
})

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('getPlaidClient', () => {
  it('throws PlaidNotConfiguredError(missing-config) when no plaid.env exists', () => {
    try {
      getPlaidClient()
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PlaidNotConfiguredError)
      expect((err as InstanceType<typeof PlaidNotConfiguredError>).reason).toBe('missing-config')
    }
  })

  it('throws PlaidNotConfiguredError(missing-secret) when config exists but secret is unset', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=sandbox\n')
    mockSecret = null
    try {
      getPlaidClient()
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PlaidNotConfiguredError)
      expect((err as InstanceType<typeof PlaidNotConfiguredError>).reason).toBe('missing-secret')
    }
  })

  it('builds a sandbox client with PLAID-CLIENT-ID + PLAID-SECRET headers', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid-abc\nPLAID_ENV=sandbox\n')
    mockSecret = 'sandbox-secret'

    const client = getPlaidClient()

    expect(client.env).toBe('sandbox')
    expect(client.clientId).toBe('cid-abc')
    expect(client.api).toBeDefined()

    // The PlaidApi instance carries its axios config on `.configuration`;
    // assert headers are wired correctly so a misconfigured secret can't
    // silently fall through to an empty header.
    const headers = (
      client.api as unknown as {
        configuration: { baseOptions: { headers: Record<string, string> } }
      }
    ).configuration.baseOptions.headers
    expect(headers['PLAID-CLIENT-ID']).toBe('cid-abc')
    expect(headers['PLAID-SECRET']).toBe('sandbox-secret')
    expect(headers['Plaid-Version']).toBe('2020-09-14')
  })

  it('routes production env to the production base path', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=production\n')
    mockSecret = 'prod-secret'

    const client = getPlaidClient()
    expect(client.env).toBe('production')
    const basePath = (client.api as unknown as { configuration: { basePath: string } })
      .configuration.basePath
    expect(basePath).toBe(PlaidEnvironments.production)
  })

  it('throws env-mismatch when caller requests an env that does not match config', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=sandbox\n')
    mockSecret = 'sandbox-secret'

    try {
      getPlaidClient('production')
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PlaidNotConfiguredError)
      expect((err as InstanceType<typeof PlaidNotConfiguredError>).reason).toBe('env-mismatch')
    }
  })

  it('accepts an explicit env when it matches config', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=sandbox\n')
    mockSecret = 'sandbox-secret'

    const client = getPlaidClient('sandbox')
    expect(client.env).toBe('sandbox')
  })

  it('re-reads config + secret on every call (stateless)', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid-v1\nPLAID_ENV=sandbox\n')
    mockSecret = 'secret-v1'
    const first = getPlaidClient()
    expect(first.clientId).toBe('cid-v1')

    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid-v2\nPLAID_ENV=sandbox\n')
    mockSecret = 'secret-v2'
    const second = getPlaidClient()
    expect(second.clientId).toBe('cid-v2')
    const headers = (
      second.api as unknown as {
        configuration: { baseOptions: { headers: Record<string, string> } }
      }
    ).configuration.baseOptions.headers
    expect(headers['PLAID-SECRET']).toBe('secret-v2')
  })

  it('surfaces parser errors (e.g. retired development env) from the underlying config loader', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=development\n')
    mockSecret = 'whatever'
    expect(() => getPlaidClient()).toThrow(/development.*retired/i)
  })
})

describe('isPlaidConfigured', () => {
  it('returns { configured: false, env: null } when no config file exists', () => {
    expect(isPlaidConfigured()).toEqual({ configured: false, env: null })
  })

  it('returns { configured: false, env } when config exists but secret is missing', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=sandbox\n')
    mockSecret = null
    expect(isPlaidConfigured()).toEqual({ configured: false, env: 'sandbox' })
  })

  it('returns { configured: true, env } when both are present', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=production\n')
    mockSecret = 'prod-secret'
    expect(isPlaidConfigured()).toEqual({ configured: true, env: 'production' })
  })

  it('swallows config errors and reports unconfigured (no stack traces leaked to renderer)', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=development\n')
    expect(isPlaidConfigured()).toEqual({ configured: false, env: null })
  })
})
