import { describe, expect, it } from 'vitest'
import {
  FACEBOOK_ACTIVITY_RECOGNIZER,
  FACEBOOK_COMMENTS_RECOGNIZER,
  FACEBOOK_FRIENDS_RECOGNIZER,
  FACEBOOK_MESSAGES_RECOGNIZER,
  FACEBOOK_POSTS_RECOGNIZER as R
} from './facebook'
import type { RecognizerFile } from './recognizers'

// Mirrors the real FB "Download Your Information" HTML export shape: each post is
// a `_a6-g` block with an <h2> action, the content, a "Updated <date>" line, and
// a DYI permalink footer.
const FIXTURE = `<!doctype html><html><body>
<div class="_a6-g"><div aria-labelledby="x">
  <h2 class="_2ph_ _a6-h _a6-i">Jane Doe shared a link.</h2>
  <div class="_2ph_ _a6-p">
    <div class="_2pin"><a href="http://example.com/abc">http://example.com/abc</a></div>
    <div class="_2pin"><div>Updated May 02, 2011 8:12:17 am</div></div>
  </div></div>
  <footer class="_3-94 _a6-o"><a href="https://www.facebook.com/dyi/l/?l=AYC">x</a></footer>
</div>
<div class="_a6-g"><div>
  <h2 class="_2ph_ _a6-h _a6-i">Jane Doe updated her status.</h2>
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
  it('detects the DYI posts HTML by its section filename', () => {
    expect(R.detect(file())).toBe(true)
    // Filename-anchored: other FB sections share the _a6-g block, so a non-posts
    // filename (e.g. the friends file) must NOT be claimed by the posts recognizer.
    expect(R.detect(file({ name: 'your_friends.html' }))).toBe(false)
    expect(R.detect(file({ name: 'whatever.html' }))).toBe(false)
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
    expect(a.title).toBe('Jane Doe shared a link.')
    expect(a.occurredAt).toBe(new Date(2011, 4, 2, 8, 12, 17).getTime()) // May 2 2011, 8:12:17 am LOCAL
    expect(a.body).toContain('example.com/abc')
    // The "Updated <date>" metadata is stripped out of the body.
    expect(a.body).not.toContain('May 02')
    expect(a.body).not.toMatch(/Updated/)

    expect(b.title).toBe('Jane Doe updated her status.')
    expect(b.occurredAt).toBe(new Date(2020, 11, 25, 23, 30, 0).getTime()) // Dec 25 2020, 11:30 pm → 23:30
    expect(b.body).toBe('Hello world & good morning.') // entities decoded
    expect(a.naturalKey).not.toBe(b.naturalKey)
  })
})

// The friends file has no DYI permalinks — only the `_a6-g` block with the name
// in the <h2> and the connection date in the footer.
const FRIENDS_FIXTURE = `<!doctype html><html><body>
<div class="_a6-g"><div aria-labelledby="u_0_cm">
  <h2 class="_2ph_ _a6-h _a6-i">John Smith</h2>
  <footer class="_3-94 _a6-o _2pie"><div class="_a72d">May 17, 2026 2:05:15 pm</div></footer>
</div>
<div class="_a6-g"><div>
  <h2 class="_2ph_ _a6-h _a6-i">Alice Johnson</h2>
  <footer class="_3-94 _a6-o _2pie"><div class="_a72d">Apr 30, 2011 6:02:45 am</div></footer>
