---
name: morning-brief
description: Give me a tight morning brief from Compass — today's tasks, calendar, and any payments due soon. Use when the user asks for their "morning brief", "what's on today", "daily rundown", "start my day", or similar.
---

# Morning brief

A fast, read-only start-of-day summary from Compass. **Read only — never propose
or change anything in this skill.**

## Steps

1. Call **`compass_upcoming`** (default `days: 7`). It returns today's checklist
   `tasks`, calendar `events` in the window, and `paymentsDue` (accounts with a
   payment due in the next 14 days).
2. If the user wants more habit context, also call **`compass_habit_streaks`**
   and mention any streak that is at risk (current streak > 0 but today not yet
   done).

## Output format

Keep it scannable — no preamble. Use this shape:

```
☀️ <Weekday>, <date>

Today
- [ ] <task title>            (only items on today's daily list)
...

Calendar
- <HH:MM> <event title> <(location)>
...

Heads up
- 💸 <account> payment due <date>
- 🔥 <habit> streak (<n>d) — not done yet today
```

## Rules
- Omit a section entirely if it's empty (don't print "Calendar: none").
- Never invent tasks or events — only what the tools return.
- Times come from the event `start_at` (epoch ms) — render in the user's local
  time.
- This skill makes **no** `compass_propose_*` calls. If the user asks to add
  something, hand off to `plan-my-week` or tell them you can propose it.
