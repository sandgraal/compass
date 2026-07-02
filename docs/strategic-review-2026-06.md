# Strategic review — June 2026

> **⚠️ Superseded — kept as a historical record; the Phase 11 it proposed shipped in full on 2026-06-30.**
> See [`implementation_plan.md`](implementation_plan.md) § Phase 11 for current status.
>
> Audit snapshot taken **2026-06-26** (at v0.14.0). The living tracker is
> [`implementation_plan.md`](implementation_plan.md); this file is the *why* behind the next shape of that
> tracker. **Supersedes** [`strategic-review-2026-05.md`](strategic-review-2026-05.md) (which drove Phases
> 6–10 and is now a historical snapshot).

## TL;DR

- **The docs fell behind a fast quarter.** v0.11.0 → v0.14.0 shipped in ~two weeks (2026-06-14 → -26): the
  entire **Storehouse** (Phase 9) and **Acquisition Engine** (Phase 10) arc. The trackers still show Phase
  10 as `[ ]` "no code yet" even though the Drop Zone, the `records`/Timeline store (migration `0016`),
  **~44 recognizers**, the Data-Rights Concierge, the CRED sandbox + SSA adapter, the People directory, and
  semantic search all shipped. `docs/finance.md` never mentions **SimpleFIN** (the current *recommended*
  bank sync). The wiki (2026-05-24) predates all of it. This review's companion work reconciles every doc.
- **The product is a strong tactical finance + life-log tool, but a thin strategic one.** It tracks the
  past and the next 90 days extremely well. It does almost nothing with the **multi-year** future, and
  nothing with the user's actual cross-border shape — despite already *encoding* that shape (CR geo tags, a
  `capex-airbnb` tax tag, Schedule C/E, an ingested SSA statement, a `retirement` asset class that no
  calculation reads).
- **A fresh domain-expert panel** (finance, retirement, US-expat tax, Costa-Rica, short-term-rental,
  privacy, product) evaluated v0.14.0 for the confirmed user context — **a US-based owner of Costa Rica
  property run as an Airbnb, with cross-border activity (US/CR/Spain/Colombia/Panama).** Their
  recommendations consolidate into a new **Phase 11 — Life Planning & Cross-Border** and re-prioritize the
  existing Phase 10 backlog to feed it.

---

## What shipped since the May review

| Arc | What | Where |
|---|---|---|
| Phase 6 | Code-health debt fully drained (IPC test backfill, empty-catch sweep, Biome `--error-on-warnings` gate, type-safety audit) | `electron/ipc/*.test.ts`, CI |
| Phase 7 (partial) | Morning Brief + low-cash/price-hike alerts · weekly/monthly review · multi-type quick-capture · Obsidian + Notion(import) · Linear · Todoist · Things 3 · proactive insights · agentic "plan my week" · theming | across `electron/` + `src/` |
| Phase 8 | Bidirectional Claude — MCP read+propose, Claude Inbox, `.mcpb` Desktop bundle, end-user plugin, 5 skills, embedded agent | `mcp/compass-mcp/`, `claude-plugin/`, `src/pages/ClaudeInbox.tsx` |
| Phase 4.8 | **SimpleFIN Bridge** — user-as-aggregator bank/card sync (incl. Amex), now the recommended default; Plaid demoted to advanced | `electron/integrations/simplefin/*` |
| Phase 9 | Contacts + Universal Export Center · archive contact importers · Subscriptions · Assets · Storehouse overview | `electron/ipc/{contacts,subscriptions,assets,storehouse}.ts` |
| Phase 10 | **Acquisition Engine** — Drop Zone + `records`/Timeline + ~44 recognizers · Data-Rights Concierge · CRED sandbox (SSA, gated) · People directory · FTS + semantic records search · "On this day" · firehose curation | `electron/lib/recognizers.ts`, `electron/integrations/cred/`, `src/lib/data-rights.ts`, `src/pages/{Timeline,People}.tsx` |

## Plan-vs-reality discrepancies (what the companion doc-reconciliation fixes)

1. **Phase 10 checkboxes are stale.** `implementation_plan.md` (§Phase 10) and `storehouse-roadmap.md`
   (§6) show `[ ]` for 10.1 and the wave roadmap, contradicting ~44 shipped recognizers, the Drop Zone,
   the Timeline, the Data-Rights Concierge, and the CRED sandbox.
2. **The status snapshot stops at Phase 8.** No rows for Phase 9 (~70%) or Phase 10 (~40%).
3. **`docs/finance.md` predates two shipped systems.** It shows Plaid "not started," never mentions
   SimpleFIN, and still frames the Excel cutover as running "through 2026-06-10" (it closed early
   2026-05-21) with Net-Worth/Forecast/Tax tabs "pending UI follow-up" (all shipped).
