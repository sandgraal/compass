# Settings

**Route:** `/settings` · **Sidebar:** Settings · **⌘K:** "Settings"

Settings is organized into labeled sections. Changes persist immediately to the `app_settings`
key/value store.

## Appearance
- **Theme** — Light / Dark / **System** (follows your OS appearance; Compass listens for macOS
  dark/light flips and updates live).
- **Context Drawer** — show the right-side context panel by default.

## Sync
- **Auto-sync interval** — how often connected services are pulled: Every 5 / 15 / 30 minutes,
  Every hour, or **Manual only**. (Per-integration intervals can differ; this is the global default.)

## Notifications
- **Sync notifications** — show a system notification when a sync completes.

## Security & Privacy
- **Data storage** — confirmation badge: **Local only** (`~/Library/Application Support/Compass`).
- **Vault encryption** — badge: **AES-256-GCM**, key in OS Keychain.
- **Vault auto-lock** — hide vault entries behind an *Unlock* CTA after N idle minutes (Off, or 1 /
  2 / 5 / 10 / 15 / 30 / 60 min). Also locks immediately when the window loses focus. Applies on
  your next visit to the [Vault](Vault).

## Data
- **Open data folder** — *Open in Finder* to browse your knowledge base, vault, and DB files.
- **Spotlight mirror** — mirror notes so they're findable in macOS Spotlight (toggle).
- **Export data** — *Export JSON* writes all your data (tasks, habits, finance, knowledge index)
  to a JSON file.
- **Danger zone** — wipe / reset controls (destructive; clearly separated and confirmed).

## Quick Capture
- **Global shortcut** — a recorder to bind the system-wide hotkey that opens the tray
  [quick-capture](Search-and-Command-Palette#tray-quick-capture) popover from anywhere in macOS.

## AI assist (optional)
All AI is opt-in and local-first.
- **Use local Ollama for knowledge suggestions** — toggle; *"no data leaves your device."*
- **Ollama status** — shows Running / Not detected with a *Refresh* re-check and an **Install** link
  to ollama.ai when not present.
- **Model** — pick which Ollama model handles suggestion extraction (shown when Ollama is running).
- **Semantic search** — configure the dedicated embedding model and rebuild the embeddings index
  for [Knowledge Base](Knowledge-Base#search) semantic search.
- **Ask Compass** — set / clear your BYO **Anthropic** or **OpenAI** key and pick the active
  provider/model for [Ask Compass](Ask-Compass). The key is encrypted and never re-crosses the IPC
  boundary; only a masked tail is shown.

## Updates
- **Check for updates** — shows the current version and a *Check now* button. Compass also checks
  automatically (see [Backup & Restore → Updates](Backup-and-Restore#updates)).

## Encrypted Backup
- Create and restore **passphrase-encrypted** backups of your entire store. See
  [Backup & Restore](Backup-and-Restore).

## Related

- [Vault](Vault) · [Ask Compass](Ask-Compass) · [Backup & Restore](Backup-and-Restore) · [Security & Privacy](Security-and-Privacy)
