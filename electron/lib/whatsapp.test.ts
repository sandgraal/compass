/**
 * Tests for the WhatsApp chat-export recognizer (Phase 10). Covers the iOS +
 * Android line formats, content-free per-day aggregation, the chat name from the
 * filename, and that it claims a WhatsApp .txt ahead of the generic catch-all.
 */

import { describe, expect, it } from 'vitest'
import { type RecognizerFile, recognize } from './recognizers'
import { WHATSAPP_RECOGNIZER } from './whatsapp'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

const IOS = [
  '[2/15/26, 12:34:56 PM] Alice: Hey there',
  '[2/15/26, 12:35:10 PM] Me: Hi!',
  'this is a continuation line with no timestamp',
  '[2/16/26, 9:00:00 AM] Alice: Morning'
].join('\n')

const ANDROID = [
  '2/15/26, 12:34 PM - Alice: Hey there',
  '2/15/26, 12:35 PM - Me: Hi!',
  '2/16/26, 9:00 AM - Alice: Morning'
].join('\n')

describe('WhatsApp recognizer', () => {
  it('aggregates the iOS format per day, content-free', () => {
    const f = file('WhatsApp Chat with Alice.txt', IOS)
    expect(recognize(f)?.id).toBe('whatsapp')

    const out = WHATSAPP_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2) // two distinct days
    expect(out.every((r) => r.source === 'whatsapp' && r.type === 'messages')).toBe(true)

    // 2/15 had two timestamped lines (Alice + Me); the continuation line is skipped.
    const day15 = out.find((r) => r.title === '2 messages with Alice')
    expect(day15).toBeDefined()
    expect(out.find((r) => r.title === '1 message with Alice')).toBeDefined() // 2/16
    // No message text anywhere in the output (privacy posture).
    expect(JSON.stringify(out)).not.toContain('Hey there')
  })

  it('handles the Android dash format and derives the chat from the filename', () => {
    const f = file('WhatsApp Chat with Bob.txt', ANDROID)
    const out = WHATSAPP_RECOGNIZER.parse(f)
    expect(out.every((r) => r.title.includes('with Bob'))).toBe(true)
  })

  it('detects by content even without "whatsapp" in the filename', () => {
    expect(WHATSAPP_RECOGNIZER.detect(file('_chat.txt', IOS))).toBe(true)
  })

  it('does not claim an unrelated .txt', () => {
    expect(
      WHATSAPP_RECOGNIZER.detect(file('notes.txt', 'just some free text\nno timestamps here'))
    ).toBe(false)
  })
})
