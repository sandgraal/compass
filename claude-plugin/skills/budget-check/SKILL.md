---
name: budget-check
description: Check my budget in Compass — review spending by category, flag overspend, and propose tax tags or recategorizations. Use when the user asks to "check my budget", "how's my spending", "review my finances", "tag my transactions for taxes", or "categorize my spending".
---

# Budget check

Reviews Compass finances and **proposes** tags/recategorizations the user
approves in the Claude Inbox. Finance is exposed as **summaries only** — you will
never see individual transactions here.

## 1. Read

- **`compass_finance_summary`** (`months: 6` is a good default). Returns:
  - `netWorth` (assets / liabilities / net),
  - `monthly` income/expense/net for the window,
  - `currentMonth.byCategory` — this month's spend per category.

## 2. Analyze

- Call out the **top 3–5 spend categories** this month and how the month's net
  compares to recent months.
- Flag anything notable: a category much higher than its usual share, a negative
  net month, rising liabilities.
- Be precise with the numbers the tool returned; don't speculate about
  individual purchases (you can't see them).

## 3. Propose (optional, confirmed)

The summary tools don't expose transaction IDs, so to tag/recategorize you need
an ID the **user** provides (e.g. from the Compass Finance page). When the user
gives you a transaction id + intent:

- **`compass_propose_txn_tag`** with `transactionId` and a `taxTag` (one of the
  allowed `tax:*` values, e.g. `tax:charitable`, `tax:home-office`,
  `tax:schedule-c-expense`) and/or a `category`.

Then: "Proposed the tag to your Claude Inbox — approve it in Compass to apply."

## Rules
- Summaries only — never request or assume raw transaction details.
- `taxTag` must be one of the allowed `tax:*` values; if unsure, list the options
  and let the user pick.
- Propose, never apply. One proposal per transaction.
