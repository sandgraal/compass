import { describe, expect, it } from 'vitest'
import { FACEBOOK_POSTS_RECOGNIZER as R } from './facebook'
import type { RecognizerFile } from './recognizers'

// Mirrors the real FB "Download Your Information" HTML export shape: each post is
// a `_a6-g` block with an <h2> action, the content, a "Updated <date>" line, and
// a DYI permalink footer. (Validated end-to-end against a real 164-post export.)
const FIXTURE = `<!doctype html><html><body>
<div class="_a6-g"><div aria-labelledby="x">
  <h2 class="_2ph_ _a6-h _a6-i">Christopher D Ennis shared a link.</h2>
  <div class="_2ph_ _a6-p">
    <div class="_2pin"><a href="http://example.com/abc">http://example.com/abc</a></div>
    <div class="_2pin"><div>Updated May 02, 2011 8:12:17 am</div></div>
  </div></div>
  <footer class="_3-94 _a6-o"><a href="https://www.facebook.com/dyi/l/?l=AYC">x</a></footer>
</div>
<div class="_a6-g"><div>
  <h2 class="_2ph_ _a6-h _a6-i">Christopher D Ennis updated his status.</h2>
  <div class="_2ph_ _a6-p">
    <div class="_2pin">Hello world &amp; good morning.</div>
    <div class="_2pin"><div>Dec 25, 2020 11:30:00 pm</div></div>
  </div></div>
  <footer class="_3-94 _a6-o"><a href="https://www.facebook.com/dyi/l/?l=ZZZ">x</a></footer>
</div>
</body></html>`

const file = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'your_posts__check_ins__photos_and_videos_1.html',
  ext: 'html',
  text: FIXTURE,
  ...over
})

describe('Facebook posts recognizer', () => {
  it('detects the DYI posts HTML (by filename or the post-block class)', () => {
    expect(R.detect(file())).toBe(true)
    // Renamed file still detected via the _a6-g + dyi content signature.
    expect(R.detect(file({ name: 'whatever.html' }))).toBe(true)
  })

  it('does not claim non-Facebook HTML or non-HTML files', () => {
    expect(R.detect(file({ text: '<html><body>just a page</body></html>' }))).toBe(false)
    expect(R.detect(file({ ext: 'csv' }))).toBe(false)
  })

  it('parses one record per post with the action, body, and local-time date', () => {
    const out = R.parse(file())
    expect(out).toHaveLength(2)

    const [a, b] = out
    expect(a.source).toBe('facebook')
    expect(a.type).toBe('post')
    expect(a.title).toBe('Christopher D Ennis shared a link.')
    expect(a.occurredAt).toBe(new Date(2011, 4, 2, 8, 12, 17).getTime()) // May 2 2011, 8:12:17 am LOCAL
    expect(a.body).toContain('example.com/abc')
    // The "Updated <date>" metadata is stripped out of the body.
    expect(a.body).not.toContain('May 02')
    expect(a.body).not.toMatch(/Updated/)

    expect(b.title).toBe('Christopher D Ennis updated his status.')
    expect(b.occurredAt).toBe(new Date(2020, 11, 25, 23, 30, 0).getTime()) // Dec 25 2020, 11:30 pm → 23:30
    expect(b.body).toBe('Hello world & good morning.') // entities decoded
    expect(a.naturalKey).not.toBe(b.naturalKey)
  })
})
