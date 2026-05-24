# Integrations

**Route:** `/integrations` · **Sidebar:** Integrations · **⌘K:** "Integrations" / "Sync all services"

Integrations pull *your own* data from external services into Compass. Each integration:

- stores its OAuth token / PAT **encrypted** (`.vault/oauth-<service>.enc`), never in plaintext,
  never exposed to the renderer;
- syncs on a schedule (per-integration interval, default 15 min) and on demand;
- writes rows into the DB **and** regenerates a markdown summary in your [Knowledge Base](Knowledge-Base).

The page renders one card per service with a **Connect** button and connection status.

## Available services

| Service | What it brings in | Auth |
|---|---|---|
| **Google Calendar** | Calendar events → Daily/Weekly views + `calendar/upcoming.md` | OAuth |
| **Google Drive** | File index → `drive/index.md` | OAuth |
| **Gmail** | Extracted action items → Daily view + `inbox/action-items.md` | OAuth |
| **GitHub** | Issues, PRs, project items → Daily "Due Today" + `work/github-summary.md` | Personal Access Token |
| **Plaid** | Bank/credit transactions → [Finance](Finance) | Plaid link (token in `.vault/plaid.enc`) |
| **Apple Calendar** | Local `.ics` events (with RRULE expansion) | Local file — no account |

## Connecting Google (OAuth)

Google requires you to use **your own** OAuth app (so your data flows through *your* Google Cloud
project, not a shared one). The card includes an inline setup guide:

1. Create an OAuth client of type **Web application** in Google Cloud Console.
2. Enable the **Google Calendar API**, **Google Drive API**, and **Gmail API** as needed.
3. Add the **Authorized redirect URI** shown on the card.
4. Paste your **Client ID** and **Client secret** into Compass.
5. Click **Connect** → an OAuth window opens → grant the scopes → tokens are encrypted and saved.

## Connecting GitHub (Personal Access Token)

Simpler than OAuth: click **Generate token** (links you to GitHub's token page), create a PAT with
the scopes shown, paste it, and **Connect**. The token is encrypted via `safeStorage`.

## Connecting your bank (Plaid)

See [Finance → Plaid bank-linking](Finance#plaid-bank-linking). Empty state before linking:
*"No banks connected yet."* Access tokens live encrypted in `.vault/plaid.enc`, never in the DB.

## Syncing

- **Automatic** — background `node-cron` job per integration.
- **Manual** — *Sync all services* from the ⌘K palette, or per-card.
- **History** — every attempt (records updated / errors) is logged append-only in `sync_events`;
  the integration row carries `lastSyncedAt` and any `errorMessage`. Claude can read overall
  integration health via `compass_integration_health`.
- **Interval** — adjust per-integration sync frequency in [Settings → Sync](Settings#sync).

## Adding a new integration (developers)

The pattern (schema → auth → sync → extractor → frontend card → types → tests) is documented in
[`docs/integrations.md`](https://github.com/sandgraal/compass/blob/main/docs/integrations.md) and
automated by the `add-integration` skill. See the [Developer Guide](Developer-Guide#adding-an-integration).

## Related

- [Planner: Daily / Weekly / Monthly](Planner-Daily-Weekly-Monthly) — where calendar/GitHub/Gmail items land.
- [Knowledge Base](Knowledge-Base#auto-updated-notes--the-diff-view) — the auto-updated summary notes.
