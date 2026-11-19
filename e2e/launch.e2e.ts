/**
 * Launch smoke test: boots the BUILT app on a fresh, isolated data store and
 * proves the main process, renderer, preload bridge and sealed vault all work
 * on the bundled Electron. Runs in CI's macOS E2E job, so the vault master key
 * goes through the real Keychain-backed `safeStorage`.
 *
 * COMPASS_HOME redirects the entire store (DB, vault, knowledge base) to a temp
 * dir — real user data is never touched. HOME is deliberately NOT overridden:
 * on macOS `safeStorage` needs the login keychain under the real home.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

const REPO_ROOT = join(__dirname, '..')

type VaultEntry = { id: string; title?: string; password?: string }
type VaultBridge = {
  getCategories: () => Promise<Array<{ id: string }>>
  getEntries: (category: string) => Promise<VaultEntry[]>
  addEntry: (category: string, entry: Record<string, unknown>) => Promise<VaultEntry>
}

async function launch(home: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    // Root on Linux (containers) can't use the Chromium sandbox.
    args: [
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      join(REPO_ROOT, 'out', 'main', 'main.js')
    ],
    env: { ...process.env, COMPASS_HOME: home, NODE_ENV: 'production' }
  })
  // Linux CI/containers have no keyring daemon; opt into Electron's plaintext
  // backend there so the vault path is still exercised. macOS uses Keychain.
  await app.evaluate(({ safeStorage }) => {
    if (process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true)
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object')
  // The renderer may re-route once on boot (e.g. onboarding on a fresh store);
  // let that settle before driving IPC so an evaluate isn't torn down mid-call.
  await win.waitForTimeout(1500)
  return { app, win }
}

const vault = (win: Page) => ({
  categories: () =>
    win.evaluate(() =>
      (window as unknown as { api: { vault: VaultBridge } }).api.vault.getCategories()
    ),
  entries: () =>
    win.evaluate(() =>
      (window as unknown as { api: { vault: VaultBridge } }).api.vault.getEntries('credentials')
    ),
  add: (entry: Record<string, unknown>) =>
    win.evaluate(
      (e) =>
        (window as unknown as { api: { vault: VaultBridge } }).api.vault.addEntry('credentials', e),
      entry
    )
})

test('launches on a fresh store and round-trips a vault entry across restarts', async () => {
  test.setTimeout(120_000)
  const home = mkdtempSync(join(tmpdir(), 'compass-e2e-'))
  const vaultDir = join(home, 'Library', 'Application Support', 'Compass', '.vault')
  let app: ElectronApplication | undefined
  try {
    let win: Page
    ;({ app, win } = await launch(home))

    const runtime = await app.evaluate(() => ({
      electron: process.versions.electron,
      modules: process.versions.modules
    }))
    console.log(
      `[e2e] Electron ${runtime.electron} (ABI ${runtime.modules}) on ${process.platform}`
    )
    expect(Number(runtime.electron.split('.')[0])).toBeGreaterThanOrEqual(45)

    await expect(win).toHaveTitle('Compass')
    expect(await win.evaluate(() => typeof (window as unknown as { api?: unknown }).api)).toBe(
      'object'
    )

    // Vault: first write generates the master key and seals it via safeStorage.
    expect((await vault(win).categories()).map((c) => c.id)).toContain('credentials')
    const added = await vault(win).add({ title: 'e2e-smoke', username: 'u', password: 'p@ss' })
    expect(added.id).toBeTruthy()
    expect(await vault(win).entries()).toEqual([
      expect.objectContaining({ id: added.id, title: 'e2e-smoke', password: 'p@ss' })
    ])
    expect(existsSync(join(vaultDir, 'key.enc'))).toBe(true)
    expect(existsSync(join(vaultDir, 'credentials.enc'))).toBe(true)

    await app.close()
    app = undefined

    // Restart: the persisted key.enc must unseal and the entry must survive.
    ;({ app, win } = await launch(home))
    // Read-only, so retrying across a late renderer navigation is safe.
    await expect
      .poll(
        () =>
          vault(win)
            .entries()
            .catch(() => null),
        { timeout: 15_000 }
      )
      .toEqual([expect.objectContaining({ id: added.id, title: 'e2e-smoke', password: 'p@ss' })])
  } finally {
    await app?.close()
    rmSync(home, { recursive: true, force: true })
  }
})
