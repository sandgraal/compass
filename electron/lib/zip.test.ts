/**
 * Tests for the safe ZIP reader (Phase 10.4 — Google Takeout). Reads a committed
 * fixture archive `__fixtures__/takeout-sample.zip` whose `Takeout/` folder holds:
 *   - All mail.mbox       (2 messages — ingestable)
 *   - watch-history.json  (1 watch    — ingestable)
 *   - photo.jpg           (binary     — must be skipped, not extracted)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { forEachZipEntry } from './zip'

const FIXTURE = join(process.cwd(), 'electron', 'lib', '__fixtures__', 'takeout-sample.zip')

describe('forEachZipEntry', () => {
  it('extracts ingestable entries to temp files and skips non-ingestable ones', async () => {
    const seen: Array<{ name: string; sample: string }> = []
    const { skipped } = await forEachZipEntry(FIXTURE, async (name, tmpPath) => {
      seen.push({ name, sample: readFileSync(tmpPath, 'utf-8').slice(0, 16) })
    })

    expect(seen.map((s) => s.name).sort()).toEqual(['All mail.mbox', 'watch-history.json'])
    expect(skipped).toContain('photo.jpg')
    // the entry content really was streamed to disk before onEntry ran
    expect(seen.find((s) => s.name === 'watch-history.json')?.sample).toContain('[')
    expect(seen.find((s) => s.name === 'All mail.mbox')?.sample).toContain('From ')
  })
})
