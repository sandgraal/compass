import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePlaidEnv, readPlaidConfig, writePlaidConfig } from './config'

let TMP: string
let configPath: string

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'compass-plaid-config-'))
  configPath = join(TMP, 'plaid.env')
})

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('parsePlaidEnv', () => {
  it('parses simple KEY=value pairs', () => {
    const parsed = parsePlaidEnv('PLAID_CLIENT_ID=abc\nPLAID_ENV=sandbox\n')
    expect(parsed).toEqual({ PLAID_CLIENT_ID: 'abc', PLAID_ENV: 'sandbox' })
  })

  it('skips blank lines and comments', () => {
    const parsed = parsePlaidEnv(
      '# header comment\n\nPLAID_CLIENT_ID=abc\n  # indented\nPLAID_ENV=sandbox'
    )
    expect(parsed).toEqual({ PLAID_CLIENT_ID: 'abc', PLAID_ENV: 'sandbox' })
  })

  it('strips surrounding double or single quotes', () => {
    const parsed = parsePlaidEnv('PLAID_CLIENT_ID="abc"\nPLAID_ENV=\'sandbox\'')
    expect(parsed.PLAID_CLIENT_ID).toBe('abc')
    expect(parsed.PLAID_ENV).toBe('sandbox')
  })

  it('preserves embedded = signs in the value', () => {
    const parsed = parsePlaidEnv('PLAID_CLIENT_ID=abc=def=ghi')
    expect(parsed.PLAID_CLIENT_ID).toBe('abc=def=ghi')
  })

  it('handles CRLF line endings', () => {
    const parsed = parsePlaidEnv('PLAID_CLIENT_ID=abc\r\nPLAID_ENV=sandbox\r\n')
    expect(parsed).toEqual({ PLAID_CLIENT_ID: 'abc', PLAID_ENV: 'sandbox' })
  })

  it('ignores lines without an = sign or with no key', () => {
    const parsed = parsePlaidEnv('no equals\n=value-without-key\nPLAID_CLIENT_ID=abc')
    expect(parsed).toEqual({ PLAID_CLIENT_ID: 'abc' })
  })

  it('trims whitespace around keys and values', () => {
    const parsed = parsePlaidEnv('  PLAID_CLIENT_ID  =  abc  ')
    expect(parsed.PLAID_CLIENT_ID).toBe('abc')
  })
})

describe('readPlaidConfig', () => {
  it('returns null when the file does not exist', () => {
    expect(readPlaidConfig(join(TMP, 'nope.env'))).toBeNull()
  })

  it('returns config for a valid sandbox file', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=sandbox\n')
    expect(readPlaidConfig(configPath)).toEqual({ clientId: 'cid', env: 'sandbox' })
  })

  it('returns config for a valid production file', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=production\n')
    expect(readPlaidConfig(configPath)).toEqual({ clientId: 'cid', env: 'production' })
  })

  it('defaults env to sandbox when PLAID_ENV is omitted', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\n')
    expect(readPlaidConfig(configPath)).toEqual({ clientId: 'cid', env: 'sandbox' })
  })

  it('throws when PLAID_CLIENT_ID is missing', () => {
    writeFileSync(configPath, 'PLAID_ENV=sandbox\n')
    expect(() => readPlaidConfig(configPath)).toThrow(/PLAID_CLIENT_ID/)
  })

  it('throws when PLAID_CLIENT_ID is empty', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=\nPLAID_ENV=sandbox\n')
    expect(() => readPlaidConfig(configPath)).toThrow(/PLAID_CLIENT_ID/)
  })

  it('rejects the retired development env with a migration pointer', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=development\n')
    expect(() => readPlaidConfig(configPath)).toThrow(/development.*retired/i)
  })

  it('rejects unknown env values', () => {
    writeFileSync(configPath, 'PLAID_CLIENT_ID=cid\nPLAID_ENV=staging\n')
    expect(() => readPlaidConfig(configPath)).toThrow(/PLAID_ENV/)
  })
})

describe('writePlaidConfig', () => {
  it('writes a file that readPlaidConfig round-trips', () => {
    writePlaidConfig('cid-123', 'sandbox', configPath)
    expect(readPlaidConfig(configPath)).toEqual({ clientId: 'cid-123', env: 'sandbox' })
  })

  it('round-trips production', () => {
    writePlaidConfig('cid-prod', 'production', configPath)
    expect(readPlaidConfig(configPath)).toEqual({ clientId: 'cid-prod', env: 'production' })
  })

  it('creates the parent directory if it does not exist', () => {
    const nested = join(TMP, 'a', 'b', 'plaid.env')
    expect(existsSync(nested)).toBe(false)
    writePlaidConfig('cid', 'sandbox', nested)
    expect(readPlaidConfig(nested)).toEqual({ clientId: 'cid', env: 'sandbox' })
  })

  it('trims the client_id and overwrites an existing file in place', () => {
    writePlaidConfig('old', 'sandbox', configPath)
    writePlaidConfig('  new-cid  ', 'production', configPath)
    expect(readPlaidConfig(configPath)).toEqual({ clientId: 'new-cid', env: 'production' })
  })

  it('rejects an empty client_id and an invalid env', () => {
    expect(() => writePlaidConfig('   ', 'sandbox', configPath)).toThrow(/PLAID_CLIENT_ID/)
    // @ts-expect-error — exercising the runtime guard with a bad env
    expect(() => writePlaidConfig('cid', 'staging', configPath)).toThrow(/env/)
  })
})
