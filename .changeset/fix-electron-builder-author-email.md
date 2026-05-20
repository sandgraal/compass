---
"compass": patch
---

Fix the `v0.3.0` Linux release leg — `package.json#author` needs to be the object form (with `email`) so electron-builder can populate the `.deb` package's `Maintainer` header. Without it, the Linux job fails after the macOS and Windows artifacts are already published.
