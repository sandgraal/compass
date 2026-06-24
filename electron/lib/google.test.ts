import { describe, expect, it } from 'vitest'
import { GOOGLE_ACTIVITY_RECOGNIZER as G } from './google'
import type { RecognizerFile } from './recognizers'

// Mirrors Google Takeout's "My Activity" / YouTube-history HTML template: repeating
// `outer-cell` blocks with a `header-cell` (the product) and a `content-cell …
// body-1` (the action + links + a "Mon DD, YYYY, h:mm:ss AM TZ" date). The YouTube
// cell uses the narrow no-break space Google puts before AM/PM. The Chrome-style
// cell's header is a domain (not "Chrome") — typed off the "Visited" verb. The last
// cell is undated and must be skipped.
const FIXTURE = `<!doctype html><html><body><div class="mdl-grid">
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
  <div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">YouTube<br></p></div>
  <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched&nbsp;<a href="https://youtu.be/x">Tiny Desk</a><br><a href="https://youtube.com/c/npr">NPR Music</a><br>Jun 23, 2026, 12:25:59 AM EDT<br></div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
  <div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">site.example.com<br></p></div>
  <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Visited <a href="https://site.example.com/foo">Foo Page</a><br>Apr 10, 2026, 9:14:41 PM EDT<br></div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
  <div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Maps<br></p></div>
  <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Searched for Santafé Mall<br>Jan 02, 2025, 8:00:00 AM EST<br></div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
  <div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Android<br></p></div>
  <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Used Digital Wellbeing</div>
</div></div>
</body></html>`

const file = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'MyActivity.html',
  ext: 'html',
  text: FIXTURE,
  ...over
})

describe('Google My Activity recognizer', () => {
  it('detects the mdl "My Activity" template, not arbitrary HTML or Facebook exports', () => {
    expect(G.detect(file())).toBe(true)
    expect(G.detect(file({ text: '<html><body>just a page</body></html>' }))).toBe(false)
    // A Facebook _a6-g block must not be claimed as Google activity.
    expect(G.detect(file({ text: '<div class="_a6-g"><h2>x</h2></div>' }))).toBe(false)
    expect(G.detect(file({ ext: 'csv' }))).toBe(false)
  })

  it('emits one record per DATED cell (undated skipped), titled minus the timestamp', () => {
    const out = G.parse(file())
    expect(out).toHaveLength(3) // the undated "Used Digital Wellbeing" cell is skipped
    expect(out[0]).toMatchObject({
      source: 'google',
      type: 'watch', // YouTube product
      title: 'Watched Tiny Desk NPR Music', // links flattened, date stripped, entity nbsp collapsed
      body: 'YouTube',
      occurredAt: new Date(2026, 5, 23, 0, 25, 59).getTime() // Jun 23 2026 12:25:59 AM (narrow-nbsp) local
    })
    // Chrome groups by domain, so the header is a URL — typed off the "Visited" verb.
    expect(out[1]).toMatchObject({
      type: 'visit',
      title: 'Visited Foo Page',
      body: 'site.example.com'
    })
    // Maps search (UTF-8 preserved).
    expect(out[2]).toMatchObject({ type: 'maps', title: 'Searched for Santafé Mall' })
    expect(out[2].occurredAt).toBe(new Date(2025, 0, 2, 8, 0, 0).getTime())
    expect(new Set(out.map((r) => r.naturalKey)).size).toBe(3)
  })

  it('derives the kind from the product, falling back to the action verb', () => {
    const kind = (product: string, action: string): string | undefined => {
      const text = `<div class="outer-cell"><div class="header-cell"><p class="mdl-typography--title">${product}</p></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${action}<br>Jan 02, 2025, 8:00:00 AM EST</div></div>`
      return G.parse(file({ text }))[0]?.type
    }
    expect(kind('YouTube', 'Searched for cats')).toBe('search') // YouTube search-history
    expect(kind('Maps', 'Used Maps')).toBe('maps')
    expect(kind('Assistant', 'Used Assistant')).toBe('assistant')
    expect(kind('Google Play Store', 'Used App')).toBe('app')
    expect(kind('some-site.com', 'Visited Page')).toBe('visit') // verb fallback
    expect(kind('Discover', '20 cards in your feed')).toBe('activity') // no verb match
  })
})
