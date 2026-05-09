import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
/**
 * Smoke test: parse the user's real ~/Documents/Money files without DB writes.
 * Run: tsx scripts/smoke-test-money.ts
 */
import { join } from 'node:path'
import { parseFinanceFile } from '../electron/integrations/finance'

async function main() {
  const folder = join(homedir(), 'Documents', 'Money')
  const files = readdirSync(folder).filter((f) => /\.(csv|xlsx|pdf)$/i.test(f))

  console.log(`Scanning ${folder} — ${files.length} files\n`)

  for (const f of files) {
    const fp = join(folder, f)
    console.log(`━━━ ${f} ━━━`)
    try {
      const parsed = await parseFinanceFile(fp)
      if (!parsed) {
        console.log('  (unsupported file type)\n')
        continue
      }
      console.log(`  Parser: ${parsed.bank}`)
      console.log(`  Transactions: ${parsed.txns.length}`)
      if (parsed.account) {
        console.log(
          `  Detected account: ${JSON.stringify(parsed.account, null, 2).split('\n').join('\n    ')}`
        )
      } else {
        console.log('  No account detected')
      }
      if (parsed.txns.length > 0) {
        console.log(
          `  First txn:  ${parsed.txns[0].date}  ${parsed.txns[0].amount.toFixed(2).padStart(10)}  ${parsed.txns[0].description}`
        )
        const last = parsed.txns[parsed.txns.length - 1]
        console.log(
          `  Last txn:   ${last.date}  ${last.amount.toFixed(2).padStart(10)}  ${last.description}`
        )
        const total = parsed.txns.reduce((s, t) => s + t.amount, 0)
        console.log(`  Sum (signed): ${total.toFixed(2)}`)
      }
      console.log()
    } catch (err) {
      console.log(`  ERROR: ${(err as Error).message}\n`)
    }
  }
}
main().catch(console.error)
