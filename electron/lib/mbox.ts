/**
 * mbox email-archive parser (Phase 10.4 — "The Acquisition Engine").
 *
 * A Gmail Takeout / IMAP-backup `.mbox` concatenates messages, each starting with
 * a `From ` envelope-separator line. Mailboxes are huge (multi-GB), so — like
 * Apple Health — this is a STREAMING recognizer: it reads line-by-line (constant
 * memory) and emits one timeline record per message from the HEADERS ONLY. Bodies
 * are skipped entirely — the timeline holds email metadata (subject / sender /
 * date), never message content.
 *
 * Zero deps. Hand-rolled header parse (RFC 5322 folding) + a minimal RFC 2047
 * MIME-word decoder so non-ASCII subjects are readable.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { RecordInput } from './recognizers'

// mbox message separator: `From <addr> <asctime-ish date ending in a 4-digit year>`.
// Requiring the trailing year (plus a preceding blank line) avoids splitting on a
// `"From "` that merely opens a body line.
const SEP = /^From \S+ .*\d{4}/
const KEEP = new Set(['date', 'from', 'to', 'subject', 'message-id'])

/** Decode RFC 2047 MIME encoded-words (`=?charset?B|Q?text?=`) to a readable string. */
export function decodeMimeWords(s: string): string {
  return s.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (_full, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf-8')
      const q = text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
          String.fromCharCode(Number.parseInt(h, 16))
        )
      return Buffer.from(q, 'binary').toString('utf-8')
    } catch {
      return text
    }
  })
}

type Headers = Record<string, string>

function emit(h: Headers, out: RecordInput[]): void {
  // Skip envelopes that yielded none of the headers we keep (nothing to show).
  if (!h.date && !h.from && !h.subject && !h['message-id']) return
  const date = h.date ?? ''
  const parsed = Date.parse(date)
  const subject = decodeMimeWords(h.subject ?? '').trim()
  const from = decodeMimeWords(h.from ?? '').trim()
  const messageId = h['message-id']?.trim()
  out.push({
    source: 'email',
    type: 'email',
    occurredAt: Number.isNaN(parsed) ? null : parsed,
    title: subject || '(no subject)',
    body: from || undefined,
    payload: { from, to: h.to, subject, messageId },
    naturalKey: messageId || `${date}|${from}|${subject}`
  })
}

export async function parseMbox(
  path: string,
  lines?: AsyncIterable<string>
): Promise<RecordInput[]> {
  const src: AsyncIterable<string> =
    lines ??
    createInterface({
      input: createReadStream(path, 'utf-8'),
      crlfDelay: Number.POSITIVE_INFINITY
    })

  const out: RecordInput[] = []
  let headers: Headers = {}
  let inHeaders = false
  let started = false
  let prevBlank = true // start-of-file counts as "preceded by a blank line"
  let lastKey: string | null = null // for folded (continuation) header lines

  for await (const line of src) {
    if (prevBlank && SEP.test(line)) {
      if (started) emit(headers, out)
      headers = {}
      inHeaders = true
      started = true
      lastKey = null
      prevBlank = false
      continue
    }

    if (inHeaders) {
      if (line === '') {
        inHeaders = false // headers done — skip the body until the next separator
        lastKey = null
      } else if (lastKey && /^[ \t]/.test(line)) {
        headers[lastKey] += ` ${line.trim()}` // RFC 5322 folded continuation
      } else {
        const idx = line.indexOf(':')
        if (idx > 0) {
          const key = line.slice(0, idx).trim().toLowerCase()
          if (KEEP.has(key)) {
            headers[key] = line.slice(idx + 1).trim()
            lastKey = key
          } else {
            lastKey = null // a header we ignore — don't fold continuations onto it
          }
        }
      }
    }

    prevBlank = line === ''
  }
  if (started) emit(headers, out)
  return out
}
