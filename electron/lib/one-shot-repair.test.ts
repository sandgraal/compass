/**
 * Shared gate mechanics used by every one-shot data-repair pass. Real
 * in-memory SQLite so the app_settings gate-write/gate-check round-trips
 * exactly like production.
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runOnceGated } from './one-shot-repair'

const NOW = Date.parse('2026-07-12T12:00:00Z')

let sqlite: Database.Database

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(
    'CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)'
  )
})
afterEach(() => sqlite.close())

describe('runOnceGated', () => {
  it('runs the repair and writes the gate on first call', () => {
    let calls = 0
    const res = runOnceGated(
      sqlite,
      'testKeyV1',
      () => {
        calls++
        return { fixed: 3 }
      },
      NOW
    )

    expect(res).toEqual({ ran: true, fixed: 3 })
    expect(calls).toBe(1)
    const gate = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get('testKeyV1') as
      | { value: string }
      | undefined
    expect(gate?.value).toBe(new Date(NOW).toISOString())
  })

  it('skips the repair entirely once the gate is set', () => {
    let calls = 0
    const repair = () => {
      calls++
      return { fixed: 1 }
    }
    runOnceGated(sqlite, 'testKeyV1', repair, NOW)
    const second = runOnceGated(sqlite, 'testKeyV1', repair, NOW)

    expect(second).toEqual({ ran: false })
    expect(calls).toBe(1) // the second call never invoked the repair
  })

  it('writes the gate even when the repair reports nothing to do', () => {
    const res = runOnceGated(sqlite, 'testKeyV1', () => ({ fixed: 0 }), NOW)
    expect(res).toEqual({ ran: true, fixed: 0 })
    expect(runOnceGated(sqlite, 'testKeyV1', () => ({ fixed: 99 }), NOW).ran).toBe(false)
  })

  it('keys are independent — different gates run independently', () => {
    runOnceGated(sqlite, 'keyA', () => ({ n: 1 }), NOW)
    const res = runOnceGated(sqlite, 'keyB', () => ({ n: 2 }), NOW)
    expect(res).toEqual({ ran: true, n: 2 })
  })
})