4. **`README` version badge** reads `0.11.0` (real: `0.14.0`).
5. **The wiki predates the Storehouse/Acquisition arc entirely.**

---

## The fresh expert panel

Seven lenses. Each says what it *sees* in v0.14.0 (grounded in real code), the *gap*, and a concrete
recommendation that maps to a Phase 11 item. Per the house style, jurisdiction-specific thresholds are
marked *(verify at build time)*.

### 1. Cross-border CFP / multi-currency money manager
- **Sees:** `finance-geo.ts` classifies every transaction `geo ∈ CR | US | SPAIN | COLOMBIA | PANAMA |
  OTHER`; CR ATM withdrawals get a 70/30 project-vs-personal split; the CR build is tracked as `capex`.
- **Gap:** **everything is hard-coded USD** (`toLocaleString('en-US', { currency: 'USD' })`). There is no
  colón (CRC), no FX rate, no per-account currency. The user cannot see the *true USD cost over time* of a
  build paid in colones, and US↔CR transfers aren't modeled as FX events (a wire that loses 2% to spread
  is invisible). For someone whose largest asset and active spend are in another currency, this is the
  single biggest blind spot.
- **Recommends → 11.1 Multi-currency foundation** — the keystone. Everything cross-border depends on it.

### 2. US expat / international tax specialist (EA/CPA)
- **Sees:** `finance-tax.ts` already classifies `tax:schedule-c-income/expense`, `tax:schedule-e`,
  `tax:capex-airbnb`, `tax:charitable/medical/investment`; a tax-pack export writes one CSV per tag per
  year. The user *obviously* holds foreign (CR) financial accounts.
- **Gap:** nothing for the **foreign** side of an expat return. No **FBAR (FinCEN 114)** — required when
  aggregate foreign-account value exceeds **$10,000 at any point in the year** *(verify)*; the app has the
  balance data to compute the max-aggregate but never does. No **FATCA (Form 8938)**. No foreign-tax-credit
  tracker (CR property tax / income tax paid). And `capex-airbnb` is *tagged* but never turned into a
  **depreciation schedule** for Schedule E.
- **Recommends → 11.2 Foreign-account & expat-tax surface** (+ depreciation feeds 11.3).

### 3. Short-term-rental (Airbnb) business advisor
- **Sees:** the CR property as a `manual_asset`; `capex-airbnb` tagging; ATM-split labor tagging; geo +
  purpose (`capex | operating | household | travel | other`) columns already on every CR transaction.
- **Gap:** no **property P&L**. The data to show *revenue vs. operating expense vs. capex-to-basis vs. net
  yield* is already tagged and indexed — but there's no view that assembles it, no **cost-basis
  accumulator** (capex → adjusted basis for an eventual sale), and no separation of the property as a
  business unit.
- **Recommends → 11.3 CR property / Airbnb P&L + depreciation** — almost pure assembly over existing tags.

### 4. Retirement / decumulation planner
- **Sees:** a `retirement` value in the `assetClass` enum; an **ingested SSA statement** (the
  `SOCIAL_SECURITY_RECOGNIZER` parses lifetime earnings + benefit estimate into `records`); the 90-day
  `buildForecast`.
- **Gap:** the forecast horizon is **90 days**; there is no multi-year/decade projection, no decumulation
  modeling, and the SSA data sits inert — never used to model **claiming age** (62 vs. FRA vs. 70). The
  Airbnb's net income — a real retirement cash-flow source — isn't modeled forward either. The `retirement`
  asset class is decorative.
- **Recommends → 11.4 Long-horizon retirement projection** — extends `buildForecast`; consumes the SSA
  record (10.5) and brokerage holdings (10.2).

### 5. Costa Rica relocation / residency strategist
- **Sees:** a US-based user with deep CR financial ties and an explicit Spain/Colombia/Panama travel
  footprint in the geo enum.
- **Gap:** forward-looking, but real. No **days-in-country** tracker — which governs *both* the US
  substantial-presence test *and* a future CR residency 183-day rule. No residency-pathway model
  (**pensionado** ~$1k/mo pension · **rentista** ~$2.5k/mo · **inversionista** ~$150k investment — the CR
  property may already qualify) *(verify thresholds)*. No CAJA (public health) cost estimate.
- **Recommends → 11.5 Days-in-country & residency readiness** — also de-risks the §2 substantial-presence
  question.

