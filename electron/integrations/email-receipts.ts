/**
 * Email receipts → timeline purchase records (Phase 3, integration long-tail).
 *
 * Reuses the already-connected Google account (`gmail.readonly` scope — the
 * existing Gmail sync only reads metadata; here we read full bodies) to find
 * order/receipt emails, parse merchant + total + date, and project them onto the
 * `records` spine as `source:'email-receipt'`, `type:'order'` rows — searchable
 * in ⌘K, on the Timeline, and rolled up into the Merchants directory (via the
 * `email-receipt-merchant` entity extractor).
 *
 * They are DELIBERATELY not finance transactions: a receipt for a purchase you
 * also sync from a bank/card can't merge with it (the descriptions differ), so
 * inserting both would double-count spend. The bank charge stays the source of
 * truth for totals; the receipt adds searchable merchant/line context.
 *
 * Parsing is conservative — it needs a receipt SIGNAL (subject/body) AND a
 * LABELLED total — and is UNVALIDATED against a large real-email corpus, so a
 * miss simply skips the email (never a bogus record).
 */
import { eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { integrations, syncEvents } from '../db/schema'
import { getValidGoogleToken, hasGoogleScope, loadToken } from '../ipc/auth'
import { insertRecords } from '../ipc/records'
import type { RecordInput } from '../lib/recognizers'

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

const SERVICE = 'email-receipts'
const MAX_MESSAGES = 40

export interface ParsedReceipt {
  merchant: string
  amount: number
  currency: string
  date: string // 'YYYY-MM-DD' (local)
}

// A receipt signal in the subject or top of the body (keeps marketing mail out).
const RECEIPT_SIGNAL =
  /\b(receipt|order confirmation|your order|order #|order number|invoice|payment (?:received|confirmation)|thank(?:s| you) for your (?:order|purchase|payment)|purchase confirmation)\b/i

// A total that is explicitly LABELLED — not just any dollar figure in the email
// (that would catch "$50 off" marketing). Global so we can pick the grand total.
const TOTAL_RE =
  /(?:order total|grand total|total amount|amount (?:charged|paid|due)|you paid|total)\b[^\d$€£]{0,20}(US\$|USD|CA\$|\$|€|£)\s?([\d,]+\.\d{2})/gi

const CURRENCY: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  USD: 'USD',
  CA$: 'CAD',
  '€': 'EUR',
  '£': 'GBP'
}

const KNOWN_MERCHANTS: Record<string, string> = {
  amazon: 'Amazon',
  uber: 'Uber',
  lyft: 'Lyft',
  doordash: 'DoorDash',
  instacart: 'Instacart',
  grubhub: 'Grubhub',
  apple: 'Apple',
  paypal: 'PayPal',
  ebay: 'eBay',
  walmart: 'Walmart',
  target: 'Target',
  etsy: 'Etsy',
  airbnb: 'Airbnb',
  booking: 'Booking.com',
  expedia: 'Expedia',
  starbucks: 'Starbucks',
  bestbuy: 'Best Buy',
  costco: 'Costco',
  chewy: 'Chewy',
  squarespace: 'Squarespace'
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

/** Best-effort merchant from the From header's domain (known map, else the SLD). */
export function merchantFromSender(from: string): string | null {
  const emailMatch = from.match(/<([^>]+@[^>]+)>/) ?? from.match(/([^\s<>]+@[^\s<>]+)/)
  const email = emailMatch?.[1]
  if (!email) return null
  const domain = (email.split('@')[1] ?? '').toLowerCase()
  const parts = domain.split('.').filter(Boolean)
  if (parts.length === 0) return null
  // Second-level label: amazon.com → amazon, email.uber.com → uber.
  const sld = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
  if (!sld || sld.length < 2) return null
  return KNOWN_MERCHANTS[sld] ?? titleCase(sld)
}

/** epoch ms → local 'YYYY-MM-DD'. */
function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Pure: an email → a parsed receipt, or null when it isn't confidently one. */
export function parseReceiptEmail(msg: {
  subject: string
  from: string
  bodyText: string
  receivedAt: number
}): ParsedReceipt | null {
  const signalHay = `${msg.subject}\n${msg.bodyText.slice(0, 800)}`
  if (!RECEIPT_SIGNAL.test(signalHay)) return null
  let best: { amount: number; currency: string } | null = null
  for (const m of msg.bodyText.matchAll(TOTAL_RE)) {
    const amount = Number(m[2].replace(/,/g, ''))
    if (!Number.isFinite(amount) || amount <= 0) continue
    const currency = CURRENCY[m[1].toUpperCase()] ?? CURRENCY[m[1]] ?? 'USD'
    // The grand total is the largest labelled total (subtotal + tax + shipping).
    if (!best || amount > best.amount) best = { amount, currency }
  }
  if (!best) return null
  const merchant = merchantFromSender(msg.from)
  if (!merchant) return null
  return { merchant, amount: best.amount, currency: best.currency, date: ymd(msg.receivedAt) }
}

// ── Gmail body decode ─────────────────────────────────────────────────────────

interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}
interface GmailFull {
  internalDate?: string
  payload?: GmailPart & { headers?: Array<{ name: string; value: string }> }
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Prefer text/plain, fall back to (stripped) text/html, then the root body. */
export function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return ''
  const flat: GmailPart[] = []
  const walk = (p: GmailPart): void => {
    flat.push(p)
    p.parts?.forEach(walk)
  }
  walk(payload)
  const plain = flat.find((p) => p.mimeType === 'text/plain' && p.body?.data)
  if (plain?.body?.data) return decodeB64Url(plain.body.data)
  const html = flat.find((p) => p.mimeType === 'text/html' && p.body?.data)
  if (html?.body?.data) return stripHtml(decodeB64Url(html.body.data))
  if (payload.body?.data) return decodeB64Url(payload.body.data)
  return ''
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

const GMAIL_QUERY =
  'newer_than:180d (category:purchases OR subject:(receipt OR "order confirmation" OR "your order" OR invoice OR "order #"))'

/** Build the spine rows for a batch of Gmail full-message payloads (pure — the
 *  network side is separate so this is unit-testable). */
export function receiptsToRecords(messages: Array<{ id: string; data: GmailFull }>): RecordInput[] {
  const inputs: RecordInput[] = []
  for (const { id, data } of messages) {
    const subject = header(data.payload?.headers, 'Subject')
    const from = header(data.payload?.headers, 'From')
    const dateHeader = header(data.payload?.headers, 'Date')
    const internalMs = Number(data.internalDate)
    const headerMs = dateHeader ? Date.parse(dateHeader) : NaN
    const receivedAt = Number.isFinite(internalMs) ? internalMs : headerMs
    if (!Number.isFinite(receivedAt)) continue
    const bodyText = extractBody(data.payload)
    const receipt = parseReceiptEmail({ subject, from, bodyText, receivedAt })
    if (!receipt) continue
    inputs.push({
      source: 'email-receipt',
      type: 'order',
      occurredAt: new Date(`${receipt.date}T00:00:00`).getTime(),
      title: receipt.merchant,
      // parseMoney (entities.ts) reads the first ' · ' segment → "42.00 USD".
      body: `${receipt.amount.toFixed(2)} ${receipt.currency}${subject ? ` · ${subject.slice(0, 140)}` : ''}`,
      payload: {
        merchant: receipt.merchant,
        amount: receipt.amount,
        currency: receipt.currency,
        subject,
        from
      },
      naturalKey: id
    })
  }
  return inputs
}

function markConnected(recordsUpdated: number): void {
  const db = getDb()
  db.insert(integrations)
    .values({
      service: SERVICE,
      status: 'connected',
      connectedAt: new Date(),
      lastSyncedAt: new Date(),
      errorMessage: null
    })
    .onConflictDoUpdate({
      target: integrations.service,
      set: { status: 'connected', lastSyncedAt: new Date(), errorMessage: null }
    })
    .run()
  const id = db
    .select({ id: integrations.id })
    .from(integrations)
    .where(eq(integrations.service, SERVICE))
    .get()?.id
  if (id != null)
    db.insert(syncEvents).values({ integrationId: id, syncedAt: new Date(), recordsUpdated }).run()
}

function markError(message: string): void {
  const db = getDb()
  db.insert(integrations)
    .values({ service: SERVICE, status: 'error', errorMessage: message })
    .onConflictDoUpdate({
      target: integrations.service,
      set: { status: 'error', errorMessage: message }
    })
    .run()
  const id = db
    .select({ id: integrations.id })
    .from(integrations)
    .where(eq(integrations.service, SERVICE))
    .get()?.id
  if (id != null)
    db.insert(syncEvents)
      .values({ integrationId: id, syncedAt: new Date(), recordsUpdated: 0, errors: message })
      .run()
}

export async function syncEmailReceipts(mainWindow?: BrowserWindow): Promise<SyncResult> {
  const tokens = loadToken('google') as { access_token?: string } | null
  if (!tokens?.access_token) {
    return {
      service: SERVICE,
      success: false,
      error: 'Connect Google first (receipts read your Gmail).'
    }
  }
  try {
    if (!hasGoogleScope('gmail.readonly')) {
      throw new Error('Gmail read permission not granted — reconnect Google.')
    }
    const accessToken = await getValidGoogleToken()
    const headers = { Authorization: `Bearer ${accessToken}` }
    const listResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(GMAIL_QUERY)}&maxResults=${MAX_MESSAGES}`,
      { headers }
    )
    if (!listResp.ok) throw new Error(`Gmail search failed (${listResp.status})`)
    const listData = (await listResp.json()) as { messages?: Array<{ id: string }> }

    const fetched: Array<{ id: string; data: GmailFull }> = []
    for (const m of (listData.messages ?? []).slice(0, MAX_MESSAGES)) {
      const msgResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
        { headers }
      )
      if (!msgResp.ok) continue
      fetched.push({ id: m.id, data: (await msgResp.json()) as GmailFull })
    }

    const { imported } = insertRecords(receiptsToRecords(fetched), 'email-receipts')
    markConnected(imported)
    mainWindow?.webContents.send('sync:update', {
      service: SERVICE,
      status: 'done',
      recordsUpdated: imported
    })
    return { service: SERVICE, success: true, recordsUpdated: imported }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    markError(message)
    mainWindow?.webContents.send('sync:update', {
      service: SERVICE,
      status: 'error',
      error: message
    })
    return { service: SERVICE, success: false, error: message }
  }
}
