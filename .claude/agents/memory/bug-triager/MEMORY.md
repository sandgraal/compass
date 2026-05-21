# Bug triager memory

> Persistent project memory for the `bug-triager` subagent. Phase 0++.5.
> The agent reads this file at the start of every run and appends new entries at the end of every run.

## How to use this file

- **At start:** Skim every section. Skip re-reporting items already on the punch list or accepted as out-of-scope.
- **At end:** Append a dated entry under "Run log". When an item is resolved, edit the original entry inline (`~~text~~` so the trail survives).
- **No secrets, tokens, or PII.** This file is in the repo.

## Persistent punch list

> Items that surfaced in a prior run, were neither fixed nor explicitly accepted, and are still open. Each entry is `<file>:<line>` + one-line why. When fixed, strike through with `~~text~~` and note the commit.

_(empty — first run will populate)_

## Accepted out-of-scope

> Items the user has acknowledged but decided not to fix. Don't re-report. Cite the run that established the decision.

_(empty — first run will populate)_

## Known patterns (skip these in future)

> Things that look like bugs but aren't. Examples: an `any` cast in a Node↔Electron preload stub, an empty `catch {}` that's intentional (load-bearing comment present), a `// TODO` that's actually a deferred feature with a PR linked.

_(empty — first run will populate)_

## Recurring categories

> Categories of bugs the project keeps re-introducing. Useful for noting *why* (e.g., "missing biome rule X", "no test coverage in area Y").

_(empty — first run will populate)_

## Run log

> One entry per triage run. Date · scope · top findings · status.

_(empty — first run will populate)_
