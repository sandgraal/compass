/**
 * Anniversary "moments" (Timeline 2.0, PR 6) — the synthetic memories the
 * records spine implies but no single row states: birthdays, "N years since
 * you first crossed paths with X" (derived-entity firsts), big-purchase
 * anniversaries, and today's subscription renewals. Pure raw-SQL readers
 * (records-aggregates.ts pattern); the on-this-day-v2 handler attaches the
 * result alongside the year groups.
 */

import type Database from 'better-sqlite3'

export type TimelineMoment = {
  kind: 'birthday' | 'first-met' | 'first-merchant' | 'purchase-anniversary' | 'renewal'
  title: string
  detail?: string
  /** Years since the anchor event (0 = this year, undefined = n/a). */
  yearsAgo?: number
}

function yearOf(iso: string): number {
  return Number(iso.slice(0, 4))
}

/**
 * Moments for one month-day. `today` gates the future-facing renewal moments
 * (a renewal is "today's business", not an anniversary — only shown when the
 * requested day IS today). Every reader is defensive: any of these tables may
 * be empty or absent on a fresh install (all are in ensureNewTables, but the
 * moments must never break the hero).
 */
export function momentsForDay(
  sqlite: Database.Database,
  opts: { month: number; day: number; currentYear: number; isToday: boolean }
): TimelineMoment[] {
  const mmdd = `${String(opts.month).padStart(2, '0')}-${String(opts.day).padStart(2, '0')}`
  const moments: TimelineMoment[] = []

  // Contact birthdays (contacts.birthday is ISO 'YYYY-MM-DD'; year may be a
  // placeholder in some exports, so the age is only shown for plausible years).
  try {
    const rows = sqlite
      .prepare(
        'SELECT display_name AS name, birthday FROM contacts WHERE birthday IS NOT NULL AND substr(birthday, 6, 5) = ?'
      )
      .all(mmdd) as Array<{ name: string; birthday: string }>
    for (const row of rows) {
      const birthYear = yearOf(row.birthday)
      const age = opts.currentYear - birthYear
      moments.push({
        kind: 'birthday',
        title: `${row.name}'s birthday`,
        detail: age > 0 && age < 110 ? `Turns ${age} today` : undefined
      })
    }
  } catch {
    /* contacts not present — no birthday moments */
  }

  // Derived-entity firsts: the first time a person / merchant appeared in the
  // archive. Promoted-or-not doesn't matter; what matters is firstSeen's
  // month-day matching. Threshold count > 2 keeps one-off name extractions out.
  try {
    const rows = sqlite
      .prepare(
        `SELECT kind, name, first_seen AS firstSeen FROM derived_entities
          WHERE first_seen IS NOT NULL AND count > 2 AND kind IN ('person', 'merchant')
            AND strftime('%m-%d', first_seen / 1000, 'unixepoch') = ?
          ORDER BY count DESC LIMIT 8`
      )
      .all(mmdd) as Array<{ kind: string; name: string; firstSeen: number }>
    for (const row of rows) {
      const yearsAgo = opts.currentYear - new Date(row.firstSeen).getUTCFullYear()
      if (yearsAgo <= 0) continue
      moments.push(
        row.kind === 'person'
          ? {
              kind: 'first-met',
              title: `${yearsAgo} year${yearsAgo === 1 ? '' : 's'} since you first crossed paths with ${row.name}`,
              yearsAgo
            }
          : {
              kind: 'first-merchant',
              title: `Your first ${row.name} was ${yearsAgo} year${yearsAgo === 1 ? '' : 's'} ago today`,
              yearsAgo
            }
      )
    }
  } catch {
    /* derived_entities not present */
  }

  // Big-purchase anniversaries (≥ $1000 expense on this month-day; the finance
  // `date` column is a local 'YYYY-MM-DD' string).
  try {
    const rows = sqlite
      .prepare(
        `SELECT date, description, ABS(amount) AS amount FROM finance_transactions
          WHERE substr(date, 6, 5) = ? AND amount <= -1000
          ORDER BY ABS(amount) DESC LIMIT 5`
      )
      .all(mmdd) as Array<{ date: string; description: string; amount: number }>
    for (const row of rows) {
      const yearsAgo = opts.currentYear - yearOf(row.date)
      if (yearsAgo <= 0) continue
      moments.push({
        kind: 'purchase-anniversary',
        title: `${yearsAgo} year${yearsAgo === 1 ? '' : 's'} since ${row.description}`,
        detail: `$${Math.round(row.amount).toLocaleString()}`,
        yearsAgo
      })
    }
  } catch {
    /* finance tables not present */
  }

  // Subscription renewals — today only (forward-looking, not an anniversary).
  if (opts.isToday) {
    try {
      const rows = sqlite
        .prepare(
          `SELECT name, cost, cadence FROM subscriptions
            WHERE status = 'active' AND next_renewal IS NOT NULL AND substr(next_renewal, 6, 5) = ?
            ORDER BY cost DESC LIMIT 5`
        )
        .all(mmdd) as Array<{ name: string; cost: number; cadence: string }>
      for (const row of rows) {
        moments.push({
          kind: 'renewal',
          title: `${row.name} renews today`,
          detail: row.cost > 0 ? `$${row.cost.toFixed(2)} / ${row.cadence}` : undefined
        })
      }
    } catch {
      /* subscriptions not present */
    }
  }

  return moments
}
