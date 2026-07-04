/**
 * X / Twitter archive recognizer (Phase 10 — "The Acquisition Engine").
 *
 * A dropped `tweets.js` (from the official "Download an archive of your data")
 * becomes one timeline record per tweet — your posting history, owned forever.
 *
 * THE GOTCHA: X's archive wraps each JSON payload in a JS variable assignment
 * (`window.YTD.tweets.part0 = [ … ]`) rather than emitting bare JSON, so the
 * assignment prefix must be stripped before `JSON.parse`. The archive spans many
 * `.js` files (tweets / likes / follower / …) in a `data/` folder; the Drop
 * Zone's one-file-at-a-time dispatch handles each independently — this
 * recognizer claims the tweets file.
 *
 * Tweets are public posts, so (unlike private messaging) the full text is kept.
 *
 * FORMAT CAVEAT: based on the documented archive shape (`{ tweet: { created_at,
 * full_text, id_str } }`, older archives use the singular `tweet` container);
 * unvalidated against a fresh real archive. Degrades to "skip the row" rather
 * than throwing if a row's shape drifts.
 */

import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

type TweetFields = { created_at?: string; full_text?: string; text?: string; id_str?: string }
type TweetRow = TweetFields & { tweet?: TweetFields }

/** Strip the `window.YTD.<name>.part<N> = ` assignment prefix (and any trailing
 *  semicolon), returning the bare JSON payload. */
function unwrap(text: string): string {
  return text.replace(/^\s*window\.YTD\.[\w]+\.part\d+\s*=\s*/, '').replace(/;\s*$/, '')
}

function parseTweets(text: string): TweetRow[] {
  try {
    const v = JSON.parse(unwrap(text))
    return Array.isArray(v) ? (v as TweetRow[]) : []
  } catch {
    return []
  }
}

export const X_TWEETS_RECOGNIZER: Recognizer = {
  id: 'x',
  label: 'X / Twitter archive',
  detect: (f) => {
    if (f.ext !== 'js') return false
    return /^\s*window\.YTD\.tweets?\.part\d+\s*=/.test(f.text)
  },
  parse: (f) => {
    const out: RecordInput[] = []
    for (const row of parseTweets(f.text)) {
      const t = row.tweet ?? row
      const id = t.id_str
      const body = t.full_text ?? t.text ?? ''
      if (!id || !body) continue // not a tweet row we can key/display
      const when = parseWhen(t.created_at)
      // Collapse whitespace + trim for a one-line timeline title; keep it whole
      // in payload.
      const title = body.replace(/\s+/g, ' ').trim().slice(0, 240)
      out.push({
        source: 'x',
        type: 'tweet',
        occurredAt: when,
        title,
        payload: t,
        naturalKey: id
      })
    }
    return out
  }
}