</div>
</body></html>`

const friendFile = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'your_friends.html',
  ext: 'html',
  text: FRIENDS_FIXTURE,
  ...over
})

describe('Facebook friends recognizer', () => {
  it('detects your_friends.html (no permalinks → keyed off the _a6-g block)', () => {
    expect(FACEBOOK_FRIENDS_RECOGNIZER.detect(friendFile())).toBe(true)
    // The posts recognizer must NOT claim the friends file, and vice versa.
    expect(R.detect(friendFile())).toBe(false)
    expect(FACEBOOK_FRIENDS_RECOGNIZER.detect(friendFile({ name: 'your_posts__1.html' }))).toBe(
      false
    )
  })

  it('parses one dated connection record per friend', () => {
    const out = FACEBOOK_FRIENDS_RECOGNIZER.parse(friendFile())
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'facebook',
      type: 'connection',
      title: 'Became friends with John Smith',
      occurredAt: new Date(2026, 4, 17, 14, 5, 15).getTime() // May 17 2026, 2:05:15 pm local
    })
    expect(out[1].title).toBe('Became friends with Alice Johnson')
    expect(out[1].occurredAt).toBe(new Date(2011, 3, 30, 6, 2, 45).getTime()) // Apr 30 2011, 6:02:45 am
    expect(out[0].naturalKey).not.toBe(out[1].naturalKey)
  })
})

// Comments: the <h2> is the context, an `_a6-p` div holds the comment text (kept,
// unlike posts), the footer holds the date. (Validated against a real export of
// thousands of comments spanning 2009–2026.)
const COMMENTS_FIXTURE = `<!doctype html><html><body>
<div class="_a6-g"><div aria-labelledby="c1">
  <h2 class="_2ph_ _a6-h _a6-i">Christopher D Ennis commented on a friend's post.</h2>
  <div class="_2ph_ _a6-p"><div class="_2pin">Great pics, Ma &amp; Pa!</div></div>
  <footer class="_3-94 _a6-o"><div class="_a72d">Jan 20, 2009 1:17:08 pm</div></footer>
</div>
<div class="_a6-g"><div aria-labelledby="c2">
  <h2 class="_2ph_ _a6-h _a6-i">Christopher D Ennis commented on a photo.</h2>
  <footer class="_3-94 _a6-o"><div class="_a72d">Jun 15, 2015 9:00:00 am</div></footer>
</div>
</body></html>`

const commentFile = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'comments.html',
  ext: 'html',
  text: COMMENTS_FIXTURE,
  ...over
})

describe('Facebook comments recognizer', () => {
  it('detects comments.html and does not cross-claim posts/friends', () => {
    expect(FACEBOOK_COMMENTS_RECOGNIZER.detect(commentFile())).toBe(true)
    expect(R.detect(commentFile())).toBe(false)
    expect(FACEBOOK_FRIENDS_RECOGNIZER.detect(commentFile())).toBe(false)
    expect(FACEBOOK_COMMENTS_RECOGNIZER.detect(commentFile({ name: 'your_posts__1.html' }))).toBe(
      false
    )
  })

  it('parses one comment record per block, keeping the comment text as the body', () => {
    const out = FACEBOOK_COMMENTS_RECOGNIZER.parse(commentFile())
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'facebook',
      type: 'comment',
      title: "Christopher D Ennis commented on a friend's post.",
      occurredAt: new Date(2009, 0, 20, 13, 17, 8).getTime() // Jan 20 2009, 1:17:08 pm local
    })
    expect(out[0].body).toBe('Great pics, Ma & Pa!') // _a6-p text kept + entity decoded
    // A comment with no text body still becomes a dated record (title only).
    expect(out[1].title).toBe('Christopher D Ennis commented on a photo.')
    expect(out[1].occurredAt).toBe(new Date(2015, 5, 15, 9, 0, 0).getTime())
    expect(out[1].body).toBeUndefined()
  })
})

// Messages: a conversation file (message_N.html) — the <title> is the other
// party, `_a6-g` blocks are messages. Aggregated to content-light daily counts;
// the message TEXT is never stored. (Validated against real conversations.)
const MESSAGES_FIXTURE = `<!doctype html><html><head><title>Jane Doe</title></head><body>
<div class="_a6-g"><div><div class="_2ph_ _a6-p">hey there</div>
  <footer class="_3-94 _a6-o"><div class="_a72d">Jun 25, 2021 3:33:52 pm</div></footer></div></div>
<div class="_a6-g"><div><div class="_2ph_ _a6-p">how are you</div>
  <footer class="_3-94 _a6-o"><div class="_a72d">Jun 25, 2021 4:00:00 pm</div></footer></div></div>
<div class="_a6-g"><div><div class="_2ph_ _a6-p">bye now</div>
  <footer class="_3-94 _a6-o"><div class="_a72d">Jun 26, 2021 9:00:00 am</div></footer></div></div>
