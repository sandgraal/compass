# Vault

**Route:** `/vault` · **Sidebar:** Vault · **⌘K:** "Vault"

The Vault is Compass's encrypted store for your most sensitive data — the stuff that must never sit
in plaintext on disk. It is **separate from the SQLite database and the knowledge base**.

## What goes in the Vault

Six built-in categories, each with field templates:

- **Financial** — account numbers, routing details, card data
- **Identity** — IDs, passport/SSN-type data
- **Credentials** — logins, passwords, keys
- **Medical** — health records, prescriptions
- **Legal** — documents, references
- **Foreign Accounts** — FBAR/FATCA: foreign bank/securities account numbers and institutions
  (identifiers stay vault-only; the FBAR/FATCA summary computes max-aggregate values without ever
  reading them)

Each entry has an `id`, `createdAt`, `updatedAt`, plus category-specific fields. You can add new
categories with field templates — see the [Developer Guide](Developer-Guide#adding-a-vault-category).

## How encryption works

- Each category is stored as its own encrypted blob: `.vault/<category>.enc`.
- **AES-256-GCM**, with a random 16-byte IV prepended and a 16-byte auth tag — per blob.
- The **master key** is generated once and sealed by the **OS Keychain** via Electron's
  `safeStorage`, stored at `.vault/key.enc`. **Plaintext secrets never touch the disk.** The key
  never leaves the Keychain except to be decrypted in the main process.
- Status indicator: *"Keys in OS Keychain."*

## Using it

- **Unlock / lock** — the Vault locks itself (empty state: *"Vault is locked"*). Auto-lock timeout
  is configurable in [Settings](Settings#security--privacy) (from 1 minute up to 1 hour, or manual).
- **Add / edit / delete entries** per category.
- **History** — each entry keeps up to 5 prior versions, snapshotted on update, so you can recover
  a previous value.
- **Import** — bring in credentials from a **1Password CSV export**.

## Screenshot protection

While the Vault page is open, Compass calls `setContentProtection(true)`, which **blocks macOS
screenshots and screen recording** of the window. It's turned back off when you leave the page.

## What the Vault is *not*

- It is **never exposed to Claude / MCP**, to Ask Compass, or to any AI surface — categorically
  excluded by design (see [Security & Privacy](Security-and-Privacy)).
- It is not for general notes — use the [Knowledge Base](Knowledge-Base) for those.

## Where it lives

| What | Where |
|---|---|
| Encrypted category blobs | `.vault/<category>.enc` |
| Sealed master key | `.vault/key.enc` (OS Keychain via `safeStorage`) |

## Related

- [Security & Privacy](Security-and-Privacy) — the full threat model.
- [Backup & Restore](Backup-and-Restore) — vault data is included in encrypted backups.
