# Storehouse & Timeline

**Routes:** `/storehouse` · `/timeline` · **Sidebar:** Storehouse · Timeline

The Storehouse is Compass's founding promise: *one local place that holds all of your data — owned by you,
never lost if a service shuts down, and exportable at will.* It pairs a set of owned domains (Contacts,
Subscriptions, Assets) with a universal **Drop Zone → Timeline** that turns any data export into one
searchable, append-only life log. Design: [`docs/storehouse-roadmap.md`](https://github.com/sandgraal/compass/blob/main/docs/storehouse-roadmap.md).

## Storehouse overview (`/storehouse`)

A read-only home base with summary tiles — **Contacts** count, **Subscriptions** (annual total + active),
**Assets** (total value, by type) — plus **upcoming renewals** (subscriptions + assets, next 60 days), each
deep-linking to its domain page, the [Export Center](Backup-and-Restore), and the [Vault](Vault). It grows
as more domains land (documents, medical, finance net worth).

The owned domains:

- **Contacts** — a vCard-structured address book; import from CSV / vCard / macOS / LinkedIn / Facebook /
  Google Voice; export as vCard.
- **Subscriptions** — first-class subscriptions (cost, cadence, status, next renewal), distinct from the
  detected recurring charges in [Finance](Finance). Manual entries cover what Compass can't see (cash /
  annual / another card).
- **Assets** — household inventory by type (insurance / vehicle / property / membership / warranty / pet /
  other) with renewal highlighting.

## The Drop Zone → Timeline (`/timeline`)

Drag **any** data export — CSV, JSON, XML, mbox, zip, or a SQLite file — into the Drop Zone. A registry of
**~44 recognizers** (`electron/lib/recognizers.ts`) sniffs each file by name / header / shape and normalizes
it into the unified **`records`** store. Coverage today:

- **Activity & media** — Netflix, Spotify, YouTube, Goodreads, Amazon.
- **Social** — LinkedIn (12 record types), Facebook (posts/friends/comments/messages/…), Google Takeout
  (activity/Chrome/Play/Pay/Calendar/Fit/Voice).
- **Money** — PayPal, Venmo (CSV).
- **Streaming-scale files** — Apple Health `export.xml`, email archives (`.mbox`).
- **Local databases** — browser history (Chrome / Safari / Firefox), iMessage `chat.db`.
- **PDFs** — credit report, tax documents, Social Security statement, generic letters (a content-light index
  — the sensitive source text is never stored).

Every record carries `source + type + occurredAt + payload` and a content-addressed `hash`, so re-importing
the same export is idempotent (no double-counting).

### Searching the Timeline

- **Full-text** — a `records_fts` (FTS5) index over title/body/payload, bm25-ranked.
- **By meaning** — an opt-in local **semantic** index (`records-embeddings.json`, via Ollama) with a
  transparent FTS fallback when there's no index. Toggle it on the Timeline.
- **Curate** — high-volume/low-signal sources (browser history) are tagged a **firehose** and collapsed by
  default ("Show browsing (N hidden)"). **Nothing is deleted** — tag & filter, keep everything.
- **On this day** — a Dashboard card surfaces records from prior years sharing today's date.

> **Privacy:** the Timeline is the **one deliberate, user-opted-in** relaxation of the aggregates-only
> assistant boundary — `compass_search_timeline` / `search_records` can return matching records (capped,
> char-budgeted, payload never returned). The vault and raw finance stay aggregates-only. See
> [Security & Privacy](Security-and-Privacy).

## Related

- [People](People) — the cross-source directory derived from these records.
- [Data Rights & Acquisition](Data-Rights-and-Acquisition) — how to *get* the exports you drop here.
- [Backup & Restore](Backup-and-Restore) — the Universal Export Center.
