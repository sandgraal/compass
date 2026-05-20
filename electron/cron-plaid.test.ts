/**
 * Tests for the daily Plaid sync handler + cron expression.
 *
 * Scope: the inner `runDailyPlaidSync` function (the schedule itself is
 * just a `cron.schedule(PLAID_DAILY_CRON, ...)` and not worth a timing
 * test). We pass in a mock `syncAll` and a mock `notify` and assert the
 * notification semantics:
 *
 *   - 0 items connected → silent
 *   - All items succeeded with 0 records → silent (matches the existing
 *     per-service rule in `maybeSendNotification`)
 *   - Records updated → success notification with the total
 *   - 1 item errored → error notification with that item's message
 *   - >1 items errored → error notification mentioning the count
 *   - ITEM_LOGIN_REQUIRED takes priority in the body when several errors
 *   - syncAll itself throws → error notification, no crash
 */

import { describe, expect, it, vi } from 'vitest'
import { PLAID_DAILY_CRON, runDailyPlaidSync } from './cron-plaid'

type PlaidResult = {
  itemId: string
  added: number
  modified: number
  removed: number
  errorCode?: string
  errorMessage?: string
}

const result = (over: Partial<PlaidResult>): PlaidResult => ({
  itemId: over.itemId ?? 'item-x',
  added: 0,
  modified: 0,
  removed: 0,
  ...over
})

describe('PLAID_DAILY_CRON', () => {
  it('is the contractual 06:00-local daily expression', () => {
    // Hard-coded per docs/finance/plaid-integration.md. If this changes,
    // the change should be deliberate (not a rename refactor accident).
    expect(PLAID_DAILY_CRON).toBe('0 6 * * *')
  })
})

describe('runDailyPlaidSync', () => {
  it('is silent when no items are connected', async () => {
    const notify = vi.fn()
    await runDailyPlaidSync(async () => [], notify)
    expect(notify).not.toHaveBeenCalled()
  })

  it('is silent when all items succeeded with zero records', async () => {
    const notify = vi.fn()
    await runDailyPlaidSync(async () => [result({ itemId: 'item-a' })], notify)
    // Contract: runDailyPlaidSync delegates the "do we actually show a
    // notification?" decision to `maybeSendNotification` rather than
    // gatekeeping locally. The helper's first line is `if (records === 0
    // && !error) return`, so the user sees nothing in this case — but
    // from the cron's perspective the call still happened, which is
    // what we assert here.
    expect(notify).toHaveBeenCalledWith('plaid', 0)
  })

  it('fires a success notification with the total record count', async () => {
    const notify = vi.fn()
    await runDailyPlaidSync(
      async () => [
        result({ itemId: 'item-a', added: 3, modified: 1 }),
        result({ itemId: 'item-b', added: 2 })
      ],
      notify
    )
    expect(notify).toHaveBeenCalledWith('plaid', 6)
  })

  it('fires an error notification when a single item fails', async () => {
    const notify = vi.fn()
    await runDailyPlaidSync(
      async () => [result({ itemId: 'item-a', errorMessage: 'Chase: socket hang up' })],
      notify
    )
    expect(notify).toHaveBeenCalledWith('plaid', 0, 'Chase: socket hang up')
  })

  it('summarizes when multiple items fail', async () => {
    const notify = vi.fn()
    await runDailyPlaidSync(
      async () => [
        result({ itemId: 'item-a', errorMessage: 'A bad' }),
        result({ itemId: 'item-b', errorMessage: 'B bad' })
      ],
      notify
    )
    expect(notify).toHaveBeenCalledOnce()
    const [, , msg] = notify.mock.calls[0]
    expect(msg).toMatch(/2 institutions failed/i)
  })

  it('promotes ITEM_LOGIN_REQUIRED to the front of the error body', async () => {
    const notify = vi.fn()
    await runDailyPlaidSync(
      async () => [
        result({ itemId: 'item-a', errorMessage: 'transient blip' }),
        result({
          itemId: 'item-b',
          errorCode: 'ITEM_LOGIN_REQUIRED',
          errorMessage: 'Re-auth needed for Chase'
        })
      ],
      notify
    )
    expect(notify).toHaveBeenCalledOnce()
    const [, , msg] = notify.mock.calls[0]
    expect(msg).toMatch(/Re-auth needed for Chase/)
  })

  it('falls back to an error notification when syncAll itself throws', async () => {
    const notify = vi.fn()
    await runDailyPlaidSync(async () => {
      throw new Error('DB locked')
    }, notify)
    expect(notify).toHaveBeenCalledWith('plaid', 0, 'DB locked')
  })

  it('passes both the success record count AND the error message to notify', async () => {
    // Partial success: 5 records came through, but one Item failed. The
    // current rendered notification body just says "Sync failed: <msg>"
    // (the helper's error branch ignores recordsUpdated entirely), so
    // the user sees the action item, not the count. We still pass both
    // values into `notify` though — keeps the test honest about the
    // contract between cron-plaid and the helper, and leaves room to
    // render a richer "Synced 5 records but 1 institution failed" body
    // in a future iteration without changing the call site.
    const notify = vi.fn()
    await runDailyPlaidSync(
      async () => [
        result({ itemId: 'item-ok', added: 5 }),
        result({ itemId: 'item-bad', errorMessage: 'auth expired' })
      ],
      notify
    )
    const [service, total, msg] = notify.mock.calls[0]
    expect(service).toBe('plaid')
    expect(total).toBe(5)
    expect(msg).toBe('auth expired')
  })
})
