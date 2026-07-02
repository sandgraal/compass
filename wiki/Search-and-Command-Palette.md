# Search & Command Palette

Compass is keyboard-first. Three mechanisms let you move and capture without hunting through menus.

## Command palette (⌘K)

Press **⌘K** anywhere to open the global palette. It does two jobs at once:

**Navigation & actions:**
- Jump to any page: **Overview**, **Dashboard**, **Storehouse**, **Timeline**, Daily, Weekly,
  Monthly, Knowledge Base, Ask Compass, Claude Inbox, Vault, **Contacts**, **People**,
  **Merchants & Places**, **Subscriptions**, **Household & Assets**, **Export & Portability**,
  Finance, **Retirement**, **CR Rental Studio**, Integrations, Settings.
- Deep links: **Net Worth**, **Cash-flow forecast** (open the right Finance tab directly).
- Quick actions: **New task for today**, **Search knowledge base**, **Sync all services**,
  **Open data folder**.

**Live global search:** as you type, the palette returns hits across:
- **Knowledge notes** (titles + bodies),
- **Vault entry titles** (titles only — never the secret contents),
- **Tasks**, and
- **Transactions**.

Selecting a hit navigates straight to it (e.g. a task opens the right Daily/Weekly/Monthly view).
This is backed by the `search:global` handler.

## Tray quick-capture

Compass lives in your menu bar / system tray. A **global keyboard shortcut** (configurable in
[Settings → Quick Capture](Settings#quick-capture)) pops a tiny always-available window with a
single **"Quick task…"** field. Type a task, hit enter, and it's added — without switching to the
main window. Ideal for capturing a to-do mid-flow.

## The `compass://` URL scheme

Compass registers a `compass://` protocol handler, so links and scripts can drive the app:

- `compass://capture` — open quick-capture
- `compass://open/<page>` — jump to a page
- `compass://search?...` — run a search

These route through the OS (`open-url` on macOS, `second-instance` on Windows/Linux) into the same
in-app navigation the palette uses. Handy for shortcuts, automations, and bookmarklets.

## Related

- [Settings](Settings#quick-capture) — rebind the quick-capture shortcut.
- [Knowledge Base](Knowledge-Base#search) — semantic + full-text note search.
