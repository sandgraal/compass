import { describe, expect, it } from 'vitest'
import {
  FACEBOOK_ACTIVITY_RECOGNIZER,
  FACEBOOK_AD_PROFILE_RECOGNIZER,
  FACEBOOK_APPS_RECOGNIZER,
  FACEBOOK_COMMENTS_RECOGNIZER,
  FACEBOOK_FRIENDS_RECOGNIZER,
  FACEBOOK_MESSAGES_RECOGNIZER,
  FACEBOOK_PROFILE_RECOGNIZER,
  FACEBOOK_TABLE_RECOGNIZER,
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
    // 'liked_pages' contains "like" but must classify as a page, not a reaction.
    expect(kind('liked_pages.html')).toBe('page')
  })
})

// Mirrors the table-format FB sections (logins/devices/marketplace/…): each record
// is a `<table>` of key/value rows — two-cell `Label | value` rows and single
// colspan cells of `Label<div>value</div>`. The timestamp lives in a `<td>`, NOT in
// an `_a6-g` footer; that is what separates these from the activity blocks.
const TABLE_FIXTURE = `<!doctype html><html><body>
<div class="_a6-g"><table style="table-layout: fixed;">
  <tr><td class="_a6_q">Created</td><td class="_2piu _a6_r">Feb 04, 2026 10:48:26 am</td></tr>
  <tr><td colspan="2" class="_a6_q">Location details<div>The Crossings, FL, United States</div></td></tr>
  <tr><td colspan="2" class="_a6_q">IP address<div>94.140.11.152</div></td></tr>
  <tr><td colspan="2" class="_a6_q">Session type<div>Desktop</div></td></tr>
</table></div>
<div class="_a6-g"><table style="table-layout: fixed;">
  <tr><td class="_a6_q">Created</td><td class="_2piu _a6_r">Apr 10, 2026 9:14:41 am</td></tr>
  <tr><td colspan="2" class="_a6_q">Location details<div>Cartago, Costa Rica</div></td></tr>
</table></div>
<div class="_a6-g"><table style="table-layout: fixed;">
  <tr><td class="_a6_q">Is opted out of ads about Meta</td><td class="_2piu _a6_r">False</td></tr>
</table></div>
</body></html>`

const tableFile = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: "where_you're_logged_in.html",
  ext: 'html',
  text: TABLE_FIXTURE,
  ...over
})

describe('Facebook table recognizer', () => {
  it('detects a `<td>`-dated table file, but NOT activity-footer files', () => {
    expect(FACEBOOK_TABLE_RECOGNIZER.detect(tableFile())).toBe(true)
    // The activity fixture dates its blocks in `_a6-g` footers, not `<td>` cells.
    expect(FACEBOOK_TABLE_RECOGNIZER.detect(activityFile())).toBe(false)
    expect(FACEBOOK_TABLE_RECOGNIZER.detect(tableFile({ text: '<p>not facebook</p>' }))).toBe(false)
    // A non-FB HTML table with a `<td>` date must NOT be claimed — the detect also
    // requires a Facebook marker (DYI / `_a6-g` / `_a6_` cell class).
    expect(
      FACEBOOK_TABLE_RECOGNIZER.detect(
        tableFile({ text: '<table><tr><td>Feb 04, 2026 10:48:26 am</td></tr></table>' })
      )
    ).toBe(false)
  })

  it('emits one record per DATED table (undated config table skipped)', () => {
    const out = FACEBOOK_TABLE_RECOGNIZER.parse(tableFile())
    expect(out).toHaveLength(2) // the 3rd table (a boolean setting, no date) is skipped
    expect(out[0]).toMatchObject({
      source: 'facebook',
      type: 'security', // "where_you're_logged_in" → security
      title: 'The Crossings, FL, United States', // salient location field, not the date
      occurredAt: new Date(2026, 1, 4, 10, 48, 26).getTime()
    })
    // Every field is preserved in the body.
    expect(out[0].body).toContain('IP address: 94.140.11.152')
    expect(out[0].body).toContain('Session type: Desktop')
    expect(out[1].title).toBe('Cartago, Costa Rica')
  })

  it('types marketplace conversations from the filename despite the "had_a" trap', () => {
    // "had_a_buyer" embeds "ad_a" — the off-Facebook matcher must not claim it.
    const out = FACEBOOK_TABLE_RECOGNIZER.parse(
      tableFile({ name: 'conversations_you_had_as_a_buyer.html' })
    )
    expect(out[0]?.type).toBe('marketplace')
  })

  it('falls back to a humanized filename when no field is title-worthy', () => {
    const text = `<div class="_a6-g"><table>
      <tr><td>Update time</td><td>May 04, 2021 6:45:33 am</td></tr>
      <tr><td>Product title</td><td>Empty</td></tr>
    </table></div>`
    const out = FACEBOOK_TABLE_RECOGNIZER.parse(tableFile({ name: 'record_details.html', text }))
    // "Empty"/date-only rows yield no salient value → humanized filename.
    expect(out[0]?.title).toBe('Record details')
  })
})

