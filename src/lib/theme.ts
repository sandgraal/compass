/**
 * Theme + accent customization (Phase 7 Track F).
 *
 * Pure helpers only — resolution and CSS-variable math live here so they
 * unit-test in a node environment; the DOM application (class toggling,
 * inline custom properties) happens in `appStore.ts`.
 *
 * Persistence keys (app_settings): `theme` = 'dark' | 'light' | 'system'
 * (pre-existing), `accentColor` = an AccentId below.
 */

export type ResolvedTheme = 'dark' | 'light'
export type ThemePreference = ResolvedTheme | 'system'

export const DEFAULT_ACCENT = 'indigo'

export interface AccentOption {
  id: string
  label: string
  /** HSL triplets (no `hsl()` wrapper — matches the stylesheet convention). */
  dark: string
  light: string
  /** Foreground paired with the accent, per theme — keeps contrast safe. */
  fgDark: string
  fgLight: string
}

/**
 * Accent presets. `indigo` mirrors the stylesheet defaults exactly — picking
 * it removes the inline overrides instead of duplicating them, so the
 * stylesheet stays the single source of truth for the default look.
 * Light-hued accents (amber) keep a dark foreground in BOTH themes.
 */
export const ACCENT_OPTIONS: readonly AccentOption[] = [
  {
    id: 'indigo',
    label: 'Indigo',
    dark: '238 82% 68%',
    light: '238 82% 58%',
    fgDark: '222 47% 7%',
    fgLight: '0 0% 100%'
  },
  {
    id: 'violet',
    label: 'Violet',
    dark: '270 75% 70%',
    light: '270 70% 55%',
    fgDark: '222 47% 7%',
    fgLight: '0 0% 100%'
  },
  {
    id: 'emerald',
    label: 'Emerald',
    dark: '160 70% 45%',
    light: '160 80% 32%',
    fgDark: '222 47% 7%',
    fgLight: '0 0% 100%'
  },
  {
    id: 'amber',
    label: 'Amber',
    dark: '38 92% 55%',
    light: '32 95% 44%',
    fgDark: '222 47% 7%',
    fgLight: '222 47% 7%'
  },
  {
    id: 'rose',
    label: 'Rose',
    dark: '350 80% 65%',
    light: '347 77% 50%',
    fgDark: '222 47% 7%',
    fgLight: '0 0% 100%'
  },
  {
    id: 'sky',
    label: 'Sky',
    dark: '199 90% 55%',
    light: '201 96% 36%',
    fgDark: '222 47% 7%',
    fgLight: '0 0% 100%'
  }
] as const

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system'
}

/** Resolve a stored preference against the current OS theme. */
export function resolveTheme(pref: ThemePreference, osTheme: ResolvedTheme): ResolvedTheme {
  return pref === 'system' ? osTheme : pref
}

/**
 * Inline CSS custom-property overrides for an accent, or null when the
 * accent is the default (or unknown) — null means "remove overrides and let
 * the stylesheet rule".
 */
export function accentVars(accentId: string, theme: ResolvedTheme): Record<string, string> | null {
  if (accentId === DEFAULT_ACCENT) return null
  const accent = ACCENT_OPTIONS.find((a) => a.id === accentId)
  if (!accent) return null
  const hue = theme === 'dark' ? accent.dark : accent.light
  const fg = theme === 'dark' ? accent.fgDark : accent.fgLight
  return {
    '--primary': hue,
    '--primary-foreground': fg,
    '--accent': hue,
    '--accent-foreground': fg,
    '--ring': hue
  }
}

/** The custom properties accentVars may set — used to clear stale overrides. */
export const ACCENT_VAR_NAMES = [
  '--primary',
  '--primary-foreground',
  '--accent',
  '--accent-foreground',
  '--ring'
] as const
