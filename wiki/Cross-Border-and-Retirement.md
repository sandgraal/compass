# Cross-Border & Retirement

**Routes:** `/finance` (Property · Expat Tax · Residency · Goals · Estate tabs) · `/retirement` ·
`/rental-studio` · **Sidebar:** Money → Finance / Retirement / Rental Studio

Compass tracks the **past** (statement ingest, tax tags) and the **next 90 days** (the cash-flow
forecast) well — and it encodes a cross-border life throughout: Costa Rica geo-tags, a
`capex-airbnb` tax tag, Schedule C/E, a `retirement` account class. Phase 11 (shipped 2026-06-30)
turned that latent data into a real life-planning layer: multi-currency, expat tax, CR property
P&L, residency tracking, goals, and estate readiness — almost entirely **leverage over data already
in the database**, not new ingestion. A follow-up integration (shipped 2026-07-02, v0.16.0) then
replaced the original retirement-projection piece with a materially deeper Monte-Carlo engine and
split it — along with a new CR short-term-rental pricing tool — out into their own top-level pages.
This page describes all of it as it stands **today, live and shipped**. Full history:
[`docs/implementation_plan.md` § Phase 11](https://github.com/sandgraal/compass/blob/main/docs/implementation_plan.md)
and the "P4–P7 Storehouse redesign + retire-early-hub integration" addendum right after it; original
direction-setting doc: [`docs/strategic-review-2026-06.md`](https://github.com/sandgraal/compass/blob/main/docs/strategic-review-2026-06.md).

## What shipped, tab by tab

These five live as tabs on the [Finance](Finance) page — see that page for the full tab list.

### Multi-currency foundation (the keystone)
Every account and transaction carries a `currency` (ISO 4217); a `fx_rates` table holds daily
rate snapshots (fetched from `open.er-api.com`, main-process-only, on a daily cron + a manual
refresh button). Net worth and the cash-flow forecast both roll up into a single **base currency**,
with an `unconverted` bucket surfaced separately when a rate is missing rather than silently
misconverting. Foreign positions also get **unrealized FX gain/loss** tracking. This underpins
everything else on this page — property P&L, FBAR, and the retirement engine's starting balance are
all base-currency-aware.

### Property tab — CR property / Airbnb P&L
`electron/integrations/finance-property.ts` assembles a **backward-looking** P&L (revenue /
operating / capex→basis / net yield) purely from transactions already tagged `geo`/`purpose`/tax
tag — no separate ledger. Revenue only appears once you manually tag Airbnb payouts
`tax:schedule-e-income` (the auto-classifier deliberately never assigns that tag, to avoid
mis-tagging ordinary CR spend as rental income); operating and capex fall back to CR
geo/purpose when no explicit tax tag is set. Capex accumulates into a cost basis instead of being
expensed immediately, and depreciates straight-line under a Schedule E schedule — **30-year foreign
ADS by default** (not the 27.5-year US-domestic schedule), configurable, with land excluded from
the depreciable basis.

### Expat Tax tab — FBAR / FATCA / foreign-tax-credit
`electron/integrations/finance-expat.ts` computes three things from data already on hand, entirely
main-process/pure — no new secrets, no vault access:
- **FBAR** (FinCEN 114) — the maximum aggregate USD value your foreign, non-debt accounts hit at any
  point in the year (from balance snapshots at year-end FX), flagged once it crosses the reporting
  threshold ($10,000 by default — *verify at filing*).
- **FATCA** (Form 8938) — the same aggregate against a higher, configurable threshold (defaults to
  $50,000 — *verify; the real figure varies by filing status and residence*).
- **Foreign-tax-credit** (Form 1116 groundwork) — foreign income/property tax paid, pulled from rows
  manually tagged `tax:foreign-tax`.

Which accounts count as "foreign" is a manual `isForeign` flag on the account. Account
**identifiers** (numbers, institution names) never reach this module or cross IPC — they live only
in the encrypted `foreign-accounts` vault category, exactly like the SimpleFIN/Plaid credential
model.

### Residency tab — days-in-country & residency readiness
`electron/integrations/residency.ts` turns a manual travel log into two tax-residency answers at
once. You log trips **outside** your home country (a country + an inclusive date range) into the
`travel_segments` table; any day not covered by a logged trip defaults to home, so you only record
the exceptions. From that log it computes:
- The **US substantial-presence test** (current year + ⅓ of the prior year + ⅙ of the year before,
  ≥ 183 — *verify the exact IRS gate conditions at filing time*).
- A **Costa Rica 183-day** residency check.
- A **pathway checklist** for CR residency-by-investment routes — pensionado (~$1k/mo pension
  income), rentista (~$2.5k/mo), inversionista (~$150k investment, defaulting to your CR property
  net worth) — *verify current thresholds*.
- A **CAJA** (Costa Rica's public health system) cost estimate as a percentage of declared income.

The `source` column on each travel segment leaves room for a future calendar or CBP I-94 auto-fill;
today everything is logged manually.

### Goals tab — target-date goals
`electron/integrations/finance-goals.ts`: each goal (a tax reserve, the next CR capex draw, a
retirement number, an emergency fund, or anything else) has a target amount, an optional target
date, and a planned monthly contribution. `computeGoalProgress` derives remaining amount, percent
complete, required monthly contribution, and an on-track/behind status. A goal's **current value**
is either entered manually, or **auto-linked** to a live aggregate — net worth, retirement assets
(the same figure the Retirement page computes), or property cost basis — so the goal tracks itself
without re-entry. All amounts are in your base currency.

### Estate tab — estate & insurance readiness
`electron/integrations/finance-estate.ts` is a readiness dashboard, not a document store: a manual
checklist (will, healthcare directive, POA, trust, beneficiary designations, a cross-border CR/US
plan, digital estate) you mark present/absent, insurance-adequacy surfacing from your
[Household & Assets](Storehouse-and-Timeline) `insurance` entries (coverage, expiring-soon renewals,
gaps against a recommended set), and property holdings as a title/beneficiary reminder. This module
deliberately reads **no vault data** — no decryption, no secrets touched — it just points you to
store the actual documents in Vault → Legal.

## Retirement (`/retirement`) — a separate top-level page

The original Phase 11.4 retirement projection was a deterministic accumulate-then-decumulate model
living as a **Retirement tab inside Finance**. On 2026-07-02 (v0.16.0) it was superseded: the
standalone `retire-early-hub` FIRE-planner app was ported into Compass as a materially more
sophisticated engine, and the Finance→Retirement sub-tab was deleted in favor of a dedicated
**`/retirement`** page (`src/pages/Retirement.tsx`).

The new engine (`electron/integrations/finance-retire-{constants,math,tax,strategy,engine,optimizer}.ts`)
is:
- **Monte Carlo, not just deterministic** — runs a distribution of market-return paths (configurable
  mean return, post-retirement return, and volatility σ) instead of a single baseline, and the page
  charts a p10/p50/p90 fan alongside the deterministic line.
- **Tax-aware** — models filing status (single/MFJ), 401(k) contribution limits, and a tax-aware
  drawdown strategy, not just gross balances.
- **Deep-integrated with the rest of Compass** rather than needing its own seed data — the starting
  balance is sourced from your actual net-worth snapshot (including brokerage holdings imported via
  the [Data Rights & Acquisition](Data-Rights-and-Acquisition) CSV importer), and — new since the
  split — its Airbnb income line is fed automatically from the CR Rental Studio's projected net
  (see below) instead of being a manually typed number.
- Still covers the same real-world levers as before: Social Security claiming age (62–70) against a
  manually entered PIA (the SSA-statement recognizer is deliberately content-light and never stores
  the benefit amount, so it can only detect *that* a statement was ingested, prompting you for the
  figure), a CR home/condo sale scenario, CAJA + private health + long-term-care cost modeling, and
  a sequence-of-returns stress path.

Config is split across two IPC calls — `finance:set-retirement-config` for the plan basics (ages,
spending, Social Security) and `finance:set-retirement-engine-config` for the deeper assumptions
(returns, volatility, health costs, the home-sale scenario) — both feeding `finance:get-retirement-plan`,
which the page renders as KPI tiles (success rate, starting assets, safe withdrawal rate, projected
depletion age) plus the Monte-Carlo fan chart.

> The legacy `finance:get-retirement-projection` / `finance:set-retirement-config` IPC handlers are
> kept in the codebase for back-compat but are **not called by any current UI** — the deterministic
> engine behind them was folded into the new one as its baseline path.

## CR Rental Studio (`/rental-studio`) — a separate top-level page

A new page (`src/pages/RentalStudio.tsx`), backed by `finance-rental-studio.ts`,
`finance-rental-pricing.ts`, and `finance-cr-rental-market.ts`, for pricing a Costa Rica
short-term-rental unit and feeding the result into your retirement plan:

1. **Comps** — collect comparable listings (name, zone, bedrooms, nightly rate, occupancy, rating)
   into the `rental_comps` table, either by hand or as you research the market.
2. **Suggested nightly rate** — the pricing engine (`finance-rental-pricing.ts`, ported from
   `retire-early-hub`) turns your comps + a listing config (bedrooms, positioning, amenities) into a
   per-unit price suggestion.
3. **12-month seasonal projection** — from that suggested rate, it projects a full seasonal revenue
   curve (Costa Rica's high/green-season occupancy and rate swings are modeled as constants in
   `finance-cr-rental-market.ts`), then nets it down through platform fees, operating costs, and CR
   tax to a projected annual/monthly net.
4. **Reconciliation, not blind trust** — the studio is explicitly the **forward-looking** projection,
   while the Property tab's P&L (above) is the **backward-looking** actual, built from tagged
   transactions. The page shows both side by side with a reconciliation banner, so the two numbers
   never quietly diverge.
5. **Feeds the retirement plan** — every time you save studio units or settings, the projected annual
   net is written into the retirement engine's `airbnbAnnualNet` input automatically, so your
   retirement projection always reflects your current pricing assumptions without manual re-entry.

## How it stays private

Nothing here relaxes Compass's existing privacy invariants:
- FX-rate fetches are **main-process-only**, hitting a single pinned CSP entry (`open.er-api.com`) —
  no wildcard network access.
- Foreign-account identifiers live only in the encrypted **`foreign-accounts`** vault category —
  never in the database, never across IPC, never logged.
- FBAR/FATCA figures follow the same **vault-excluded** export rule as the rest of finance.
- The Estate tab and the retirement/rental engines all read only non-vault, aggregate data.
- Claude/MCP and Ask Compass still only ever see finance as **aggregates/summaries** — the
  Retirement and Rental Studio pages are no exception. See [Security & Privacy](Security-and-Privacy).

## Related

- [Finance](Finance) — the tabbed command center this Property/Expat Tax/Residency/Goals/Estate
  content lives inside.
- [Storehouse & Timeline](Storehouse-and-Timeline) · [People](People) — the cross-reference engine
  that also feeds the net-worth/holdings figures these pages consume.
- [Roadmap & Status](Roadmap-and-Status) · [Data Rights & Acquisition](Data-Rights-and-Acquisition)
  (the brokerage-holdings CSV importer feeds the retirement engine's starting balance).
