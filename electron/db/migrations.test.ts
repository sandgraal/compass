import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type MigrationJournal = {
  entries: Array<{
    tag: string
    when: number
  }>
}

describe('Drizzle migration journal', () => {
  it('keeps migration timestamps strictly increasing', () => {
    const journal = JSON.parse(
      readFileSync(join(__dirname, 'migrations', 'meta', '_journal.json'), 'utf8')
    ) as MigrationJournal

    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index].when).toBeGreaterThan(journal.entries[index - 1].when)
    }
  })

  it('tracks the institution column migration as the latest entry', () => {
    const journal = JSON.parse(
      readFileSync(join(__dirname, 'migrations', 'meta', '_journal.json'), 'utf8')
    ) as MigrationJournal
    const latestEntry = journal.entries.at(-1)
    const latestMigrationSql = readFileSync(
      join(__dirname, 'migrations', '0002_zippy_sauron.sql'),
      'utf8'
    )

    expect(latestEntry?.tag).toBe('0002_zippy_sauron')
    expect(latestMigrationSql).toContain(
      "ALTER TABLE `finance_accounts` ADD `institution` text DEFAULT '' NOT NULL;"
    )
  })
})
