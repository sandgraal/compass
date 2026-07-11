/**
 * Pure Timeline presentation helpers (Timeline 2.1) — colocated here (a plain
 * `.ts`) rather than in `timeline-meta.tsx` so they're unit-testable in the
 * node env without pulling JSX/React through the import. Re-exported from
 * `timeline-meta` so components keep a single import site.
 *
 * `payloadFacts` turns a record's stored `payload` (the original export row,
 * JSON) into a small label→value fact grid for the detail drawer — so it shows
 * "Runtime: 180 min · Genre: Rap" instead of only a raw-JSON dump. Deliberately
 * conservative: scalars only, skips empty / "Not Available" sentinels and
 * dedup-only id keys, humanizes keys, caps the count.
 */

// Per-source hue (0–360) — the strongest at-a-glance signal, previously unused.
// Roughly brand-evocative where a brand exists (Netflix/YouTube red, Spotify
// green, LinkedIn/PayPal blue…), grouped by family otherwise. Rendered at a
// fixed saturation/lightness tuned to read on both the light and dark card, so
// it never has to know the theme. Sources not listed → null (stay neutral gray),
// so color means "a distinct thing", not noise.
const SOURCE_HUE: Record<string, number> = {
  netflix: 0,
  youtube: 0,
  'prime-video': 28,
  amazon: 32,
  kindle: 32,
  'amazon-music': 32,
  alexa: 20,
  spotify: 141,
  imessage: 135,
  'google-fit': 145,
  paypal: 215,
  venmo: 205,
  finance: 210,
  paystub: 200,
  linkedin: 205,
  facebook: 221,
  google: 217,
  'google-play': 217,
  'google-pay': 217,
  'google-voice': 217,
  gcal: 211,
  goodreads: 28,
  'apple-health': 340,
  oura: 265,
  github: 250,
  linear: 255,
  goal: 262,
  task: 258,
  medical: 182,
  travel: 195,
  utility: 40,
  'credit-report': 268,
  'rental-comp': 150
}

/**
 * A stable HSL color for a source's icon + accent rail, or null for neutral
 * (generic/browser/identity sources). Pure — unit-tested.
 */
export function sourceColor(source: string): string | null {
  const hue = SOURCE_HUE[source]
  if (hue == null) return null
  return `hsl(${hue} 62% 52%)`
}

export type MemoryTier = 'high' | 'mid' | 'low'

/**
 * Bucket a 0–100 memory-worthiness score (from timeline-memories.ts) into the
 * visual weight a card gets in the hero. Pure — unit-tested. Undefined score
 * (browse/day lists, where score isn't computed) → 'mid' (uniform weight).
 */
export function memoryTier(score: number | undefined): MemoryTier {
  if (score == null) return 'mid'
  if (score >= 70) return 'high'
  if (score >= 35) return 'mid'
  return 'low'
}

const NOT_AVAILABLE = /^(not|data not) available$/i

/** Keys that are plumbing (dedup / internal ids), never worth showing. */
function isNoiseKey(key: string): boolean {
  const norm = key.trim().toLowerCase().replace(/[_-]+/g, ' ')
  if (/\b(asin|guid|uuid|dedup|hash)\b/.test(norm)) return true
  if (/id$/.test(norm.replace(/\s+/g, ''))) return true // ...Id / ..._id
  return false
}

export function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function payloadFacts(
  payload: string | null | undefined,
  max = 8
): Array<{ label: string; value: string }> {
  if (!payload) return []
  let obj: unknown
  try {
    obj = JSON.parse(payload)
  } catch {
    return []
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
  const out: Array<{ label: string; value: string }> = []
  for (const [key, raw] of Object.entries(obj as Record<string, unknown>)) {
    if (out.length >= max) break
    if (raw == null || typeof raw === 'object') continue // scalars only
    if (isNoiseKey(key)) continue
    let value = String(raw).trim()
    if (!value || NOT_AVAILABLE.test(value)) continue
    if (value.length > 140) value = `${value.slice(0, 137)}…`
    out.push({ label: humanizeKey(key), value })
  }
  return out
}
