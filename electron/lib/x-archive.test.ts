/**
 * Tests for the X / Twitter archive recognizer (Phase 10). The key behavior is
 * stripping the `window.YTD.tweets.partN = ` JS-variable wrapper before parsing,
 * handling both the modern `{ tweet: {…} }` container and a bare row, and
 * skipping rows without an id/text.
 */

import { describe, expect, it } from 'vitest'
import { type RecognizerFile, recognize } from './recognizers'
import { X_TWEETS_RECOGNIZER } from './x-archive'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

const TWEETS = `window.YTD.tweets.part0 = [
  {
    "tweet" : {
      "created_at" : "Wed Feb 15 12:34:56 +0000 2026",
      "id_str" : "1001",
      "full_text" : "Hello world from the archive"
    }
  },
  {
    "tweet" : {
      "created_at" : "Thu Feb 16 08:00:00 +0000 2026",
      "id_str" : "1002",
      "full_text" : "Second tweet"
    }
  }
] ;`

describe('X / Twitter archive recognizer', () => {
  it('strips the JS wrapper and parses tweets', () => {
    const f = file('tweets.js', TWEETS)
    expect(recognize(f)?.id).toBe('x')

    const out = X_TWEETS_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'x',
      type: 'tweet',
      title: 'Hello world from the archive',
      naturalKey: '1001'
    })
    expect(out[0].occurredAt).toBe(Date.parse('Wed Feb 15 12:34:56 +0000 2026'))
  })

  it('handles the singular window.YTD.tweet wrapper and a bare row shape', () => {
    const bare =
      'window.YTD.tweet.part0 = [ { "id_str": "9", "full_text": "bare row", "created_at": "Fri Mar 01 00:00:00 +0000 2026" } ]'
    const out = X_TWEETS_RECOGNIZER.parse(file('tweet.js', bare))
    expect(out).toHaveLength(1)
    expect(out[0].naturalKey).toBe('9')
  })

  it('does not claim a non-X .js file', () => {
    expect(X_TWEETS_RECOGNIZER.detect(file('app.js', 'const x = 1;'))).toBe(false)
  })
})
