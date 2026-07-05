import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type ByoCreds,
  type RelayClientConfig,
  buildAggregatorRequest,
  getOrCreateDeviceToken,
  resolveRelayConfig
} from './relay-client'

const managed = (over: Partial<RelayClientConfig> = {}): RelayClientConfig => ({
  mode: 'managed',
  relayUrl: 'https://relay.compass.app',
  deviceToken: 'device-tok',
  byo: null,
  ...over
})

describe('buildAggregatorRequest — managed (via relay)', () => {
  it('routes GET through the relay with the device bearer token, no body', () => {
    const b = buildAggregatorRequest(managed(), 'terra', 'GET', '/daily', '?user_id=u')
    expect(b.url).toBe('https://relay.compass.app/terra/daily?user_id=u')
    expect(b.headers.authorization).toBe('Bearer device-tok')
    expect(b.headers['dev-id']).toBeUndefined() // secret never leaves the relay
    expect(b.body).toBeUndefined()
  })

  it('forwards a POST body and trims a trailing slash on the relay URL', () => {
    const b = buildAggregatorRequest(
      managed({ relayUrl: 'https://relay.compass.app/' }),
      'terra',
      'POST',
      '/auth/generateWidgetSession',
      '',
      '{"reference_id":"u"}'
    )
    expect(b.url).toBe('https://relay.compass.app/terra/auth/generateWidgetSession')
    expect(b.body).toBe('{"reference_id":"u"}')
  })
})

describe('buildAggregatorRequest — BYO (direct upstream)', () => {
  it('calls the upstream directly with the user credentials, bypassing the relay', () => {
    const cfg = managed({ mode: 'byo', byo: { devId: 'mydev', apiKey: 'mykey' } })
    const b = buildAggregatorRequest(cfg, 'terra', 'GET', '/sleep', '?user_id=u')
    expect(b.url).toBe('https://api.tryterra.co/v2/sleep?user_id=u')
    expect(b.headers['dev-id']).toBe('mydev')
    expect(b.headers['x-api-key']).toBe('mykey')
    expect(b.headers.authorization).toBeUndefined() // no relay token in BYO mode
  })

  it('throws if BYO mode is selected without credentials', () => {
    expect(() =>
      buildAggregatorRequest(managed({ mode: 'byo' }), 'terra', 'GET', '/daily')
    ).toThrow()
  })
})

describe('resolveRelayConfig + device token', () => {
  let sqlite: Database.Database
  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(
      'CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)'
    )
  })

  it('mints a device token once and reuses it', () => {
    const a = getOrCreateDeviceToken(sqlite, 1)
    const b = getOrCreateDeviceToken(sqlite, 2)
    expect(a).toMatch(/[0-9a-f-]{36}/)
    expect(b).toBe(a) // persisted, not regenerated
  })

  it('picks managed mode with the default relay when no BYO creds', () => {
    const cfg = resolveRelayConfig(sqlite, 'terra', () => null, 1)
    expect(cfg.mode).toBe('managed')
    expect(cfg.relayUrl).toBe('https://relay.compass.app')
    expect(cfg.deviceToken).toBeTruthy()
  })

  it('picks BYO mode when the user has set their own credentials', () => {
    const creds: ByoCreds = { devId: 'd', apiKey: 'k' }
    const cfg = resolveRelayConfig(sqlite, 'terra', () => creds, 1)
    expect(cfg.mode).toBe('byo')
    expect(cfg.byo).toEqual(creds)
  })

  it('honors a custom relayUrl app setting', () => {
    sqlite
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('relayUrl', 'https://my-relay.example', 1)
    expect(resolveRelayConfig(sqlite, 'terra', () => null, 1).relayUrl).toBe(
      'https://my-relay.example'
    )
  })
})
