/**
 * Year in Review (Timeline 2.0, PR 7) — one year of the archive distilled
 * into the numbers people actually retell: what you watched/read/bought most,
 * who and what entered your life (entity firsts), where you went
 * (travel_segments), what moved financially, which habits held. Pure raw-SQL
 * readers (records-aggregates.ts pattern), each section defensive against
 * absent tables so the review renders on any install. Firehose sources are
 * excluded throughout — telemetry is not a year.
 */

import type Database from 'better-sqlite3'
import { FIREHOSE_SOURCE_LIST } from './source-tiers'

export type YearReview = {
  year: number
  totalRecords: number
  /** Per-month record counts (index 0 = January) for the activity chart. */
  monthCounts: number[]
  topSources: Array<{ source: string; count: number }>
  /** Most-repeated titles that year (the shows/tracks/reorders you kept returning to). */
  topTitles: Array<{ source: string; type: string; title: string; count: number }>
  /** People / merchants whose FIRST appearance in the whole archive was this year. */
  firsts: Array<{ kind: string; name: string }>
  newPeople: number
  countries: string[]
  spend: {
    total: number
    biggest: { description: string; amount: number } | null
  } | null
  netWorth: { start: number | null; end: number | null } | null
  habits: Array<{ name: string; completions: number }>
}

