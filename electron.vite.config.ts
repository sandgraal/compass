import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import { copyMigrationsToBuild } from './electron/db/copy-migrations'
import { QUICK_CAPTURE_HTML_ENTRY } from './electron/quick-capture-path'

/**
 * Ship the Drizzle migrations alongside the built main process (out/main/migrations)
 * so `migrate()` in electron/db/client.ts works in `electron-vite dev` and in the
 * packaged asar (electron-builder bundles `out/**`). See copy-migrations.ts for why.
 */
function copyMigrationsPlugin(): Plugin {
  const source = resolve('electron/db/migrations')
  let outDir = resolve('out/main')
  return {
    name: 'compass:copy-migrations',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      copyMigrationsToBuild(source, outDir)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMigrationsPlugin()],
    build: {
      lib: {
        entry: resolve('electron/main.ts')
      }
    },
    resolve: {
      alias: {
        '@main': resolve('electron')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/preload.ts'),
          'quick-capture': resolve('electron/preload-quick-capture.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: {
          index: resolve('index.html'),
          'quick-capture': resolve(QUICK_CAPTURE_HTML_ENTRY)
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src'),
        '@': resolve('src')
      }
    },
    plugins: [react()]
  }
})
