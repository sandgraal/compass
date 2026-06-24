import { describe, expect, it } from 'vitest'
import {
  GOOGLE_ACTIVITY_RECOGNIZER as G,
  GOOGLE_CALENDAR_RECOGNIZER,
  GOOGLE_CHROME_RECOGNIZER,
  GOOGLE_FIT_RECOGNIZER,
  GOOGLE_PAY_RECOGNIZER,
  GOOGLE_PLAY_RECOGNIZER,
  GOOGLE_VOICE_RECOGNIZER
} from './google'
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

const file2 = (name: string, ext: string, text: string): RecognizerFile => ({ name, ext, text })

describe('Chrome history (Takeout JSON) recognizer', () => {
  const HISTORY = JSON.stringify({
    'Browser History': [
      { title: 'Example', url: 'https://example.com/a', time_usec: 1782316900830694 },
      { url: 'https://no-title.test/x', time_usec: 1700000000000000 }
    ]
  })
  it('detects the Takeout Browser History JSON, emitting browser/visit records', () => {
    expect(GOOGLE_CHROME_RECOGNIZER.detect(file2('History.json', 'json', HISTORY))).toBe(true)
    expect(GOOGLE_CHROME_RECOGNIZER.detect(file2('x.json', 'json', '[]'))).toBe(false)
    const out = GOOGLE_CHROME_RECOGNIZER.parse(file2('History.json', 'json', HISTORY))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'browser',
      type: 'visit',
      title: 'Example',
      body: 'example.com',
      occurredAt: Math.round(1782316900830694 / 1000) // µs → ms
    })
    expect(out[1].title).toBe('https://no-title.test/x') // falls back to the URL
  })
})

describe('Google Play purchases recognizer', () => {
  const PLAY = JSON.stringify([
    {
      purchaseHistory: {
        invoicePrice: '$0.00',
        doc: { documentType: 'Android Apps', title: 'Google One' },
        purchaseTime: '2026-04-09T22:24:04.567Z'
      }
    }
  ])
  it('parses nested purchaseHistory into google-play/purchase records', () => {
    expect(GOOGLE_PLAY_RECOGNIZER.detect(file2('Purchase History.json', 'json', PLAY))).toBe(true)
    const out = GOOGLE_PLAY_RECOGNIZER.parse(file2('Purchase History.json', 'json', PLAY))
    expect(out[0]).toMatchObject({
      source: 'google-play',
      type: 'purchase',
      title: 'Google One',
      body: 'Android Apps · $0.00',
      occurredAt: Date.parse('2026-04-09T22:24:04.567Z')
    })
  })
})

describe('Google Pay transactions recognizer', () => {
  const PAY = [
    'Time,Transaction ID,Description,Product,Payment method,Status,Amount',
    '"Nov 23, 2025, 3:13 PM",YTR.ABCD,YouTube Premium,YouTube,Amex,Complete,USD 15.87'
  ].join('\n')
  it('parses the transactions CSV into google-pay/payment records', () => {
    expect(GOOGLE_PAY_RECOGNIZER.detect(file2('transactions_1.csv', 'csv', PAY))).toBe(true)
    const out = GOOGLE_PAY_RECOGNIZER.parse(file2('transactions_1.csv', 'csv', PAY))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'google-pay',
      type: 'payment',
      title: 'YouTube Premium',
      body: 'USD 15.87 · Complete',
      naturalKey: 'YTR.ABCD'
    })
    expect(out[0].occurredAt).not.toBeNull()
  })
})

describe('Google Calendar (.ics) recognizer', () => {
  const ICS = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/Costa_Rica:20250707T063000',
    'SUMMARY:Wake\\, oral care',
    'LOCATION:Home',
    'UID:abc@google.com',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20251225',
    'SUMMARY:Holiday',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n')
  it('parses VEVENTs into gcal/event records, unescaping text and handling date-only', () => {
    expect(GOOGLE_CALENDAR_RECOGNIZER.detect(file2('Family.ics', 'ics', ICS))).toBe(true)
    const out = GOOGLE_CALENDAR_RECOGNIZER.parse(file2('Family.ics', 'ics', ICS))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'gcal',
      type: 'event',
      title: 'Wake, oral care', // \, unescaped
      body: 'Home',
      occurredAt: new Date(2025, 6, 7, 6, 30, 0).getTime() // local from parts
    })
    expect(out[1]).toMatchObject({
      title: 'Holiday',
      occurredAt: new Date(2025, 11, 25, 0, 0, 0).getTime()
    })
  })

  it('treats a trailing Z on DTSTART as UTC (not local)', () => {
    const ics = 'BEGIN:VEVENT\r\nDTSTART:20250707T133000Z\r\nSUMMARY:UTC event\r\nEND:VEVENT'
    const out = GOOGLE_CALENDAR_RECOGNIZER.parse(file2('z.ics', 'ics', ics))
    expect(out[0].occurredAt).toBe(Date.UTC(2025, 6, 7, 13, 30, 0))
  })
})

describe('Google Fit daily activity recognizer', () => {
  const HEADER = 'Move Minutes count,Calories (kcal),Distance (m),Step count'
  it('parses the aggregate file (Date column) as one record per day', () => {
    const csv = `Date,${HEADER}\n2026-05-10,1,966,84,225\n2026-05-11,3,1683,178,350`
    expect(GOOGLE_FIT_RECOGNIZER.detect(file2('Daily activity metrics.csv', 'csv', csv))).toBe(true)
    const out = GOOGLE_FIT_RECOGNIZER.parse(file2('Daily activity metrics.csv', 'csv', csv))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'google-fit',
      type: 'fitness',
      title: '225 steps',
      body: '966 kcal · 0.1 km · 1 move min',
      naturalKey: 'gfit|2026-05-10'
    })
  })

  it('sums the 15-min segments of a per-day file, dating it from the filename', () => {
    const csv = `Start time,${HEADER}\n00:00,1,500,40,100\n00:15,1,466,44,125`
    const out = GOOGLE_FIT_RECOGNIZER.parse(file2('2026-05-12.csv', 'csv', csv))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ title: '225 steps', naturalKey: 'gfit|2026-05-12' }) // 100+125
    expect(out[0].body).toContain('966 kcal') // 500+466
  })
})

describe('Google Voice recognizer (content-light, filename-driven)', () => {
  it('detects the Calls filename pattern and parses kind + timestamp from the name', () => {
    const f = file2(
      'Dillon Ennis - Text - 2026-06-17T22_58_46Z.html',
      'html',
      '<html>ignored</html>'
    )
    expect(GOOGLE_VOICE_RECOGNIZER.detect(f)).toBe(true)
    const out = GOOGLE_VOICE_RECOGNIZER.parse(f)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'google-voice',
      type: 'text',
      title: 'Text with Dillon Ennis',
      occurredAt: Date.parse('2026-06-17T22:58:46Z') // _ → : , UTC
    })
  })

  it('maps the call kinds and ignores non-Voice HTML', () => {
    const kind = (name: string): string | undefined =>
      GOOGLE_VOICE_RECOGNIZER.parse(file2(name, 'html', ''))[0]?.type
    expect(kind('A - Missed - 2026-01-01T00_00_00Z.html')).toBe('call')
    expect(kind('A - Placed - 2026-01-01T00_00_00Z.html')).toBe('call')
    expect(kind('A - Voicemail - 2026-01-01T00_00_00Z.html')).toBe('voicemail')
    expect(GOOGLE_VOICE_RECOGNIZER.detect(file2('MyActivity.html', 'html', ''))).toBe(false)
  })
})
