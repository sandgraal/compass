import { create } from 'zustand'
import {
  ACCENT_VAR_NAMES,
  DEFAULT_ACCENT,
  type ResolvedTheme,
  type ThemePreference,
  accentVars,
  resolveTheme
} from '../lib/theme'

interface AppStore {
  /** Resolved theme actually applied to the DOM. */
  theme: ResolvedTheme
  /** User preference — 'system' tracks the OS (Phase 7 Track F). */
  themePreference: ThemePreference
  /** Last-known OS theme; only matters while preference is 'system'. */
  osTheme: ResolvedTheme
  accent: string
  setThemePreference: (p: ThemePreference) => void
  setOsTheme: (t: ResolvedTheme) => void
  setAccent: (accentId: string) => void
  contextDrawerOpen: boolean
  setContextDrawerOpen: (open: boolean) => void
  syncing: Record<string, boolean>
  setSyncing: (service: string, value: boolean) => void
}

function applyToDom(theme: ResolvedTheme, accent: string): void {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  if (theme === 'light') root.classList.add('light')
  // Accent overrides ride as inline custom properties; the default accent
  // clears them so the stylesheet keeps owning the default palette.
  const vars = accentVars(accent, theme)
  for (const name of ACCENT_VAR_NAMES) root.style.removeProperty(name)
  if (vars) {
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  }
}

export const useAppStore = create<AppStore>((set, get) => {
  const apply = (pref: ThemePreference, osTheme: ResolvedTheme, accent: string): void => {
    const theme = resolveTheme(pref, osTheme)
    set({ theme, themePreference: pref, osTheme, accent })
    applyToDom(theme, accent)
  }
  return {
    theme: 'dark',
    themePreference: 'system',
    osTheme: 'dark',
    accent: DEFAULT_ACCENT,
    setThemePreference: (p) => apply(p, get().osTheme, get().accent),
    setOsTheme: (t) => apply(get().themePreference, t, get().accent),
    setAccent: (accentId) => apply(get().themePreference, get().osTheme, accentId),
    contextDrawerOpen: true,
    setContextDrawerOpen: (open) => set({ contextDrawerOpen: open }),
    syncing: {},
    setSyncing: (service, value) => set((s) => ({ syncing: { ...s.syncing, [service]: value } }))
  }
})
