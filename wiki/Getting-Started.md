# Getting Started

Compass is a desktop app. There's no sign-up, no account, and no cloud — you install it, open
it, and your data store is created locally on first launch.

## Install

**Primary target: macOS** (signed `.dmg` releases via GitHub Actions). Windows
(`nsis` / portable) and Linux (`AppImage` / `deb`) build targets also exist.

- **End users:** download the latest release for your platform from the project's GitHub
  Releases page and run the installer. On macOS, drag Compass to Applications.
- **Auto-update:** once installed, Compass checks GitHub Releases ~3 seconds after launch and
  then every 4 hours. When a new version is available it downloads in the background and shows
  an **Update banner** with a *Restart to Install* button. See [Backup & Restore](Backup-and-Restore#updates).

## First launch

On the very first run, Compass:

1. **Creates your local data store** in your OS application-data directory. On macOS that's
   `~/Library/Application Support/Compass/` (see [Data & Storage Reference](Data-and-Storage-Reference)).
2. **Seeds a starter knowledge base** — a handful of markdown templates so the Knowledge Base
   isn't empty.
3. **Launches the onboarding wizard.**

### The onboarding wizard

A 4-step wizard introduces the core of Compass. Every step is **skippable** — you can do all of
this later from the relevant page.

| Step | What it does |
|---|---|
| **1 · Welcome** | Orientation: what Compass is and that everything stays on your machine. |
| **2 · Connect integrations** | Optional one-click connect for **Google** and **GitHub** so your calendar, email action items, and issues flow into the Daily view. (Full set lives on the [Integrations](Integrations) page.) |
| **3 · Track your money automatically** | Points you at the [Finance](Finance) module and the watched-folder ingest so statements categorize themselves. |
| **4 · Vault primer** | Explains the encrypted [Vault](Vault) and that the master key lives in your OS Keychain. |

Finishing (or skipping) the wizard drops you on **Overview** (`/overview`) — the app's actual entry
point (and what the root route redirects to on every subsequent launch). Overview is the "everything
you've brought into Compass, in one place" landing page: a global search box plus quick links into
People, Places, and Money. The sidebar's **Home** section lists it first, above **Dashboard** and
**Timeline** — Dashboard is a separate, richer morning-brief view (today's brief, proactive insights,
"On this day", payments due, GitHub/Linear items) you can reach any time from the sidebar or ⌘K. See
**[Dashboard](Dashboard)** for what's actually on that page.

## Day-one workflow

The intended rhythm:

- **Morning** — open **Overview** to see everything at a glance, then jump to the
  **[Dashboard](Dashboard)** / **[Daily](Planner-Daily-Weekly-Monthly#daily)** view for your brief:
  today's tasks, calendar, GitHub due items, and Gmail action items.
- **Through the day** — capture notes and tasks. Use the tray **[Quick Capture](Search-and-Command-Palette#tray-quick-capture)** or ⌘K command palette without leaving what you're doing. Drop bank/credit statements into your watched **[Finance](Finance)** folder.
- **Sunday** — run the **[Weekly Review](Planner-Daily-Weekly-Monthly#weekly)** ritual.

## Running from source (developers)

```bash
# Prerequisites: Node 20+ (nvm), npm
npm install        # installs deps + rebuilds native modules for Electron
npm run dev        # Electron + Vite HMR
npm run build      # production build
npm run typecheck  # renderer + main type-check
npm run check      # Biome lint + format
npm run test:run   # Vitest unit tests (one-shot — NOT `npm test`, which is watch mode)
```

See the **[Developer Guide](Developer-Guide)** for the full toolchain, conventions, and the
native-module ABI gotcha.
