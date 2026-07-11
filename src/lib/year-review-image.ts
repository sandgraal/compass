/**
 * Build a shareable Year-in-Review card as a self-contained SVG string
 * (Timeline 2.1). Pure + unit-tested. The renderer rasterizes it to PNG via an
 * offscreen canvas (a `data:image/svg+xml` URI — CSP-safe, no network, no
 * dependency) and saves it through an IPC dialog. Deliberately a FIXED dark
 * brand look (not theme-dependent) so the exported image reads well anywhere.
 *
 * No external fonts or images — only inline shapes + generic sans-serif — so it
 * rasterizes identically offline and never taints the canvas.
 */

export type YearReviewCard = {
  year: number
  totalRecords: number
  sources: number
  newPeople: number
  countries: number
  narrative: string
}

export const CARD_W = 1200
export const CARD_H = 630

/** XML-escape text going into SVG (&, <, >, ", '). */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Greedy word-wrap into at most `maxLines` lines of ≤ `maxChars` each (last line ellipsized). */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  // Hard-split any single token longer than the budget so the ≤ maxChars
  // guarantee holds even for an unbroken run (e.g. a long URL) and the card
  // never overflows its fixed width.
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => {
      if (w.length <= maxChars) return [w]
      const chunks: string[] = []
      for (let i = 0; i < w.length; i += maxChars) chunks.push(w.slice(i, i + maxChars))
      return chunks
    })
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (next.length > maxChars && line) {
      lines.push(line)
      line = w
      if (lines.length === maxLines) break
    } else {
      line = next
    }
  }
  if (lines.length < maxLines && line) lines.push(line)
  // If we ran out of lines with words left, ellipsize the last.
  const consumed = lines.join(' ').split(/\s+/).filter(Boolean).length
  if (consumed < words.length && lines.length > 0) {
    const last = lines[lines.length - 1]
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
  }
  return lines
}

export function buildYearReviewSvg(card: YearReviewCard): string {
  // Fixed literal copies of the app's DARK-theme design tokens (src/globals.css).
  // The card is deliberately theme-independent — it's rasterized standalone into
  // a PNG that renders outside the app, where CSS vars aren't available — so we
  // inline the same HSL values the UI uses rather than reference `var(--…)`.
  const bg = 'hsl(222 47% 7%)' // --background
  const panel = 'hsl(222 47% 9%)' // --card
  const border = 'hsl(222 47% 16%)' // --border
  const text = 'hsl(213 31% 91%)' // --foreground
  const muted = 'hsl(215 20% 55%)' // --muted-foreground
  const accent = 'hsl(238 82% 68%)' // --primary (Compass indigo)

  const narrativeLines = wrapText(card.narrative, 64, 4)
  const stats: Array<{ label: string; value: string }> = [
    { label: 'Records', value: card.totalRecords.toLocaleString() },
    { label: 'Sources', value: String(card.sources) },
    { label: 'New people', value: String(card.newPeople) },
    { label: 'Countries', value: String(card.countries) }
  ]

  const narrativeTspans = narrativeLines
    .map((ln, i) => `<tspan x="80" dy="${i === 0 ? 0 : 40}">${escapeXml(ln)}</tspan>`)
    .join('')

  const statCards = stats
    .map((s, i) => {
      const x = 80 + i * 262
      return `<g transform="translate(${x}, 430)">
        <rect width="242" height="120" rx="16" fill="${panel}" stroke="${border}"/>
        <text x="24" y="46" font-size="18" fill="${muted}" font-family="sans-serif">${escapeXml(s.label)}</text>
        <text x="24" y="92" font-size="42" font-weight="700" fill="${text}" font-family="sans-serif">${escapeXml(s.value)}</text>
      </g>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <rect width="${CARD_W}" height="${CARD_H}" fill="${bg}"/>
  <rect x="0" y="0" width="${CARD_W}" height="8" fill="${accent}"/>
  <text x="80" y="120" font-size="28" fill="${accent}" font-family="sans-serif" font-weight="600" letter-spacing="2">YEAR IN REVIEW</text>
  <text x="80" y="230" font-size="112" font-weight="800" fill="${text}" font-family="sans-serif">${card.year}</text>
  <text y="320" font-size="30" fill="${text}" font-family="sans-serif">${narrativeTspans}</text>
  ${statCards}
  <text x="80" y="596" font-size="18" fill="${muted}" font-family="sans-serif">Compass · computed locally, on your machine</text>
</svg>`
}