### 6. Local-first privacy & security architect (continuity from the May panel)
- **Sees:** the durable invariants — MCP opens the DB read-only with vault + raw finance excluded; finance
  reaches the assistant as **summaries only**; the records-only relaxation is explicit and scoped; CRED is
  gated off by default with an assisted-login, no-stored-credentials Mode A.
- **Gap / guard:** Phase 11 deepens into FX rates (a *network* call), foreign account numbers, and property
  records — and Phase 10 will eventually log into CR bank / IRS portals via CRED. Hold the line: a new
  vault category `foreign-accounts` for account identifiers (never across IPC, never in logs — the
  SimpleFIN/Plaid rule); FX-rate fetches are main-process-only with a **per-source** CSP entry, no
  wildcard; FBAR/FATCA exports follow the export rule (**vault excluded**); every new agent tool re-checked
  against summaries-only.
- **Recommends:** treat 11.1/11.2 as `security-auditor` merge gates, exactly like the Plaid/SimpleFIN
  rollouts.

### 7. Personal-data-sovereignty / product strategist (continuity)
- **Sees:** the Acquisition Engine is ~40% built and the leverage layer (Timeline, People, "on this day,"
  semantic search) is live — but it has no *life-planning* consumer yet.
- **Recommends:** **sequence acquisition to feed Phase 11.** Promote **10.2** (brokerage/retirement
  holdings → feeds 11.4; IRS/tax transcripts → feeds 11.2); the shipped **SSA RIGHTS** already feeds 11.4;
  keep **10.3 Apple Health** lower for a US-based user; **10.6 full CRED** stays gated and last. The North
  Star ("acquire → keep → leverage") gains its first *strategic* leverage payoff.

---

## Proposed Phase 11 — "Life Planning & Cross-Border"

Sequenced; each reuses shipped machinery (build later — this review is the *why*, not a build order to run
now). Sizes are rough order-of-magnitude.

| # | Item | Reuses | Size |
|---|---|---|---|
| **11.1** | **Multi-currency foundation** — `currency` on accounts/txns, a daily FX-rate snapshot table, base-currency net worth + forecast, FX gain/loss on cross-border transfers | finance schema · `finance-snapshot.ts` · `buildForecast` | **L** |
| **11.2** | **Foreign-account & expat-tax surface** — FBAR (FinCEN 114) max-aggregate-foreign-balance-by-year + threshold flag · FATCA 8938 · foreign-tax-credit ledger; account numbers → vault `foreign-accounts` | `finance-tax.ts` · tax-pack export · vault | **M** |
| **11.3** | **CR property / Airbnb P&L + depreciation** — revenue / operating / capex→basis / net-yield view + Schedule E depreciation, assembled from already-tagged rows | `geo`/`purpose`/`taxTag` columns · ATM split | **M** |
| **11.4** | **Long-horizon retirement projection** — multi-year decumulation engine; Social Security claiming-age from the ingested SSA statement; Airbnb + holdings as retirement income; sequence-of-returns | `buildForecast` · SSA recognizer (10.5) · holdings (10.2) | **L** |
| **11.5** | **Days-in-country & residency readiness** — per-country day counts (US substantial-presence + CR 183-day) · pensionado/rentista/inversionista threshold checklist · CAJA estimate | `calendar_events` · records/Timeline · CBP I-94 (RIGHTS, future) | **M** |
| **11.6** | **Goals & milestones** — target-date savings/goals tying property, tax reserve, and retirement together | `appSettings` · forecast | **M** |
| **11.7** | **Estate & insurance readiness** — cross-border beneficiaries · CR property title · insurance adequacy | vault (legal/medical) · `assets` | **S/M** |

**Build order:** 11.1 (keystone) → 11.2 / 11.3 (independent, both ride the existing tag system) → 11.4
(needs 11.1 + holdings) → 11.5 → 11.6 → 11.7. Each its own PR(s) with tests; 11.1/11.2 get a
`security-auditor` gate.

---

## Verification (what this review + its companion reconciliation land)

- `implementation_plan.md` status snapshot includes Phase 9, 10, **and 11**; no `[ ]` remains for shipped
  Phase 10 work.
- `docs/finance.md` documents SimpleFIN and reads in past tense about the Excel cutover.
- `README` badge = `0.14.0`; the wiki mirrors the new snapshot; all internal links resolve.
- This file is linked from `implementation_plan.md` + `README.md`; the May review carries a superseded
  banner.

## Out of scope for this review

- **Building any Phase 11 item** — each is its own PR after this lands.
- The remaining Phase 7/9/10 backlog (Slack/Jira, documents 9.2, medical 9.4, the advanced 10.2–10.4
  sources) — unchanged in priority except the 10.2 promotion noted above.