</body></html>`

const messageFile = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'message_1.html',
  ext: 'html',
  text: MESSAGES_FIXTURE,
  ...over
})

describe('Facebook messages recognizer', () => {
  it('detects message_N.html and not other FB sections', () => {
    expect(FACEBOOK_MESSAGES_RECOGNIZER.detect(messageFile())).toBe(true)
    expect(FACEBOOK_MESSAGES_RECOGNIZER.detect(messageFile({ name: 'comments.html' }))).toBe(false)
    expect(R.detect(messageFile())).toBe(false)
  })

  it('aggregates to daily counts per conversation, storing NO message text', () => {
    const out = FACEBOOK_MESSAGES_RECOGNIZER.parse(messageFile())
    expect(out).toHaveLength(2) // 2 messages on Jun 25, 1 on Jun 26
    expect(out[0]).toMatchObject({
      source: 'facebook',
      type: 'messages',
      title: '2 messages with Jane Doe',
      occurredAt: new Date('2021-06-25T00:00:00').getTime() // local midnight
    })
    expect(out[1].title).toBe('1 message with Jane Doe')
    // Privacy: the message bodies never land in any record.
    expect(out.every((r) => r.body === undefined)).toBe(true)
    expect(JSON.stringify(out)).not.toContain('hey there')
  })

  it('strips the trailing self from a "Participants:" thread title', () => {
    const text = MESSAGES_FIXTURE.replace(
      '<title>Jane Doe</title>',
      '<title>Participants: Bob Smith and Christopher D Ennis</title>'
    )
    const out = FACEBOOK_MESSAGES_RECOGNIZER.parse(messageFile({ text }))
    expect(out[0].title).toBe('2 messages with Bob Smith')
  })
})

// Catch-all activity: any FB _a6-g HTML the specific recognizers didn't claim,
// one dated record per block, typed from the filename. (Validated against the
// real archive: reactions, groups, events, searches, security, off-Facebook…)
const ACTIVITY_FIXTURE = `<!doctype html><html><body>
<div class="_a6-g"><div aria-labelledby="a1">
  <h2 class="_2ph_ _a6-h _a6-i">Christopher D Ennis liked a post.</h2>
  <footer class="_3-94 _a6-o"><div class="_a72d">Mar 03, 2014 5:00:00 pm</div></footer>
</div>
<div class="_a6-g"><div aria-labelledby="a2">
  <h2 class="_2ph_ _a6-h _a6-i">Christopher D Ennis liked a comment.</h2>
  <footer class="_3-94 _a6-o"><div class="_a72d">Apr 04, 2015 10:00:00 am</div></footer>
</div>
<div class="_a6-g"><div aria-labelledby="a3">
  <h2 class="_2ph_ _a6-h _a6-i">An undated thing with no date.</h2>
</div>
</body></html>`

const activityFile = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'likes_and_reactions_1.html',
  ext: 'html',
  text: ACTIVITY_FIXTURE,
  ...over
})

describe('Facebook activity catch-all recognizer', () => {
  it('claims any FB _a6-g HTML and ignores non-FB files', () => {
    expect(FACEBOOK_ACTIVITY_RECOGNIZER.detect(activityFile())).toBe(true)
    expect(FACEBOOK_ACTIVITY_RECOGNIZER.detect(activityFile({ text: '<p>not facebook</p>' }))).toBe(
      false
    )
  })

  it('emits one record per DATED block (undated skipped), typed from the filename', () => {
    const out = FACEBOOK_ACTIVITY_RECOGNIZER.parse(activityFile())
    expect(out).toHaveLength(2) // 2 dated, the undated block is skipped
    expect(out[0]).toMatchObject({
      source: 'facebook',
      type: 'reaction', // from the "likes_and_reactions" filename
      title: 'Christopher D Ennis liked a post.',
      occurredAt: new Date(2014, 2, 3, 17, 0, 0).getTime()
    })
  })

  it('derives the kind from the section filename', () => {
    const kind = (name: string): string | undefined =>
      FACEBOOK_ACTIVITY_RECOGNIZER.parse(activityFile({ name }))[0]?.type
    expect(kind('your_group_membership_activity.html')).toBe('group')
    expect(kind('event_invitations.html')).toBe('event')
    expect(kind('your_search_history.html')).toBe('search')
    expect(kind('your_activity_off_meta_technologies.html')).toBe('off-facebook')
    expect(kind('account_activity.html')).toBe('security')
    expect(kind('your_uncategorized_photos.html')).toBe('post')
  })
})
