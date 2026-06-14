/**
 * Tests for the daily SimpleFIN sync handler + cron expression.
 *
 * Scope: the inner `runDailySimplefinSync` — a mock `syncAll` + mock `notify`,
 * asserting the notification semantics (mirrors cron-plaid.test.ts).
 */

import { describe, expect, it, vi } from 'vitest'
import { SIMPLEFIN_DAILY_CRON, runDailySimplefinSync } from './cron-simplefin'

type SimplefinResult = {
  connectionId: string
  added: number
  duplicates: number
  errorMessage?: string
}

const result = (over: Partial<SimplefinResult>): SimplefinResult => ({
  connectionId: over.connectionId ?? 'conn-x',
  added: 0,
  duplicates: 0,
  ...over
})

describe('SIMPLEFIN_DAILY_CRON', () => {
  it('is the 06:00-local daily expression', () => {
    expect(SIMPLEFIN_DAILY_CRON).toBe('0 6 * * *')
  })
})

describe('runDailySimplefinSync', () => {
  it('is silent when no connections exist', async () => {
    const notify = vi.fn()
    await runDailySimplefinSync(async () => [], notify)
    expect(notify).not.toHaveBeenCalled()
  })

  it('delegates the zero-record case to maybeSendNotification', async () => {
    const notify = vi.fn()
    await runDailySimplefinSync(async () => [result({ connectionId: 'conn-a' })], notify)
    expect(notify).toHaveBeenCalledWith('simplefin', 0)
  })

  it('fires a success notification with the total record count', async () => {
    const notify = vi.fn()
    await runDailySimplefinSync(
      async () => [result({ added: 3 }), result({ connectionId: 'conn-b', added: 2 })],
      notify
    )
    expect(notify).toHaveBeenCalledWith('simplefin', 5)
  })

  it('fires an error notification when a single connection fails', async () => {
    const notify = vi.fn()
    await runDailySimplefinSync(async () => [result({ errorMessage: 'Amex: HTTP 403' })], notify)
    expect(notify).toHaveBeenCalledWith('simplefin', 0, 'Amex: HTTP 403')
  })

  it('summarizes when multiple connections fail', async () => {
    const notify = vi.fn()
    await runDailySimplefinSync(
      async () => [
        result({ connectionId: 'a', errorMessage: 'A bad' }),
        result({ connectionId: 'b', errorMessage: 'B bad' })
      ],
      notify
    )
    expect(notify).toHaveBeenCalledOnce()
    const [, , msg] = notify.mock.calls[0]
    expect(msg).toMatch(/2 connections failed/i)
  })

  it('falls back to an error notification when syncAll itself throws', async () => {
    const notify = vi.fn()
    await runDailySimplefinSync(async () => {
      throw new Error('DB locked')
    }, notify)
    expect(notify).toHaveBeenCalledWith('simplefin', 0, 'DB locked')
  })
})
