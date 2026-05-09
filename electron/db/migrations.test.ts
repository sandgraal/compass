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

  it('tracks the institution column migration in the journal', () => {
    const journal = JSON.parse(
      readFileSync(join(__dirname, 'migrations', 'meta', '_journal.json'), 'utf8')
    ) as MigrationJournal
    const initialEntry = journal.entries.find((entry) => entry.tag === '0001_small_blob')
    const institutionColumnEntry = journal.entries.find(
      (entry) => entry.tag === '0002_zippy_sauron'
    )
    const institutionColumnMigrationSql = readFileSync(
      join(__dirname, 'migrations', '0002_zippy_sauron.sql'),
      'utf8'
    )

    expect(initialEntry).toBeDefined()
    expect(institutionColumnEntry).toBeDefined()
    expect(institutionColumnEntry!.when).toBeGreaterThan(initialEntry!.when)
    expect(institutionColumnMigrationSql).toContain(
      "ALTER TABLE `finance_accounts` ADD `institution` text DEFAULT '' NOT NULL;"
    )
  })
})
