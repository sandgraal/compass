---
name: plan-my-week
description: Plan my week in Compass — turn goals and upcoming events into proposed daily tasks. Use when the user asks to "plan my week", "build my week", "schedule my tasks", "turn these goals into tasks", or "set up next week".
---

# Plan my week

Turns the user's goals + what's already on the calendar into a realistic set of
**proposed** daily tasks (approved in the Claude Inbox). Read first; never write
directly.

## 1. Understand the week

- **`compass_upcoming`** (`days: 7`) — existing tasks + calendar events, so you
  don't double-book or duplicate.
- If the user references standing goals, **`compass_search_knowledge`** for the
  relevant note (e.g. "goals", "projects").
- Ask the user for this week's priorities if they haven't stated them.

## 2. Draft a plan

- Distribute priorities across days, working **around** existing events (lighter
  task load on heavy-meeting days).
- Keep it realistic — a few focused tasks per day beats an overloaded list.
- Present the draft as a day-by-day list and get the user's OK (and edits).

## 3. Propose the tasks

For each agreed task, call **`compass_propose_task`**:
- `title` — concrete and actionable ("Draft Q3 deck outline", not "Q3 deck"),
- `listType: "daily"`,
- `listDate` — the real local YYYY-MM-DD for that day,
- optional `category` (e.g. `work`, `personal`).

Finish with a count and the reminder that nothing is added until they approve in
Compass.

## Rules
- Confirm the plan before proposing; propose only accepted tasks.
- Use real calendar dates (no impossible dates); one `compass_propose_task` per
  task.
- Don't touch the vault or finances here.
