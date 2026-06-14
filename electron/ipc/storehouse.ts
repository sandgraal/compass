/**
 * Storehouse overview IPC (Phase 9.6 — "The Storehouse").
 *
 * The founding "see ALL my info in one place" view. A read-only aggregator over
 * the owned-data domains (contacts, subscriptions, assets) — counts, totals, and
 * the renewals coming up soon. Pure `buildStorehouseSummary(db, today)` so it's
 * unit-testable with an injected date (matches the Phase 7 aggregator pattern);
 * the handler just supplies `new Date()`.
 *
 * Read-only: it never writes, and it touches no finance/vault internals — it sums
 * what the user already owns in their Storehouse tables.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import type * as schema from '../db/schema'
import { assets, contacts, subscriptions } from '../db/schema'
import { annualizeCost } from './subscriptions'

const RENEWAL_HORIZON_DAYS = 60

export interface StorehouseSummary {
  contacts: { count: number }
  subscriptions: { activeCount: number; annualTotal: number }
  assets: {
    count: number
    totalValue: number
    byType: Array<{ type: string; count: number; value: number }>
  }
  upcomingRenewals: Array<{
    source: 'subscription' | 'asset'
    name: string
    date: string
    daysUntil: number
  }>
}

/**
 * Whole days from `today` to an ISO `YYYY-MM-DD`; null if unparseable. Both ends
 * are taken as LOCAL midnight (date columns are local-day in this codebase), so
 * the count is timezone-independent.
 */
function daysUntil(iso: string | null, today: Date): number | null {
  if (!iso) return null
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  return Math.round((target - base) / 86_400_000)
}

export function buildStorehouseSummary(
  db: BetterSQLite3Database<typeof schema>,
  today: Date
): StorehouseSummary {
  const contactRows = db.select({ id: contacts.id }).from(contacts).all()

  const subRows = db.select().from(subscriptions).all()
  const activeSubs = subRows.filter((s) => s.status === 'active')
  const annualTotal =
    Math.round(activeSubs.reduce((sum, s) => sum + annualizeCost(s.cost, s.cadence), 0) * 100) / 100

  const assetRows = db.select().from(assets).all()
  const activeAssets = assetRows.filter((a) => a.status === 'active')
  const totalValue = activeAssets.reduce((sum, a) => sum + (a.value ?? 0), 0)
  const byTypeMap = new Map<string, { count: number; value: number }>()
  for (const a of activeAssets) {
    const cur = byTypeMap.get(a.type) ?? { count: 0, value: 0 }
    cur.count += 1
    cur.value += a.value ?? 0
    byTypeMap.set(a.type, cur)
  }
  const byType = [...byTypeMap.entries()]
    .map(([type, v]) => ({ type, count: v.count, value: v.value }))
    .sort((x, y) => y.value - x.value)

  // Upcoming renewals from both subscriptions and assets, within the horizon.
  const renewals: StorehouseSummary['upcomingRenewals'] = []
  for (const s of activeSubs) {
    const d = daysUntil(s.nextRenewal, today)
    if (d != null && d >= 0 && d <= RENEWAL_HORIZON_DAYS) {
      renewals.push({
        source: 'subscription',
        name: s.name,
        date: s.nextRenewal as string,
        daysUntil: d
      })
    }
  }
  for (const a of activeAssets) {
    const d = daysUntil(a.renewalDate, today)
    if (d != null && d >= 0 && d <= RENEWAL_HORIZON_DAYS) {
      renewals.push({ source: 'asset', name: a.name, date: a.renewalDate as string, daysUntil: d })
    }
  }
  renewals.sort((x, y) => x.daysUntil - y.daysUntil)

  return {
    contacts: { count: contactRows.length },
    subscriptions: { activeCount: activeSubs.length, annualTotal },
    assets: { count: assetRows.length, totalValue, byType },
    upcomingRenewals: renewals
  }
}

export function registerStorehouseHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('storehouse:summary', () => buildStorehouseSummary(getDb(), new Date()))
}
