/**
 * Runs once before any spec, outside per-test timeouts.
 *
 * Since Electron 42 the `electron` package no longer downloads its binary at
 * install time; the first `require('electron')` does. On a fresh CI runner that
 * download, plus macOS's first-launch scan of the unsigned Electron.app, took
 * longer than a test's timeout and made the first launch spec fail before its
 * retry passed. Fetch the binary and execute it once here so specs start warm.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

export default function globalSetup(): void {
  const started = Date.now()
  const electronPath = createRequire(__filename)('electron') as string
  execFileSync(electronPath, ['--version'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    timeout: 300_000
  })
  console.log(`[e2e] Electron binary ready in ${Date.now() - started} ms: ${electronPath}`)
}
