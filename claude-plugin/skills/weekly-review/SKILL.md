---
name: weekly-review
description: Run my weekly review in Compass — recap tasks, habit streaks, and spending, then propose next week's tasks. Use when the user asks for a "weekly review", "weekly recap", "how did my week go", "wrap up the week", or "plan next week" at a review level.
---

# Weekly review

A reflective end-of-week pass: **read first, then propose** next-week tasks the
user approves in the Compass Claude Inbox. Never write directly.

## 1. Gather (read-only)

- **`compass_upcoming`** (`days: 7`) — returns **today's** daily checklist plus
  the next 7 days of *calendar events* and any payments due. Note: it does **not**
  return a full week of tasks (only today's list) — don't claim week-wide task
  coverage; review today's open items + the week's events.
- **`compass_habit_streaks`** — current vs. longest streak per habit.
- **`compass_finance_summary`** (`months: 2`) — net worth + this month's spend by
  category (aggregates only; no raw transactions).
- Optional: **`compass_search_knowledge`** for any "weekly goals" / "OKR" note the
  user keeps, to ground the review.

## 2. Summarize

Write a short recap:
- **Wins** — habits with healthy/longest streaks; categories under control.
- **Slippage** — broken streaks (current = 0 but longest > 0); categories that
  look high this month.
- **Carryover** — tasks still open on the daily list.

Keep it honest and specific; cite the numbers the tools returned.

## 3. Propose (confirmed writes)

Suggest 3–6 concrete tasks for next week. For each one the user accepts, call
**`compass_propose_task`** with a clear `title`, `listType: "daily"` (or
`weekly`), and a real `listDate` (YYYY-MM-DD, local). Then tell the user:

> Proposed N tasks to your Claude Inbox — open Compass and approve the ones you
> want. Nothing has been added yet.

## Rules
- Confirm the list of tasks with the user **before** proposing, then propose only
  what they accept.
- One `compass_propose_task` call per task.
- Never expose or ask for vault data; finance stays at the summary level.
