# Storehouse Roadmap — The Acquisition Engine (Phase 10)

> **Status:** strategy + roadmap (no code yet). Directional accuracy is the bar; per-source legal/API
> specifics are marked *(verify at build time)* and resolved when each wave is greenlit.
>
> **Where this sits:** [Phase 9](implementation_plan.md) ("The Storehouse") built the *ingest → own →
> export* **spine** across domains you put in or import from a file (contacts, subscriptions, assets,
> documents, medical, plus the Universal Export Center). This doc is the **next horizon**: going *out* to
> **acquire everything you have a legal right to** — credit reports, health records, tax/earnings history,
> the big platform takeouts — and turning it into one queryable, life-long, owned timeline. It reuses
> Phase 9's spine verbatim and adds the acquisition + leverage layers on top.

---

## 1. North Star

> *"Go out and get all of your info for yourself, keep it yourself without fear of losing it, then leverage
> all of that info yourself in elegant, useful, life-changing ways."*

Three principles, in order:

1. **Acquire** — everything you have a right to, not just what happens to have a friendly API. APIs hand
   back a *recent window*; your *whole history* lives in bulk exports and data-rights requests.
2. **Keep** — local and exportable forever. Every new source must flow into the Universal Export Center
   (Phase 9.0) so a dead service never costs you your data. The vault is *never* exported in plaintext.
3. **Leverage** — across sources. The payoff is a unified life **timeline** and an assistant that can reason
   over your whole life — sleep vs. spending, "on this day," net-worth + health + productivity together.

---

## 2. The reframe — from "integrations" to an acquisition engine

Compass today ingests with **one integration per service** (`auth → sync → DB upsert → knowledge extractor
→ Ask Compass`). It works — Google, GitHub, SimpleFIN, Plaid, Apple Calendar, Linear, Todoist, Obsidian,
Things 3, Contacts — but it scales *linearly* and only reaches services with APIs.

The unlock is recognizing there are **four ingestion modes**, and today's product only does the first:

| Mode | What it is | Best for | Examples |
|---|---|---|---|
| **LIVE** | OAuth / API / bridge sync (today's pattern) | ongoing streams | Google, SimpleFIN, Plaid, GitHub, Linear |
| **EXPORT** | a bulk archive *you* download (GDPR/CCPA "download my data") | your *entire history* — the "old shit" | Google Takeout, Apple Health, Meta, Spotify |
| **RIGHTS** | a disclosure you're legally owed → request → track → ingest | sources with no self-serve button | credit reports (FCRA), IRS/SSA, FHIR/Blue Button, data-broker files |
| **CRED** | Compass logs into a portal *as you* and pulls/scrapes | sources with none of the above | brokerage portals, payroll, county records, USPS |

**CRED is not a new philosophy — it's the SimpleFIN decision generalized.** Compass already chose SimpleFIN
as the *recommended* bank sync precisely because *"the user (not the developer) owns the data
relationship"* ([architecture.md](architecture.md), `simplefin_connections`). CRED says: where no export or
standard exists, *you* run the aggregator — locally, for yourself, with credentials that never leave your
machine. Prefer EXPORT/RIGHTS/LIVE wherever a source offers them; fall to CRED only when nothing else exists.

---

## 3. Architecture — ~6 generic primitives (don't build 200 integrations)

Each primitive reuses existing Compass machinery rather than inventing new patterns.

### A. The Drop Zone — universal archive import
One place to drag **any** export archive (ZIP/JSON/CSV/XML/mbox/PDF). A **format-recognizer registry**
sniffs an archive's shape (filenames, top-level JSON keys, manifest) and routes it to the right codec →
normalize → store. Generalizes the codecs Phase 9 already ships: `electron/lib/vcard.ts`, `ics.ts`,
shared `csv.ts`, and `electron/lib/archive-importers.ts` (LinkedIn / Facebook / Google-Voice Takeout
parsers), plus the finance CSV/PDF importers (`electron/integrations/finance.ts`, `finance-pdf.ts`).
**Highest-leverage feature on the list** — one surface unlocks dozens of sources and captures full history.

### B. The unified `records` / timeline store
Today every source has its own table (`calendar_events`, `finance_transactions`, `linear_issues`, …). For
the long tail, add **one append-only typed event log**:
`records { id, source, type, occurredAt, payload (JSON), dedupHash UNIQUE, provenance }` — plus typed
projections for the heavy hitters. This is what makes cross-source leverage possible: "watched X," "ran 5k,"
"bought Y," "lab result Z," "entered the country on D" all share a spine and a timeline. Dedup mirrors the
proven `finance_transactions.hash` UNIQUE idempotency. Next migration is `0016` (assets took `0014`, SimpleFIN took `0015`).

### C. The Data-Rights Concierge
For RIGHTS sources, a guided **request → track → ingest** workflow that knows each mechanism
(AnnualCreditReport.com, IRS Individual Online Account, SSA, LexisNexis full-file disclosure, MyChart/FHIR,
CBP I-94). It generates the request, records "requested 2026-06-14, expect ~15 days," and reminds you to
ingest the result — reusing the **Morning Brief / notification scheduler** already in the app. This is the
literal "go *out* and *get* your data" half of the vision.

### D. The Portal Automation Sandbox (the CRED engine)
An **isolated, opt-in** automation surface that extends the **Plaid Link child-window bridge** pattern
(`electron/integrations/plaid/link.ts`): a sandboxed `BrowserWindow` (or headless Playwright) logs into a
portal using credentials from the vault, navigates, downloads the export (or scrapes the page), and hands
the artifact to the Drop Zone (A). **Assisted-login** mode surfaces the window so *you* complete MFA/2FA.
Security model in §5. This is the riskiest, most powerful primitive — built last, after the clean paths.
**Full design:** [`cred-engine-design.md`](cred-engine-design.md) (threat model, the assisted-vs-stored modes, first-portal choice, phased build).

### E. Live-sync connectors
Keep the existing `add-integration` pattern ([integrations.md](integrations.md)) for high-value ongoing
streams (wearables, brokerage aggregation, Spotify). Main-process-only API calls where possible — the way
Linear/Todoist sync without widening the renderer CSP.

### F. The leverage layer
- **Unified Timeline** view — everything, filterable by source/type/date. (Ships incrementally from 10.1.)
- **Ask-Compass-over-everything** — extend the Phase 5.9 semantic index (`.data/knowledge-embeddings.json`)
  and the Phase 8.5 agent tools to the new record types. Stays within the invariant: the assistant reasons
  over **derived knowledge markdown + summaries**, never raw vault rows (§5).
- **Insights engine** — extends the Morning Brief: "on this day," anomaly/correlation surfacing
  (sleep vs. spending), combined net-worth + health + productivity dashboards.
- **Universal Export** (Phase 9.0) — the durable backstop; every new source registers with it.

---

## 4. The data-source catalog

The menu of what "all your info" actually spans, by domain. **Method** tags: LIVE / EXPORT / RIGHTS / CRED /
FILE. *(All third-party specifics — free cadences, API availability — verify at build time.)*

### 4a. Financial & credit
| Source | What you get | Method(s) | Notes / guardrails |
|---|---|---|---|
| Banks & cards | transactions, balances | LIVE ✅ (SimpleFIN/Plaid), FILE (CSV) | **shipped** |
| Brokerage / retirement | holdings, positions, cost basis | LIVE (SnapTrade or Plaid Investments), FILE (1099-B / broker CSV) | completes net worth beyond manual `assets` |
| **Credit reports** | tradelines, inquiries, collections, score | RIGHTS (AnnualCreditReport.com — FCRA), CRED (bureau portals), EXPORT (Credit Karma) | parse the 3-bureau PDF/HTML; secrets → vault |
| Tax | account / wage / return transcripts; prior returns | RIGHTS/CRED (IRS Online Account), FILE (`.tax` / PDF) | wage transcript backstops missing W-2/1099 |
| Income / payroll | pay stubs, W-2/1099 | FILE, CRED (Gusto/ADP), RIGHTS (IRS wage transcript) | |
| Crypto | balances, trades, on-chain history | LIVE (exchange API / on-chain by address), FILE (CSV), EXPORT (CoinTracker/Koinly) | |
| Real estate / property | value, tax, deed | RIGHTS/CRED (county assessor & recorder), LIVE (Zestimate — ToS-gray) | |
| Loans / mortgage / student | balances, amortization | CRED (servicer portals), FILE (statements) | feeds Phase 4.5 forecast |

### 4b. Health & medical → feeds Phase 9.4 `medical_*` tables
| Source | What you get | Method(s) | Notes / guardrails |
|---|---|---|---|
| **Apple Health** | steps, HR, sleep, workouts, cycle… | FILE/EXPORT (`export.xml` from iPhone) | huge file → selective import; easy first win |
| **Medical records** | conditions, meds, encounters, labs | RIGHTS/LIVE (SMART-on-FHIR patient access, 21st-Cures-Act; Epic/MyChart, Cerner), FILE (C-CDA) | evaluate self-hosted **Fasten Health** as a local FHIR aggregator |
| Lab results | values + ranges | LIVE (FHIR), CRED/FILE (Quest/LabCorp) | |
| Insurance claims / EOBs | claims, costs | CRED (payer portal), RIGHTS/LIVE (Medicare Blue Button 2.0) | |
| Prescriptions | fill history | LIVE (FHIR meds), CRED (pharmacy) | |
| **Genetics** | raw genotype | EXPORT/FILE (23andMe / AncestryDNA download) | sensitive → encrypt at rest |
| Wearables | recovery, strain, sleep | LIVE (Oura, Whoop, Garmin, Fitbit/Google), EXPORT (Strava) | |

### 4c. Digital footprint & communications
| Source | What you get | Method(s) | Notes / guardrails |
|---|---|---|---|
| **Google Takeout** | mail (mbox), Location Timeline, search & activity, YouTube, Photos metadata, Maps, Keep, Fit | EXPORT | *the motherlode* — phase the parsers |
| Apple Data & Privacy | iCloud, purchases, media, App Store | EXPORT | |
| Meta (FB + IG) | posts, messages, photos, ad-interest profile, logins | EXPORT | reuses `archive-importers.ts` FB parser |
| X / LinkedIn | archive, connections, messages, positions | EXPORT | LinkedIn already parsed (Phase 9.1) |
| Amazon | orders, browsing, Alexa voice, Kindle | EXPORT ("Request My Data"), FILE (order report) | |
| Media history | Spotify (extended streaming), Netflix, Goodreads/StoryGraph, Letterboxd, Steam | EXPORT, LIVE | "your taste, quantified" |
| Browser | history + bookmarks | FILE (local SQLite — Chrome/Safari/Firefox) | |
| Highlights / read-later | Readwise, Pocket, Instapaper | LIVE/EXPORT | feeds the knowledge base directly |
| Email archive | full mailbox | EXPORT (Gmail mbox via Takeout), CRED (IMAP backup) | |
| **iMessage / SMS** | full message history | FILE (local `chat.db`), FILE (Android backup) | local-only read |
| WhatsApp / Signal / Telegram | chat export | EXPORT/FILE | |

### 4d. Government & official records
| Source | What you get | Method(s) | Notes / guardrails |
|---|---|---|---|
| **IRS** | account / wage / return transcripts | RIGHTS/CRED (Individual Online Account) | overlaps 4a |
| **SSA** | lifetime earnings record + benefit estimate | RIGHTS/CRED (my Social Security) | |
| Property / deed / assessor | ownership, tax, valuation | RIGHTS/CRED (county records) | |
| Court records | filings | CRED (PACER federal; state portals) | |
| Travel history | entry/exit dates, I-94 | RIGHTS (CBP), CRED (Global Entry / TSA) | |
| Voter / DMV / vehicle | registration, title | RIGHTS/CRED (state portals) | |
| USPS Informed Delivery | scanned mail-piece images | LIVE/CRED | |
| **Data brokers** | your full file — "what's on record about you" | RIGHTS (LexisNexis full-file FCRA disclosure incl. LexID, Acxiom, Spokeo, Oracle) + opt-out | the eye-opener layer |
| Vital / immigration | birth/marriage, USCIS, passport | FILE/RIGHTS | mostly manual |

---

## 5. Security & guardrails

Every item below is non-negotiable and consistent with [architecture.md](architecture.md).

- **Local-first preserved.** Every source lands on disk. CSP `connect-src` is extended **per source**, no
  wildcards; prefer **main-process-only** API calls (like Linear/Todoist) so the renderer CSP never widens.
- **Credential handling (CRED).** New vault category `portal-credentials`. Credentials **never cross IPC to
  the renderer, never appear in logs** (the SimpleFIN/Plaid rule: the Access URL / token lives only in
  `.vault/*.enc`). Automation runs in the **main process / an isolated sandboxed `BrowserWindow`**. **Per
  source opt-in.** Runs only on user trigger or an explicit schedule. **Assisted-login** surfaces the window
  for MFA/2FA. Every fetched artifact passes through the same validated ingest as a manual file drop.
- **Honest ToS / robustness posture.** Scraping is brittle and ToS-gray. The product states this plainly,
  prefers EXPORT/RIGHTS/LIVE, and treats CRED as the fallback of last resort. A short legal/ToS note ships
  with the CRED wave.
- **Leverage vs. privacy invariant.** Raw records stay local. The assistant + MCP see **derived knowledge
  markdown and summaries — never raw vault rows or raw finance/health rows** (the existing rule:
  `mcp/compass-mcp` opens the DB `readonly` with the vault and raw finance excluded; the agent has read +
  `propose_task` only). **Exception (Phase 10.7 "Converse", user-opted-in):** the `records` timeline is
  searchable in detail via `search_records` / `compass_search_timeline` (capped, char-budgeted, payload
  never returned) — scoped to `records` only; vault + raw finance stay aggregates-only. Any new agent tool
  is reviewed against this.
- **Export excludes the vault.** The Universal Export Center stays plaintext-portable but **deliberately
  vault-free** (`export:export-all` reads no `VAULT_DIR`). Encrypted backup (`backup.ts`) remains the only
  path that includes secrets, passphrase-wrapped.
- **Provenance & dedup.** Every record carries `source + method + occurredAt + dedupHash`.
- **Scale.** Apple Health XML, Google Takeout, and Photos archives are large — design for *selective*
  import, store originals in an attachments area (the Phase 9.2 `documents`/`.data/documents/` mechanism),
  and index metadata, not blobs.

---

## 6. Wave roadmap (Phase 10)

Builds on Phase 9's shipped spine; **does not renumber 9.x**. Each wave is its own PR(s) with tests + a
`security-auditor` pass on any new credential or export path — the Phase 9 cadence.

- [ ] **10.1 The acquisition spine** — the **Drop Zone** (universal archive import + format-recognizer
  registry) + the unified **`records`/timeline store** (migration `0016`) + a basic **Timeline** view.
  Seed recognizers: a Google Takeout subset, Apple Health `export.xml`, and one credit-report PDF.
  *Everything else hangs off this — build first.*
- [ ] **10.2 Financial & credit completeness** — credit reports (RIGHTS), brokerage/retirement
  (SnapTrade or Plaid Investments), IRS/tax transcripts, crypto. Extends Phase 4 net worth + forecast.
- [ ] **10.3 Health & medical** — Apple Health (FILE) → FHIR/Blue Button (evaluate Fasten Health) →
  genetics → wearables. Feeds the Phase 9.4 `medical_*` tables.
- [ ] **10.4 Digital footprint & comms** — the big takeouts (Google/Meta/X/LinkedIn/Amazon/Spotify) +
  browser history + iMessage + email archive. Heavy reuse of `archive-importers.ts`.
- [ ] **10.5 Government & official + Data-Rights Concierge** — SSA, IRS, property/court/travel, data-broker
  disclosures, and the request → track → ingest workflow (primitive C).
- [ ] **10.6 Credential-Based Aggregation Engine** — the Portal Automation Sandbox (primitive D). Opt-in,
  vault-backed, isolated. Cross-cutting (unlocks no-export sources across every domain) and riskiest →
  **last**, after the clean paths exist.
- [ ] **10.7 Advanced leverage** — rich unified timeline, the cross-source insights/correlation engine,
  Ask-Compass-over-everything, combined dashboards. *(Basic timeline + Ask-over-it ship incrementally from
  10.1 — each wave must be immediately leverageable, not deferred to the end.)*

> **Build order:** 10.1 (spine) → 10.2 / 10.3 / 10.4 (independent, parallelizable, each reuses the spine) →
> 10.5 → 10.6 (cross-cutting, gated) → 10.7 (leverage, but delivered incrementally throughout).

---

## 7. Open decisions (resolve when each wave is greenlit)

- **`records` schema shape** — single polymorphic table vs. per-type tables vs. hybrid (polymorphic log +
  typed projections for heavy hitters).
- **FHIR strategy** — adopt the open-source self-hosted **Fasten Health** aggregator vs. build a native
  SMART-on-FHIR client.
- **CRED automation framework** — sandboxed Electron `BrowserWindow` automation vs. bundled Playwright;
  the MFA / assisted-login UX.
- **Large media** — index metadata only, or copy originals into the `documents` attachments store?
- **Legal/ToS posture note** for the CRED wave (scraping disclosure, per-source preference order).

---

## 8. See also
- [`implementation_plan.md`](implementation_plan.md) — Phase 9 (the spine this extends) + the Phase 10 checklist
- [`architecture.md`](architecture.md) — process boundary, vault, MCP boundary, CSP (the invariants §5 enforces)
- [`integrations.md`](integrations.md) — the LIVE-connector `add-integration` pattern (primitive E)
- [`knowledge-extractor.md`](knowledge-extractor.md) — how ingested data becomes queryable knowledge