// The ad-profile snapshot files: a single table of `_a6-p` list items — the
// advertisers that uploaded/used your info, and the targeting categories Meta
// inferred. (Validated against the real export: 3008 advertisers + 26 categories.)
const AD_PROFILE_FIXTURE = `<!doctype html><html><body>
<table class="_a6_q"><tr><td><div class="_2pin _a6-p">Acme Corp</div></td></tr>
<tr><td><div class="_2pin _a6-p">A list uploaded or used by the advertiser Globex</div></td></tr>
<tr><td><div class="_2pin _a6-p">Initech</div></td></tr></table>
</body></html>`

const adProfileFile = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'advertisers_using_your_activity_or_information.html',
  ext: 'html',
  text: AD_PROFILE_FIXTURE,
  ...over
})

describe('Facebook ad-profile snapshot recognizer', () => {
  it('detects the advertiser/category files, not arbitrary FB HTML', () => {
    expect(FACEBOOK_AD_PROFILE_RECOGNIZER.detect(adProfileFile())).toBe(true)
    expect(
      FACEBOOK_AD_PROFILE_RECOGNIZER.detect(
        adProfileFile({ name: 'other_categories_used_to_reach_you.html' })
      )
    ).toBe(true)
    // A different FB section (e.g. posts) must not be claimed as ad-profile.
    expect(
      FACEBOOK_AD_PROFILE_RECOGNIZER.detect(adProfileFile({ name: 'your_posts__1.html' }))
    ).toBe(false)
  })

  it('emits one ad-profile fact per list item, labeled Advertiser', () => {
    const out = FACEBOOK_AD_PROFILE_RECOGNIZER.parse(adProfileFile())
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({
      source: 'facebook',
      category: 'ad-profile',
      label: 'Advertiser',
      value: 'Acme Corp',
      position: 0
    })
    expect(out[2].position).toBe(2)
    expect(out.map((f) => f.naturalKey)).toEqual([
      'Advertiser|Acme Corp',
      'Advertiser|A list uploaded or used by the advertiser Globex',
      'Advertiser|Initech'
    ])
  })

  it('labels the categories file Category', () => {
    const out = FACEBOOK_AD_PROFILE_RECOGNIZER.parse(
      adProfileFile({ name: 'other_categories_used_to_reach_you.html' })
    )
    expect(out[0].label).toBe('Category')
  })
})

// Profile identity is a `<th>Label</th><td>value</td>` table (Name/Emails/Birthday…),
// with `<li>` lists for Emails/Phones. (Validated against the real export: 9 fields.)
const PROFILE_FIXTURE = `<!doctype html><html><body>
<table class="_a6_q">
  <tr><th>Name</th><td>Christopher D Ennis</td></tr>
  <tr><th>Emails</th><td><ul><li>a@example.com</li><li>  </li><li>b@example.com</li></ul></td></tr>
  <tr><th>Birthday</th><td>Mar 21, 1973</td></tr>
  <tr><th>Gender</th><td></td></tr>
</table></body></html>`

