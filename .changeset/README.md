# Changesets

Every PR includes a `.changeset/<slug>.md` describing the user-visible change and the version bump type. Run `npx changeset` to generate one interactively.

Format:

```
---
"compass": minor
---

Add Notion integration with read-only page sync.
```

Bump types:
- `major` — breaking change
- `minor` — new feature
- `patch` — bug fix or polish

The `safe-commit` skill prompts you to run this if your change is user-facing.
