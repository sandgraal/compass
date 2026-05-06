import { resolve } from 'node:path'
/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'mcp/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'dist-electron', 'out', 'release', 'e2e/**', '.changeset'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['electron/ipc/**/*.ts', 'electron/knowledge/**/*.ts', 'src/lib/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      thresholds: {
        // Security-critical surfaces — keep these high
        'electron/ipc/**/*.ts': { lines: 70, functions: 70, branches: 60, statements: 70 },
        'electron/knowledge/**/*.ts': { lines: 70, functions: 70, branches: 60, statements: 70 }
      }
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  }
})
