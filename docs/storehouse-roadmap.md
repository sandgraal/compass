# Storehouse Roadmap — The Acquisition Engine (Phase 10)

> **Status (v0.16.0):** the spine + first waves **shipped.** The Drop Zone, the `records`/Timeline store
> (migration `0016`), **~44 recognizers** (`electron/lib/recognizers.ts`), the Data-Rights Concierge
> (`src/lib/data-rights.ts`, 16 sources), and the CRED sandbox (`electron/integrations/cred/`, SSA adapter,
> gated off by default) are live — see [`implementation_plan.md`](implementation_plan.md) § Phase 10 for
> per-wave status and §6 below. This doc remains the strategy + source catalog; per-source legal/API
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
- **Habit auto-link** *(✅ shipped 2026-07-03)* — life-logging streams (wearables first, eventually
  Strava/Spotify per §4b) can opt a Habit into auto-fill via an explicit per-habit threshold
  (`habits.autoLinkSource` / `autoLinkThreshold`) — the same "pre-populated but user-editable" trust
  model as the Todoist/Things daily-checklist imports. This is the first concrete fix for the
  "Habits/Goals/Travel/Rental Comps are isolated from the `records`/`derived_entities` spine" gap;
  Goals/Travel/Rental Comps are candidates for the same pattern once a source warrants it.
- **Universal Export** (Phase 9.0) — the durable backstop; every new source registers with it.

### G. The metered aggregator relay *(new — the paid-breadth primitive, wave 10.9)*
The **aggregator-of-aggregators** move: one paid aggregator integration = *hundreds* of underlying sources
(Terra = 500+ wearables, Nylas = 250+ mail providers, SnapTrade = every major brokerage, Canopy = 300+ P&C
insurers, Argyle = ~80% of US payrolls, Arcadia = 125+ utilities). Compass already proved the pattern with
Plaid (banks) and SimpleFIN. But these aggregators require a **paid developer account** the end-user can't
self-serve, so — per the "pay for it, don't get abused" decision (§7) — Compass fronts them with a **thin,
stateless relay**:
- **Stateless pass-through** — the relay forwards the aggregator's response to the local client and **stores no
  user data**; every source still lands on the user's disk. It is *not* a new data custodian, only a meter.