export function buildYearReview(sqlite: Database.Database, year: number): YearReview {
  const from = Date.UTC(year, 0, 1)
  const to = Date.UTC(year + 1, 0, 1) - 1
  const params: Record<string, unknown> = { from, to }
  let firehose = ''
  if (FIREHOSE_SOURCE_LIST.length > 0) {
    firehose = ` AND source NOT IN (${FIREHOSE_SOURCE_LIST.map((_, i) => `@fh${i}`).join(', ')})`
    FIREHOSE_SOURCE_LIST.forEach((s, i) => {
      params[`fh${i}`] = s
    })
  }
  const where = `occurred_at >= @from AND occurred_at <= @to${firehose}`

  const review: YearReview = {
    year,
    totalRecords: 0,
    monthCounts: new Array(12).fill(0),
    topSources: [],
    topTitles: [],
    firsts: [],
    newPeople: 0,
    countries: [],
    spend: null,
    netWorth: null,
    habits: []
  }

  try {
    review.totalRecords =
      (
        sqlite.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where}`).get(params) as {
          n: number
        }
      ).n ?? 0
    const months = sqlite
      .prepare(
        `SELECT CAST(strftime('%m', occurred_at / 1000, 'unixepoch') AS INTEGER) AS m, COUNT(*) AS n
           FROM records WHERE ${where} GROUP BY 1`
      )
      .all(params) as Array<{ m: number; n: number }>
    for (const row of months) {
      if (row.m >= 1 && row.m <= 12) review.monthCounts[row.m - 1] = row.n
    }
    review.topSources = sqlite
      .prepare(
        `SELECT source, COUNT(*) AS count FROM records WHERE ${where} GROUP BY source ORDER BY count DESC LIMIT 6`
      )
      .all(params) as Array<{ source: string; count: number }>
    // Repeated titles only (count > 1) — a one-off isn't a "top" anything.
    review.topTitles = sqlite
      .prepare(
        `SELECT source, type, title, COUNT(*) AS count FROM records WHERE ${where}
          GROUP BY source, type, title HAVING COUNT(*) > 1 ORDER BY count DESC LIMIT 8`
      )
      .all(params) as YearReview['topTitles']
  } catch {
    /* records table absent — an empty review still renders */
  }

  try {
    const firsts = sqlite
      .prepare(
        `SELECT kind, name FROM derived_entities
          WHERE first_seen IS NOT NULL AND first_seen >= @from AND first_seen <= @to
            AND count > 2 AND kind IN ('person', 'merchant')
          ORDER BY count DESC LIMIT 12`
      )
      .all({ from, to }) as Array<{ kind: string; name: string }>
    review.firsts = firsts
    review.newPeople = firsts.filter((f) => f.kind === 'person').length
  } catch {
    /* derived_entities absent */
  }

  try {
    const rows = sqlite
      .prepare(
        // Overlap test on ISO date strings (inclusive segments).
        `SELECT DISTINCT country FROM travel_segments
          WHERE start_date <= @yEnd AND end_date >= @yStart ORDER BY country`
      )
      .all({ yStart: `${year}-01-01`, yEnd: `${year}-12-31` }) as Array<{ country: string }>
    review.countries = rows.map((r) => r.country)
  } catch {
    /* travel_segments absent */
  }

  try {
    const spend = sqlite
      .prepare(
        `SELECT SUM(ABS(amount)) AS total FROM finance_transactions
          WHERE amount < 0 AND date >= @yStart AND date <= @yEnd`
      )
      .get({ yStart: `${year}-01-01`, yEnd: `${year}-12-31` }) as { total: number | null }
    const biggest = sqlite
      .prepare(
        `SELECT description, ABS(amount) AS amount FROM finance_transactions
          WHERE amount < 0 AND date >= @yStart AND date <= @yEnd
          ORDER BY ABS(amount) DESC LIMIT 1`
      )
      .get({ yStart: `${year}-01-01`, yEnd: `${year}-12-31` }) as
      | { description: string; amount: number }
      | undefined
    if (spend.total != null) {
      review.spend = { total: spend.total, biggest: biggest ?? null }
    }
  } catch {
    /* finance tables absent */
  }

  try {
    // Net worth at each year boundary: every account's LAST snapshot at or
    // before the boundary, summed (debts carry negative sign via is_debt).
    const atBoundary = sqlite.prepare(
      `SELECT SUM(CASE WHEN a.is_debt = 1 THEN -s.balance ELSE s.balance END) AS net
         FROM finance_accounts a
         JOIN finance_balance_snapshots s ON s.account_id = a.id
        WHERE s.captured_at = (
          SELECT MAX(s2.captured_at) FROM finance_balance_snapshots s2
           WHERE s2.account_id = a.id AND s2.captured_at <= @at
        )`
    )
    const start = (atBoundary.get({ at: from }) as { net: number | null }).net
    const end = (atBoundary.get({ at: to }) as { net: number | null }).net
    if (start != null || end != null) review.netWorth = { start, end }
  } catch {
    /* snapshots absent */
  }

  try {
    review.habits = sqlite
      .prepare(
        `SELECT h.name, COUNT(*) AS completions
           FROM habit_entries e JOIN habits h ON h.id = e.habit_id
          WHERE e.completed = 1 AND e.date >= @yStart AND e.date <= @yEnd
          GROUP BY h.id ORDER BY completions DESC LIMIT 3`
      )
      .all({ yStart: `${year}-01-01`, yEnd: `${year}-12-31` }) as YearReview['habits']
  } catch {
    /* habits absent */
  }

  return review
}

/**
 * Template narrative — the no-LLM fallback that is also the default. Factual,
 * warm-ish, and strictly derived from the review (no invention).
 */
export function yearReviewNarrative(r: YearReview): string {
  if (r.totalRecords === 0)
    return `No dated records for ${r.year} yet — import more history to light this year up.`
  const parts: string[] = []
  const busiest = r.monthCounts.indexOf(Math.max(...r.monthCounts))
  const monthName = new Date(Date.UTC(2000, busiest, 1)).toLocaleDateString('en-US', {
    month: 'long',
    timeZone: 'UTC'
  })
  parts.push(
    `${r.year} left ${r.totalRecords.toLocaleString()} traces across ${r.topSources.length} sources, peaking in ${monthName}.`
  )
  if (r.topTitles[0]) {
    parts.push(`You came back to “${r.topTitles[0].title}” ${r.topTitles[0].count} times.`)
  }
  if (r.countries.length > 1) {
    parts.push(`Your year touched ${r.countries.length} countries (${r.countries.join(', ')}).`)
  }
  if (r.newPeople > 0) {
    parts.push(
      `${r.newPeople} ${r.newPeople === 1 ? 'person' : 'people'} entered your orbit for the first time.`
    )
  }
  if (r.spend?.biggest) {
    parts.push(
      `The biggest single expense was ${r.spend.biggest.description} ($${Math.round(r.spend.biggest.amount).toLocaleString()}).`
    )
  }
  if (r.netWorth?.start != null && r.netWorth.end != null) {
    const delta = r.netWorth.end - r.netWorth.start
    parts.push(
      `Net worth ${delta >= 0 ? 'grew' : 'fell'} by $${Math.abs(Math.round(delta)).toLocaleString()} over the year.`
    )
  }
  return parts.join(' ')
}

/** Markdown export for the knowledge base ("Save to Knowledge"). */
export function yearReviewMarkdown(r: YearReview): string {
  const lines: string[] = [
    `# ${r.year} in Review`,
    '',
    yearReviewNarrative(r),
    '',
    `- **Records:** ${r.totalRecords.toLocaleString()}`,
    `- **Top sources:** ${r.topSources.map((s) => `${s.source} (${s.count})`).join(', ') || '—'}`
  ]
  if (r.topTitles.length > 0) {
    lines.push('', '## On repeat')
    for (const t of r.topTitles) lines.push(`- ${t.title} — ${t.count}× (${t.source})`)
  }
  if (r.firsts.length > 0) {
    lines.push('', '## Firsts')
    for (const f of r.firsts) lines.push(`- ${f.name} (${f.kind})`)
  }
  if (r.countries.length > 0) lines.push('', '## Countries', r.countries.join(', '))
  if (r.spend) {
    lines.push('', '## Money', `- Total spend: $${Math.round(r.spend.total).toLocaleString()}`)
    if (r.spend.biggest) {
      lines.push(
        `- Biggest expense: ${r.spend.biggest.description} ($${Math.round(r.spend.biggest.amount).toLocaleString()})`
      )
    }
  }
  if (r.habits.length > 0) {
    lines.push('', '## Habits')
    for (const h of r.habits) lines.push(`- ${h.name}: ${h.completions} completions`)
  }
  return `${lines.join('\n')}\n`
}
