import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
          'quick-capture': resolve('src/quickCapture/index.html')
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