- **Keys server-side** — the paid Terra/Nylas/Canopy/Argyle keys live only in the relay, never shipped to
  clients (that's the whole point — users skip the impossible-to-get dev account).
- **Metered + abuse-capped** — a device-bound license token is the quota key; per-user caps (accounts, syncs/day,
  volume), a global + per-user **monthly cost ceiling** with graceful degradation, and an anomaly circuit-breaker.
  Metering logs **counters only, never payloads**.
- **BYO escape hatch** — every relay-fronted aggregator also accepts a user-supplied key that bypasses the relay
  entirely (power users / privacy-maximalists / quota-exhausted users). Same code path, different key source.
- **Local-first preserved** — CSP `connect-src` adds exactly one host (the relay), no wildcards, main-process-only
  (the Linear/Todoist rule). Self-servable aggregators (Plaid, SnapTrade, exchange keys, self-hosted GPS) skip the
  relay and stay pure-BYO. Riskiest/most-infra of the primitives → built after the clean local paths (10.9).

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
| Wearables | recovery, strain, sleep | LIVE (Oura, Whoop, Garmin, Fitbit/Google), EXPORT (Strava, Fitbit, Garmin) | **Oura first** (LIVE, PAT). **Fitbit + Garmin EXPORT recognizers shipped** (daily steps/sleep JSON + activities JSON → Timeline; no OAuth/dev-app). LIVE OAuth for Fitbit/Garmin (auto-sync + habit auto-link) **deferred** — both need a full OAuth2 app + client secret (no PAT), Garmin has an approval waitlist; do once a real export validates the shapes. Whoop still open |

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
| Property / deed / assessor | ownership, tax, valuation | RIGHTS/CRED (county records) | **Concierge card shipped** (catalog-only; dropped PDFs index via the generic doc recognizer) |
| Court records | filings | CRED (PACER federal; state portals) | |
| Travel history | entry/exit dates, I-94 | RIGHTS (CBP), CRED (Global Entry / TSA) | **Concierge card shipped**; auto-importer (I-94 arrival/departure → `travel_segments` for the SPT) **deferred** — CBP has no clean export + it feeds a tax calc, so validate against a real export before parsing |
| Voter / DMV / vehicle | registration, title | RIGHTS/CRED (state portals) | |
| USPS Informed Delivery | scanned mail-piece images | LIVE/CRED | |
| **Data brokers** | your full file — "what's on record about you" | RIGHTS (LexisNexis full-file FCRA disclosure incl. LexID, Acxiom, Spokeo, Oracle) + opt-out | the eye-opener layer |
| Vital / immigration | birth/marriage, USCIS, passport | FILE/RIGHTS | mostly manual |

### 4e. Attention & lifestyle *(new — identified in the 2026-07-03 integrations deep dive, not yet built)*
| Source | What you get | Method(s) | Notes / guardrails |
|---|---|---|---|
| Time & attention | screen time, app/site usage | LIVE (RescueTime API, Toggl), EXPORT (native OS Screen Time) | digital wellbeing — ties naturally into Habits once 4b wearables prove the pattern (§6, Cross-Domain Leverage) |
| Lifestyle spend & delivery | ride history, food-delivery order history | EXPORT (Uber/Lyft/DoorDash/Grubhub/Instacart "download my data"), LIVE where an API exists | ties spending to daily-life patterns for the insights/nudge layer — not just another balance line |

**Prioritization (next up, in order, per the 2026-07-03 session):**
1. **Wearables — Oura first** — ✅ **shipped 2026-07-03**, the first LIVE health-fitness source, PAT-based. Whoop/Garmin/Fitbit follow once that pattern proves out.
2. **Crypto exchange** (Coinbase/Kraken, feeds 4a) — completes net worth alongside Plaid/SimpleFIN/holdings.
3. **Chat archive recognizers** (WhatsApp/Signal/Telegram, feeds 4c) — cheap EXPORT wins reusing `archive-importers.ts`.
4. **Lifestyle-spend recognizers** (Uber/DoorDash/Instacart, this section) — newly catalogued, not yet scheduled.

### 4f. Aggregator-of-aggregators — the force multiplier *(new — the paid-breadth thesis, wave 10.9)*

The highest-leverage integrations aren't 200 bespoke connectors — they're a handful of **paid aggregators** that
each cover *hundreds* of underlying sources through one integration, fronted by the metered relay (primitive **G**).
The sharpest picks don't just add data — they **complete a Compass engine that is manual today**. **Boundary:**
health / medical / income / insurance / precise-location are **aggregates-only** to the assistant + MCP (§5), like
finance/vault; low-sensitivity media/purchase history can be records-readable.

| Aggregator | Coverage (one integration) | Mode | Completes / unlocks | AI boundary |
|---|---|---|---|---|
| **Terra** (or Vital/Rook) | 500+ wearables/health apps (Fitbit, Garmin, Oura, Whoop, Apple Health, Strava) | LIVE-relay | **new Health hub** (sleep/HRV/activity trends; correlations w/ spend + productivity) | aggregates-only |
| **Metriport / Flexpa** | 300M+ medical records via FHIR/TEFCA/Carequality | LIVE-relay | longitudinal **medical timeline** → Phase 9.4 `medical_*` | aggregates-only |
| **SnapTrade** | every major brokerage (Robinhood/Schwab/Fidelity/E*TRADE) | LIVE-**BYO** | completes **holdings + net worth** (today: unvalidated CSV) | aggregates-only |
| **Canopy Connect** | 300+ P&C insurers ("Plaid for insurance") | LIVE-relay | completes **`finance-estate` insurance-adequacy / gap** engine (today: manual) | aggregates-only |
| **Argyle / Pinwheel** | payroll/income for ~80% of US workers | LIVE-relay | completes **Phase 4.5 forecast** + expat-tax withholding (today: inferred income) | aggregates-only |
| **Arcadia (Plug) / UtilityAPI** | 125+ utilities (bill + interval data) | LIVE-relay | completes **`finance-property` Schedule-E P&L** (missing expense line) + carbon | aggregates-only |
| **Knot (TransactionLink)** | SKU-level purchase detail from merchants | LIVE-relay | supercharges **subscriptions audit** + spend categorization (what, not just "Amazon $47") | records-readable |
| **Nylas** | 250+ email/calendar/contact providers (Gmail, Outlook, iCloud, Yahoo) | LIVE-relay | broadens **People / relationship intelligence** beyond Google-direct | aggregates-only |
| **Location history** *(shipped 10.8)* | OwnTracks / GPX / Google Timeline export | EXPORT (local) | completes **`residency.ts`** days-in-country / SPT / CR-183 (today: manual) | aggregates-only |
| MX / Finicity / Teller | Plaid alternatives — coverage / enrichment / income-verification | LIVE-relay/BYO | banking-connection depth beyond Plaid/SimpleFIN | aggregates-only |

**The leverage layer this unlocks** (cross-domain, the real payoff): *residency autopilot* (location → auto SPT +
alerts); *health × everything* (sleep/HRV vs. spend, productivity, calendar load; recovery-aware scheduling);
*true cash-flow* (Argyle income + Plaid spend + Knot SKU + utility bills); *coverage graph* (Canopy + assets +
estate docs → "what happens to X if Y"); *life year-in-review*; *ask-Compass over the whole life graph* (within
the aggregates-only boundary).

---

## 5. Security & guardrails

Every item below is non-negotiable and consistent with [architecture.md](architecture.md).

- **Local-first preserved.** Every source lands on disk. CSP `connect-src` is extended **per source**, no
  wildcards; prefer **main-process-only** API calls (like Linear/Todoist) so the renderer CSP never widens.
  The metered aggregator relay (primitive G) is consistent with this: it's a **stateless pass-through that stores
  no user data** (data still lands on disk), adds **exactly one** CSP host, keeps paid keys server-side, and always
  offers a BYO-key bypass. It exists to spare users an un-gettable dev account, not to custody data.
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
  is reviewed against this. **Sensitive raw streams stay OFF the `records` spine entirely:** firehose
  source-tiering (`source-tiers.ts`) is UI-only and does **not** gate `search_records`, so anything in `records`
  is assistant/MCP-searchable once Converse is on. Health, medical, income, insurance, and **precise location**
  are therefore **aggregates-only** — they get a dedicated table (the way finance uses `finance_transactions`),
  and only coarse derived aggregates surface. The first instance is **10.8's `location_points`**: raw coordinates
  never enter `records`; only the country/date `travel_segments` do.
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

- [x] **10.1 The acquisition spine** ✅ **shipped** — the **Drop Zone** (universal archive import + format-recognizer
  registry) + the unified **`records`/timeline store** (migration `0016`) + a basic **Timeline** view.
  Seed recognizers: a Google Takeout subset, Apple Health `export.xml`, and one credit-report PDF.
  *Everything else hangs off this — build first.*
- [~] **10.2 Financial & credit completeness** 🟡 *credit-report + tax-doc PDF recognizers shipped; a generic brokerage-holdings CSV importer (FILE path) shipped (PR #271 — `electron/integrations/finance-holdings.ts`, dated `records` snapshots, Net Worth holdings card); LIVE holdings feed, IRS transcripts, crypto still open (feeds Phase 11)* — credit reports (RIGHTS), brokerage/retirement holdings
  LIVE auto-feed (SnapTrade or Plaid Investments), IRS/tax transcripts, crypto. Extends Phase 4 net worth + forecast.
- [~] **10.3 Health & medical** 🟡 *Apple Health `export.xml` recognizer shipped; **Oura (LIVE, PAT-based) shipped 2026-07-03**; **Health hub surface shipped** (pure `health-summary.ts` + `/health` page + aggregates-only `compass_health_summary` MCP tool — unifies Oura + apple-health/fitbit/garmin into step/sleep/score/workout trends); FHIR/genetics/remaining LIVE wearables (Whoop/Garmin/Fitbit OAuth) open* — Apple Health (FILE) → FHIR/Blue Button (evaluate Fasten Health) →
  genetics → wearables. Feeds the Phase 9.4 `medical_*` tables.
- [~] **10.4 Digital footprint & comms** 🟡 *Google/Meta/LinkedIn/Amazon/Spotify/Netflix/YouTube + browser + iMessage + email shipped; Apple/WhatsApp/Signal/Telegram open* — the big takeouts (Google/Meta/X/LinkedIn/Amazon/Spotify) +
  browser history + iMessage + email archive. Heavy reuse of `archive-importers.ts`.
- [~] **10.5 Government & official + Data-Rights Concierge** 🟡 *Concierge (16 sources) + tax/SSA PDF recognizers shipped; IRS/bureau portal automation open* — SSA, IRS, property/court/travel, data-broker
  disclosures, and the request → track → ingest workflow (primitive C).
- [~] **10.6 Credential-Based Aggregation Engine** 🟡 *sandbox + SSA assisted-login adapter shipped (`electron/integrations/cred/`, gated off by `COMPASS_ENABLE_CRED`); stored-credential mode + more portals open* — the Portal Automation Sandbox (primitive D). Opt-in,
  vault-backed, isolated. Cross-cutting (unlocks no-export sources across every domain) and riskiest →
  **last**, after the clean paths exist.
- [x] **10.7 Advanced leverage** ✅ *Converse (FTS + semantic) · Connect (People + "on this day") · Curate (firehose tiering) shipped; combined dashboards remain* — rich unified timeline, the cross-source insights/correlation engine,
  Ask-Compass-over-everything, combined dashboards. *(Basic timeline + Ask-over-it ship incrementally from
  10.1 — each wave must be immediately leverageable, not deferred to the end.)*
- [x] **10.8 Location → Residency autopilot** ✅ *shipped* — the first **completes-a-feature** source: a dropped
  location export (OwnTracks `.rec`/`.json`, GPX, Google "Records.json" streamed) → raw points in a dedicated
  `location_points` table (migration `0029`) → an offline point-in-polygon projector (`location-country.ts`,
  bundled Natural Earth 110m boundaries, zero network/deps) collapses them into `travel_segments`
  (`source='location'`) so the Phase 11.5 residency engine (days-in-country / US substantial-presence / CR-183)
  goes from **manual** to **automatic**. Raw coordinates stay OFF the `records`/FTS/MCP spine (§5 aggregates-only);
  only the coarse country/date segments surface. *Next: a live self-hosted GPS endpoint (Overland/OwnTracks push).*
- [~] **10.9 The metered aggregator relay + first paid aggregators** 🟡 *relay + Terra + Canopy clients shipped
  (need a deployed relay + real keys to run live)* — primitive **G** (§3): the thin stateless **relay** (a new
  zero-dependency `relay/` workspace — metering/quota/anomaly engine + deny-by-default adapter allowlist + proxy
  server, 36 tests, deploy-ready). Two aggregators fronted so far, each **completing an engine**: **Terra**
  (`terra.ts` → health `records` `source:'terra'` → the Health hub) and **Canopy** (`canopy.ts` → `assets`
  insurance rows → the `finance-estate` adequacy/gap engine, replacing hand-entered policies). Client seam
  `relay-client.ts` (managed↔BYO; Canopy is managed-only). Self-servable aggregators (SnapTrade, exchanges) stay
  BYO. Next relay-fronted: Argyle / Arcadia / Metriport / Nylas / Knot. See §4f.

> **Build order:** 10.1 (spine) → 10.2 / 10.3 / 10.4 (independent, parallelizable, each reuses the spine) →
> 10.5 → 10.6 (cross-cutting, gated) → 10.7 (leverage, but delivered incrementally throughout) →
> 10.8 (location→residency, shipped) → 10.9 (paid-aggregator relay, the breadth push).

---

## 7. Decisions

**Resolved (shipped):**
- **`records` schema shape** → a single **polymorphic append-only `records` log** (dedup via a `hash`
  UNIQUE, like `finance_transactions`) + a separate **`snapshot_facts`** table for the static "who you are
  / what's set" facts; the heavy hitters keep their own typed tables (finance, calendar, contacts).
- **CRED automation framework** → a sandboxed Electron `BrowserWindow` with **assisted-login Mode A and no
  stored credentials** in v1 (`electron/integrations/cred/`), gated off by default. Stored-credential mode
  is a later, separately-gated step. Full design in [`cred-engine-design.md`](cred-engine-design.md).
- **Paid-aggregator access model** → **Hybrid** (2026-07). A thin **stateless relay** (primitive G) holds paid keys
  only for aggregators users can't self-serve (Terra/Nylas/Canopy/Argyle/Arcadia/Metriport), metered with per-user
  quotas + a cost ceiling + anomaly caps; self-servable aggregators (Plaid/SnapTrade/exchanges/self-hosted GPS)
  stay pure-BYO; every relay-fronted source also accepts a BYO key. Rationale: makes "get *all* your data" one-click
  without forcing an impossible dev-account signup, while the relay stores nothing and can't be abused (§3.G, §4f).

**Still open (resolve when each wave is greenlit):**
- **FHIR strategy** — adopt the self-hosted **Fasten Health** aggregator vs. a native SMART-on-FHIR client
  (Phase 10.3).
- **Large media** — index metadata only, or copy originals into the `documents` attachments store
  (Phase 9.2, not yet built)? Today's recognizers store a content-light index, not blobs.
- **Legal/ToS posture note** for the full-CRED wave (scraping disclosure, per-source preference order).

---

## 8. See also
- [`implementation_plan.md`](implementation_plan.md) — Phase 9 (the spine this extends) + the Phase 10 checklist
- [`architecture.md`](architecture.md) — process boundary, vault, MCP boundary, CSP (the invariants §5 enforces)
- [`integrations.md`](integrations.md) — the LIVE-connector `add-integration` pattern (primitive E)
- [`knowledge-extractor.md`](knowledge-extractor.md) — how ingested data becomes queryable knowledge
