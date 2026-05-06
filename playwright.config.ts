import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Electron — single instance only
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    actionTimeout: 10_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },

  projects: [
    {
      name: 'electron-mac',
      // E2E specs use electron-playwright-helpers to drive the built app
      testMatch: /.*\.e2e\.ts/
    }
  ],

  // Build the app before E2E
  webServer: {
    command: 'npm run build',
    reuseExistingServer: true,
    timeout: 120_000
  }
})
