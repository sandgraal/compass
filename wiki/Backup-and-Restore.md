# Backup & Restore

This page covers getting your data out, bringing it back, and keeping the app up to date — all
from [Settings](Settings).

## Encrypted backup

**Settings → Encrypted Backup.**

- **Create** — produces a single backup file of your entire store, encrypted with a **passphrase**
  you choose (passphrase-derived **AES-256-GCM**). Handlers: `backup:create`.
- **Restore** — point Compass at a backup file and supply the passphrase to restore
  (`backup:restore`).
- The passphrase is **not stored** — if you lose it, the backup can't be decrypted. Keep it safe.

Because the backup is encrypted, you can store it anywhere (external drive, cloud storage) without
exposing your data.

## Plain JSON export

**Settings → Data → Export data → Export JSON.**

Writes all your structured data (tasks, habits, finance, knowledge index) to a plain JSON file. This
is **not encrypted** — it's for portability, scripting, and migration, not secure archival. Use the
encrypted backup above for anything sensitive.

## Open the data folder

**Settings → Data → Open data folder → Open in Finder** opens your store
(`~/Library/Application Support/Compass/`) so you can copy the raw files yourself — the markdown
knowledge base in particular is plain files you can back up with any tool. See
[Data & Storage Reference](Data-and-Storage-Reference).

## Wipe / reset

The **Danger zone** in Settings → Data provides destructive reset controls. These are clearly
separated and require confirmation — they remove local data and cannot be undone (so make a backup
first).

## Updates

Compass auto-updates from GitHub Releases (`electron-updater`):

- Checks **~3 seconds after launch**, then **every 4 hours**.
- Downloads the new version silently in the background.
- Shows an **Update banner** with **Restart to Install** when ready.
- You can also force a check from **Settings → Updates → Check now** (it shows your current version).

Releases are built and signed by GitHub Actions; macOS auto-updates require signed builds. For the
release pipeline, see the [Developer Guide](Developer-Guide#release-flow).

## Related

- [Settings](Settings) · [Security & Privacy](Security-and-Privacy) · [Data & Storage Reference](Data-and-Storage-Reference)
