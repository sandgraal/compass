# Compass Mobile (Phase 4c)

A **read-only companion** for Compass: it pulls the device-sync encrypted snapshot from your
relay, decrypts it **on the phone**, and renders a summary + timeline. Nothing plaintext is
written to disk; the sync passphrase lives in the OS keychain (expo-secure-store); the relay
only ever sees ciphertext.

Standalone Expo app — deliberately **not** an npm workspace (same pattern as `relay/`), so it
can't disturb the Electron build's dependency tree.

## How it fits

```
Desktop Compass ── push ──▶ relay /sync/blob/<groupId> ── pull ──▶ this app
   (encrypts: scrypt + AES-256-GCM;      (ciphertext mailbox)      (decrypts on-device,
    the v3 .compass-backup bundle)                                  renders read-only)
```

- **Crypto compatibility is pinned by the root repo**: `electron/ipc/backup-mobile-compat.test.ts`
  encrypts with the real desktop code and decrypts with `src/lib/snapshot.ts`, and asserts both
  sides derive the identical sync group id. Change either side and CI goes red.
- Pure-JS crypto (`@noble/hashes` scrypt + `@noble/ciphers` AES-GCM) — runs in Expo Go, no
  native modules, no prebuild.

## Run

```bash
cd mobile
npm install
npm start          # Expo dev server → scan the QR with Expo Go
```

Setup screen inputs:

| Field | Where it comes from |
|---|---|
| Relay URL | your deployed relay (the desktop's Settings → Device Sync shows it) |
| Device token | a token in the relay's `RELAY_CLIENT_TOKENS` allowlist (each device gets its own) |
| Sync passphrase | the SAME passphrase you set in desktop Settings → Device Sync (min 12 chars) |

Then push a snapshot from the desktop (Settings → Device Sync → Push now) and tap **Sync**.

## Status / caveats

- **Read-only.** Quick capture / write-back is the explicitly deferred next slice (writes from
  mobile need merge handling the snapshot+LWW model doesn't have).
- **The decrypt/parse core and selectors are CI-tested from the root repo; the UI itself is
  not yet validated on a physical device** (no simulator in the dev harness). The screens are
  intentionally minimal until that pass happens.
- Pure-JS scrypt takes ~1–2s on a phone per sync (key derivation) — expected, one-time per pull.
- Snapshots over 256 MB are refused by the viewer (`src/lib/relay.ts`).
