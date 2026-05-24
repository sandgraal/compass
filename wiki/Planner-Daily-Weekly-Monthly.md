# Planner: Daily / Weekly / Monthly

Compass's planner is three linked checklist views plus habit tracking. They share one store
(`checklist_items`) and one templating system (`checklist_templates`), but each is tuned to a
different cadence.

- [Daily](#daily) — the day's working checklist, enriched with calendar / GitHub / Gmail.
- [Weekly](#weekly) — the Sunday review ritual.
- [Monthly](#monthly) — the monthly reflection.
- [Habits](#habits) — streak tracking woven into the daily flow.

Tasks have a **source**: `manual`, `github`, `calendar`, or `gmail`. Integration-sourced tasks
appear automatically after a sync; manual ones you add yourself.

---

## Daily

**Route:** `/daily` · **Sidebar:** Daily · **⌘K:** "Daily" / "New task for today"

The Daily page is the day's command center, keyed to a specific date (you can move between days).

### Sections

- **Task list** — the checklist for the selected day. Add, complete, and edit tasks. Empty state:
  *"No tasks yet for this day."*
- **Calendar events strip** — the day's events, synced from Google / Apple Calendar.
- **GitHub · Due Today** — issues/PRs whose due date is today.
- **Gmail action items** — the top action items extracted from your inbox (today's, capped to a
  handful so it stays a brief, not a queue).
- **Habits** — toggle today's habit completions (see [Habits](#habits)).

### Templates

Every list type has an editable markdown **template**. On the Daily page:

- **Template** button → opens the template editor. Write your recurring daily structure as
  markdown (sections like `## Calendar`, plus task lines).
- **Seed from template** → instantiates today's checklist from that template in one click, so
  your standing routine doesn't have to be retyped each morning.

Templates are stored per list type (`daily` / `weekly` / `monthly`) in `checklist_templates`.

---

## Weekly

**Route:** `/weekly` · **Sidebar:** Weekly · **⌘K:** "Weekly"

**Weekly Review** is a Sunday ritual surface. It gathers the week's signal and gives you reflection
prompts:

- **Open issues** — outstanding items carried into the review (empty state: *"No open issues."*).
- **Reflection prompts** — what went well, blockers, and next-week planning (backed by the weekly
  template and weekly-goals settings).
- **Clear** controls to reset/close out the review.

Use it to close the loop on the week and seed next week's priorities.

---

## Monthly

**Route:** `/monthly` · **Sidebar:** Monthly · **⌘K:** "Monthly"

**Monthly Reflection** is the longer-horizon counterpart:

- Scoped to the **current month** (with month navigation).
- Surfaces month-level metrics (e.g. **Total debt** from the [Finance](Finance) module) alongside
  reflection prompts and the monthly checklist/template.

---

## Habits

Habits are user-defined (each has an **icon** and **color**) and tracked as a per-day boolean.

- Define habits and toggle today's completion from the Daily flow.
- **Streaks** are computed on the **local calendar day** (not UTC), so they don't break across
  time zones or DST.
- Habit data lives in the `habits` + `habit_entries` tables. Claude can read your streaks
  (`compass_habit_streaks`) and *propose* a habit check-in for your approval — see
  [Claude & MCP](Claude-and-MCP).

## Related

- [Dashboard](Dashboard) — the condensed today view.
- [Integrations](Integrations) — what feeds GitHub / calendar / Gmail items in.
- [Search & Command Palette](Search-and-Command-Palette) — quick-capture a task from anywhere.
