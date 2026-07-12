# Apple Reminders integration — status & remaining work

**Status: spike landed, gated on notarization.** The backend + wiring are built,
unit-tested, and on `main`, but the integration ships as a **`connected: false`
"Coming Soon" stub** and cannot be turned on for end users until a signed +
notarized build is possible. This doc is the pick-up point.

Roadmap slot: Phase 7 Track B "task sync" (the last unshipped item in that
cluster, alongside the shipped Todoist + Things 3). See
[`docs/implementation_plan.md`](implementation_plan.md).

## Why Reminders is the hard one

Every other "local" integration reads a file directly — Things reads its SQLite,
Apple Calendar parses `~/Library/Calendars/**/*.ics`, iMessage reads `chat.db`.
**Reminders has no user-parseable on-disk store**: `~/Library/Reminders/` is
TCC-locked opaque Core Data. Reading it requires EventKit, and EventKit's macOS
permission prompt only fires reliably in a **signed + hardened-runtime +
notarized** build. Compass has none of that configured yet, which is the whole
reason this is a stub.

## What's already built (on `main`)

| File | What it is |
|---|---|
| `electron/integrations/apple-reminders.ts` (see #376) | `syncAppleReminders` (imports overdue/due-today reminders into today's daily checklist as `source='apple-reminders'`, self-gate / preserve-local-checked / prune — a clone of `things.ts`), the pure `normalizeReminders`, and `readReminders` (the read seam). |
| `electron/integrations/apple-reminders.test.ts` | Unit tests: normalize filtering, JXA parser + platform guard (injected `run`, never shells out), full sync pipeline, dispatch. |
| `electron/ipc/sync.ts` | `apple-reminders` in `SUPPORTED_SYNC_SERVICES`, the `sync:trigger` opt-in-flip branch, the `sync:trigger-all` fan-out, `serviceLabelFor`. |
| `electron/cron.ts` | `runSyncForService` dispatch branch. |
| [`src/lib/integration-registry.ts`](../src/lib/integration-registry.ts) | The `apple-reminders` entry — **`connected: false`** (Coming Soon stub). |
| `resources/entitlements.mac.plist` (see #376) | Prepared entitlements — **not referenced by any build config**, so zero effect on current releases. |

Reminders land on the `records` spine automatically via the existing generic
`projectTasks` — no per-source projector needed.

### The read seam (decide during Track 4)

`readReminders(run)` is deliberately behind one function so either mechanism can
win — the user's "decide during the spike" choice was to prototype both:

- **(A) JXA / `osascript` bridge — implemented.** Async `execFile` of
  `osascript -l JavaScript`; no native compilation. This is the current default.
- **(B) Native EventKit N-API addon — future.** A compiled Swift/ObjC addon
  (`EKEventStore.requestFullAccessToReminders`). More robust, native Reminders
  TCC, but a net-new native-build toolchain (node-gyp, arm64+x64, the
  better-sqlite3-style ABI rebuild dance). Slots in by replacing `readReminders`;
  `normalizeReminders`/`syncAppleReminders` don't change.

## What's still needed — Track 4 (the blocker)

**Hard prerequisite: an Apple Developer Program membership ($99/yr) — not yet
obtained.** Nothing below can be validated without it, because the macOS
permission prompt only appears in a signed + notarized build.

1. **Signing + notarization credentials** (one-time):
   - Developer ID Application certificate → base64 for `CSC_LINK` +
     `CSC_KEY_PASSWORD` (already read by [`.github/workflows/release.yml`](../.github/workflows/release.yml); today unset ⇒ unsigned).
   - App-specific password + Team ID for notarization.
   - Store all five as GitHub repo secrets.
2. **Activate the entitlements** — add to `package.json` `build.mac` (see the
   header comment in [`resources/entitlements.mac.plist`](../resources/entitlements.mac.plist) for the exact block):
   `hardenedRuntime: true`, `entitlements` + `entitlementsInherit` pointing at
   the plist, and `extendInfo` with `NSRemindersUsageDescription`,
   `NSRemindersFullAccessUsageDescription` (macOS 14+), and
   `NSAppleEventsUsageDescription` (JXA path).
   ⚠️ **Do not activate piecemeal** — hardened runtime *without* notarization
   only makes Gatekeeper harsher, it doesn't make the prompt work.
3. **Enable notarization in CI** — uncomment the `APPLE_ID` / `APPLE_TEAM_ID` /
   `APPLE_APP_SPECIFIC_PASSWORD` env in `release.yml` (lines ~44–47) and add a
   `notarize` block (electron-builder 26 notarizes via `@electron/notarize`,
   already a transitive dep, when these are present).
4. **The signed-build test loop** (the actual validation — no dev shortcut for
   TCC; budget minutes per notarized build):
   1. Tag a pre-release (e.g. `v1.x.0-rc.1`) → `release.yml` produces a signed +
      notarized dmg.
   2. Install on a **clean Mac / fresh user account** (pristine TCC state).
   3. Connect the integration → confirm the **Reminders permission prompt fires**,
      grant it.
   4. Verify reminders import into today's checklist + appear on the Timeline.
   5. Revoke access in System Settings → confirm graceful degradation (clear
      error, no crash).
   6. Iterate — every entitlement / Info.plist / read-mechanism change needs a
      fresh notarized build.
5. **Flip it on** — once validated: set `connected: true` in the registry, add
   the matching `apple-reminders` entry to
   [`src/lib/integration-setup.ts`](../src/lib/integration-setup.ts)
   (`authKind: 'local-file'`, `fields: []`, `connectLabel: 'Connect & sync'`,
   Reminders-permission prerequisites — the `integration-setup.test.ts` parity
   test **requires** a setup entry for a `connected: true` card), and pick
   JXA-vs-native based on what survived the notarized build.

## Deferred (not part of this feature)

- **Write-back** (completing a reminder in Compass → Apple Reminders) — read-only
  for now, a separate later slice.
