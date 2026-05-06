// Minimal ESLint config — covers ONLY the React-specific rules Biome doesn't yet have.
// Biome handles all general TS/JS lint + format. ESLint is the safety net for hooks.
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    ignores: [
      'dist',
      'dist-electron',
      'out',
      'release',
      'node_modules',
      'knowledge-base',
      '.vault',
      '.data',
      '*.tsbuildinfo'
    ]
  }
]
