---
"compass": patch
---

Fix the macOS "Restart to Install" auto-update loop. CI publishes unsigned mac builds (CSC_LINK / CSC_KEY_PASSWORD aren't set on the repo), and Squirrel.Mac silently refuses to install unsigned bundles — so `autoUpdater.quitAndInstall()` returned without doing anything, leaving the app re-downloading the same version on every launch.

Disabled `autoUpdater.autoDownload` and replaced the broken "Restart to Install" button with a "View on GitHub" link that opens the release page in the user's default browser. The new `updater:open-release-page` IPC validates the tag shape before calling `shell.openExternal` so a compromised renderer can't aim it at arbitrary URLs. Until macOS signing is wired into CI (separate effort), this keeps users informed of new releases without pretending the in-app updater works.
