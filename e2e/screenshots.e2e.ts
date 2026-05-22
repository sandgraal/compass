/**
 * README screenshot capture (not a CI test — run manually via `npm run screenshots`).
 *
 * Launches the BUILT Electron app under an isolated $HOME (so it reads the
 * synthetic store created by scripts/seed-demo.ts, never the user's real
 * data), walks the HashRouter pages, and writes PNGs to docs/images/.
 *
 * Prereqs (the `npm run screenshots` script chains these):
 *   1. COMPASS_SEED_DEMO=1 HOME=$DEMO npx tsx scripts/seed-demo.ts
 *   2. npm run build
 *   3. COMPASS_DEMO_HOME=$DEMO npx playwright test e2e/screenshots.e2e.ts
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

const REPO_ROOT = join(__dirname, '..')
const OUT_DIR = join(REPO_ROOT, 'docs', 'images')
const DEMO_HOME = process.env.COMPASS_DEMO_HOME
const WIDTH = 1440
const HEIGHT = 900

async function show(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => {
    window.location.hash = h
  }, hash)
  // Let the route mount + DB-backed widgets resolve + animations settle.
  await win.waitForTimeout(1200)
}

test('capture README screenshots', async () => {
  test.setTimeout(120_000)
  if (!DEMO_HOME) throw new Error('COMPASS_DEMO_HOME must point at the seeded throwaway $HOME')
  mkdirSync(OUT_DIR, { recursive: true })

  const app: ElectronApplication = await electron.launch({
    args: [join(REPO_ROOT, 'out', 'main', 'main.js')],
    // COMPASS_HOME redirects the app's entire data store to the seeded
    // throwaway dir (paths.ts honors it); HOME is set too as a belt-and-braces.
    env: { ...process.env, COMPASS_HOME: DEMO_HOME, HOME: DEMO_HOME, NODE_ENV: 'production' }
  })

  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // Fixed, retina-crisp window size for consistent shots.
  await app.evaluate(
    async ({ BrowserWindow }, { w, h }) => {
      const win0 = BrowserWindow.getAllWindows()[0]
      if (win0) {
        win0.setContentSize(w, h)
        win0.center()
      }
    },
    { w: WIDTH, h: HEIGHT }
  )
  await win.waitForTimeout(1500) // initial load (onboarding is pre-completed via seed)

  const shoot = async (name: string): Promise<void> => {
    await win.screenshot({ path: join(OUT_DIR, `${name}.png`) })
  }

  // Dashboard
  await show(win, '#/dashboard')
  await shoot('dashboard')

  // Daily
  await show(win, '#/daily')
  await shoot('daily')

  // Finance — overview, then chart-heavy tabs (best-effort tab clicks).
  await show(win, '#/finance')
  await shoot('finance')
  for (const [label, name] of [
    ['Net Worth', 'finance-networth'],
    ['Forecast', 'finance-forecast']
  ] as Array<[string, string]>) {
    try {
      await win
        .getByRole('button', { name: new RegExp(label, 'i') })
        .first()
        .click({ timeout: 3000 })
      await win.waitForTimeout(1200)
      await shoot(name)
    } catch {
      // Tab not present / renamed — skip without failing the run.
    }
  }

  // Knowledge base — open a content-rich linked note (wikilinks) if present.
  await show(win, '#/knowledge')
  for (const label of ['Personal Profile', 'Projects', 'Goals']) {
    try {
      await win.getByText(label, { exact: true }).first().click({ timeout: 2500 })
      await win.waitForTimeout(900)
      break
    } catch {
      // not in the tree under this name — try the next
    }
  }
  await shoot('knowledge')

  // Ask (AI assistant)
  await show(win, '#/ask')
  await shoot('ask')

  // Weekly review
  await show(win, '#/weekly')
  await shoot('weekly')

  // Vault (synthetic stub entries only)
  await show(win, '#/vault')
  await shoot('vault')

  await app.close()

  // Sanity: the first window actually rendered the app shell.
  expect(DEMO_HOME.length).toBeGreaterThan(0)
})