const profileFile = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'profile_information.html',
  ext: 'html',
  text: PROFILE_FIXTURE,
  ...over
})

describe('Facebook profile-identity snapshot recognizer', () => {
  it('detects profile_information.html, not other FB HTML', () => {
    expect(FACEBOOK_PROFILE_RECOGNIZER.detect(profileFile())).toBe(true)
    expect(FACEBOOK_PROFILE_RECOGNIZER.detect(profileFile({ name: 'your_posts__1.html' }))).toBe(
      false
    )
  })

  it('emits a profile fact per row, flattening <li> lists and skipping empty values', () => {
    const out = FACEBOOK_PROFILE_RECOGNIZER.parse(profileFile())
    expect(out).toHaveLength(3) // the empty "Gender" row is skipped
    expect(out[0]).toMatchObject({
      source: 'facebook',
      category: 'profile',
      label: 'Name',
      value: 'Christopher D Ennis',
      position: 0
    })
    // Emails/Phones <ul><li> lists are joined with "; "; the empty <li> is dropped.
    expect(out[1]).toMatchObject({ label: 'Emails', value: 'a@example.com; b@example.com' })
    expect(out[2].label).toBe('Birthday')
  })
})

// Apps & websites: two `<td>`-keyed tables — "App Name" rows in the connected file,
// "Apps blocked from accessing your data" rows in the permissions file. (Validated
// against the real export: 14 connected + 10 blocked.)
const APPS_FIXTURE = `<!doctype html><html><body>
<table class="_a6_q"><tr><td>App Name</td><td>McDonald&#039;s</td></tr>
<tr><td>Unique ID</td><td>123</td></tr>
<tr><td>Date Added</td><td>Jul 09, 2023 11:48:45 am</td></tr></table>
<table class="_a6_q"><tr><td>App Name</td><td>Spotify</td></tr></table>
</body></html>`
const PERMS_FIXTURE = `<!doctype html><html><body>
<table class="_a6_q"><tr><td>Created time</td><td>Jan 14, 2009 7:18:27 pm</td></tr>
<tr><td>Apps blocked from accessing your data</td><td>Buggle</td></tr>
<tr><td>Apps blocked from accessing your data</td><td>Candy Planet</td></tr></table>
</body></html>`

const appsFile = (over: Partial<RecognizerFile> = {}): RecognizerFile => ({
  name: 'connected_apps_and_websites.html',
  ext: 'html',
  text: APPS_FIXTURE,
  ...over
})

describe('Facebook apps & websites snapshot recognizer', () => {
  it('detects the connected-apps and permissions files only', () => {
    expect(FACEBOOK_APPS_RECOGNIZER.detect(appsFile())).toBe(true)
    expect(
      FACEBOOK_APPS_RECOGNIZER.detect(
        appsFile({ name: 'permissions_you_have_granted_to_apps.html' })
      )
    ).toBe(true)
    expect(FACEBOOK_APPS_RECOGNIZER.detect(appsFile({ name: 'your_posts__1.html' }))).toBe(false)
  })

  it('parses connected apps from "App Name" rows, decoding entities', () => {
    const out = FACEBOOK_APPS_RECOGNIZER.parse(appsFile())
    expect(out).toHaveLength(2) // App Name rows only — Unique ID / Date Added ignored
    expect(out[0]).toMatchObject({
      source: 'facebook',
      category: 'apps',
      label: 'Connected app',
      value: "McDonald's", // &#039; decoded
      position: 0
    })
    expect(out[1].value).toBe('Spotify')
  })

  it('parses blocked apps from the permissions file', () => {
    const out = FACEBOOK_APPS_RECOGNIZER.parse(
      appsFile({ name: 'permissions_you_have_granted_to_apps.html', text: PERMS_FIXTURE })
    )
    // The "Created time" row is not a blocked-app row → skipped.
    expect(out).toHaveLength(2)
    expect(out.every((f) => f.label === 'Blocked app')).toBe(true)
    expect(out.map((f) => f.value)).toEqual(['Buggle', 'Candy Planet'])
  })
})
