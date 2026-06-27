# Cross-Border & Retirement

> **🔜 Planned (Phase 11) — not yet shipped.** This page describes the *direction* set by the June 2026
> expert panel, not current features. The full evaluation is in
> [`docs/strategic-review-2026-06.md`](https://github.com/sandgraal/compass/blob/main/docs/strategic-review-2026-06.md);
> the tracked items are in [`docs/implementation_plan.md` § Phase 11](https://github.com/sandgraal/compass/blob/main/docs/implementation_plan.md).

## Why this phase

Compass already tracks the **past** and the **next 90 days** well, and it already *encodes* a cross-border
life — Costa Rica geo-tags, a `capex-airbnb` tax tag, Schedule C/E, an ingested Social Security statement,
a `retirement` account class. But it does almost nothing with the **multi-year future** or the
**cross-currency** reality. A panel of domain experts (cross-border finance, US-expat tax, short-term-rental,
retirement, Costa-Rica residency, privacy, product) evaluated v0.14.0 and proposed turning that latent data
into a real life-planning layer. Most of the work is **leverage over data already in the database**, not new
ingestion.

## What's proposed

| # | Item | What it adds |
|---|---|---|
| **11.1** | **Multi-currency foundation** *(the keystone)* | currency per account/transaction, a daily FX-rate snapshot, base-currency net worth + forecast, and FX gain/loss on US↔CR transfers — instead of today's hard-coded USD. |
| **11.2** | **Foreign-account & expat tax** | FBAR (FinCEN 114) max-aggregate-foreign-balance tracking + a threshold flag, FATCA (Form 8938), and a foreign-tax-credit ledger. |
| **11.3** | **Costa Rica property / Airbnb P&L** | revenue / operating / capex→basis / net-yield and a Schedule E depreciation schedule, assembled from rows *already* tagged `geo`/`purpose`/`capex-airbnb`. |
| **11.4** | **Long-horizon retirement projection** | a multi-year decumulation engine: Social Security claiming-age from your ingested SSA statement, Airbnb + holdings as retirement income, sequence-of-returns. |
| **11.5** | **Days-in-country & residency readiness** | per-country day counts for the US substantial-presence test + a future CR 183-day rule; a residency-pathway checklist (pensionado / rentista / inversionista); a CAJA estimate. |
| **11.6** | **Goals & milestones** | target-date savings/goals tying property, tax reserve, and retirement together. |
| **11.7** | **Estate & insurance readiness** | cross-border beneficiaries, property title, and insurance-adequacy surfacing. |

## How it stays private

Phase 11 deepens into FX rates (a network call), foreign-account identifiers, and property records. The
existing invariants hold: FX fetches are **main-process-only** with a per-source CSP entry (no wildcard);
foreign-account numbers go to a new **`foreign-accounts`** vault category (never across IPC, never logged);
FBAR/FATCA exports follow the **vault-excluded** export rule; and 11.1/11.2 are `security-auditor` merge
gates — exactly like the Plaid/SimpleFIN rollouts. See [Security & Privacy](Security-and-Privacy).

## Related

- [Finance](Finance) — today's finance command center this builds on.
- [Roadmap & Status](Roadmap-and-Status) · [Data Rights & Acquisition](Data-Rights-and-Acquisition)
  (10.2 holdings/IRS transcripts feed 11.4/11.2).
