/**
 * Tests for the theme/accent helpers (Phase 7 Track F). Pure functions only —
 * DOM application lives in the store and is exercised by the running app.
 */
import { describe, expect, it } from 'vitest'
import {
  ACCENT_OPTIONS,
  ACCENT_VAR_NAMES,
  DEFAULT_ACCENT,
  accentVars,
  isThemePreference,
  resolveTheme
} from './theme'

describe('resolveTheme', () => {
  it('passes explicit preferences through and resolves system from the OS', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark')
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('system', 'dark')).toBe('dark')
    expect(resolveTheme('system', 'light')).toBe('light')
  })
})

describe('isThemePreference', () => {
  it('accepts the three valid values and rejects everything else', () => {
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('light')).toBe(true)
    expect(isThemePreference('system')).toBe(true)
    expect(isThemePreference('auto')).toBe(false)
    expect(isThemePreference(undefined)).toBe(false)
  })
})

describe('accentVars', () => {
  it('returns null for the default accent and for unknown ids', () => {
    expect(accentVars(DEFAULT_ACCENT, 'dark')).toBeNull()
    expect(accentVars('hotpink-glitter', 'dark')).toBeNull()
  })

  it('returns per-theme overrides covering exactly the declared var names', () => {
    const dark = accentVars('emerald', 'dark')
    const light = accentVars('emerald', 'light')
    expect(dark).not.toBeNull()
    expect(Object.keys(dark ?? {}).sort()).toEqual([...ACCENT_VAR_NAMES].sort())
    // Dark and light variants differ so contrast holds in both themes.
    expect(dark?.['--primary']).not.toBe(light?.['--primary'])
    expect(dark?.['--primary']).toBe(dark?.['--ring'])
  })

  it('keeps a dark foreground for light-hued accents in both themes', () => {
    const amberDark = accentVars('amber', 'dark')
    const amberLight = accentVars('amber', 'light')
    expect(amberDark?.['--primary-foreground']).toBe(amberLight?.['--primary-foreground'])
  })

  it('every non-default option produces overrides (no dead swatches)', () => {
    for (const a of ACCENT_OPTIONS) {
      if (a.id === DEFAULT_ACCENT) continue
      expect(accentVars(a.id, 'dark')).not.toBeNull()
      expect(accentVars(a.id, 'light')).not.toBeNull()
    }
  })
})
