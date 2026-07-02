# Dashboard

**Route:** `/dashboard` · **Sidebar:** Dashboard (Home section) · **⌘K:** "Dashboard"

The Dashboard is Compass's daily morning-brief view — a richer, more detailed read on today than a
quick glance. It sits in the sidebar's **Home** section, second after **[Overview](#dashboard-vs-overview)**.

## What it shows

- **Morning Brief** — a glanceable digest of what matters today, pulled together from your tasks,
  calendar, and integrations.
- **Proactive Insights** — local-only nudges Compass surfaces on its own (no cloud calls).
- **On This Day** — memories from prior years at the same date, drawn from your imported data.
- **A 4-stat row** — Tasks Today, GitHub Issues, Inbox Actions, and Upcoming Events, each with a
  short sub-label (e.g. "3 completed", "next 7 days").
- **Payments Due** — a card surfaced from statement metadata when a debt account has a payment due
  within roughly the next two weeks. Links through to [Finance](Finance).
- **Today's Tasks** — the checklist items scheduled for the current day, pulled from the same
  store as the [Daily](Planner-Daily-Weekly-Monthly#daily) view, with quick-add.
- **GitHub / Linear items** — issues and PRs assigned to you (GitHub) and issues from Linear, each
  only shown once the integration is connected and has synced data.

## Working from the Dashboard

- Check off tasks directly as you complete them.
- Quick-add a task without leaving the page.
- **Sync now** triggers a manual sync across all connected integrations.
- Use the **[Command Palette](Search-and-Command-Palette)** (⌘K) to jump anywhere or to add a
  "New task for today" without leaving the page.

> The deep daily workflow (calendar strip, GitHub due-today, Gmail action items, habits, templates)
> still lives on the **[Daily](Planner-Daily-Weekly-Monthly#daily)** page — Dashboard is the brief,
> Daily is the workspace.

## Dashboard vs. Overview

Compass has two "home base" pages, and it's easy to conflate them:

- **Overview** (`/overview`) is the actual app entry point — the index route redirects here,
  and it's what you land on after the onboarding wizard. It's the broad, lightweight landing page:
  "everything you've brought into Compass, in one place," with a global search box and quick links
  into People, Places, and Money.
- **Dashboard** (`/dashboard`) is the richer daily-brief view described above — reachable any time
  from the sidebar's Home section or ⌘K, but it is not what you land on by default.

## Related

- [Planner: Daily / Weekly / Monthly](Planner-Daily-Weekly-Monthly)
- [Search & Command Palette](Search-and-Command-Palette)
