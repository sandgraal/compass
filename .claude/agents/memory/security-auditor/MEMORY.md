# Security auditor memory

> Persistent project memory for the `security-auditor` subagent. Phase 0++.5.
> The agent reads this file at the start of every run and appends new entries at the end of every run.

## How to use this file

- **At start:** Skim every section. Carry context forward — past findings, accepted risks, known-safe patterns.
- **At end:** Append a dated entry under "Run log". If a finding from a prior run was resolved, edit the original entry inline (don't delete — strike through with `~~text~~` so the audit trail survives).
- **Never store secrets, tokens, or PII here.** This file lives in the repo (`.claude/agents/memory/`) — treat it as public.

## Accepted risks (do not re-flag)

> Findings the user has explicitly acknowledged as out-of-scope or accepted. Cite the run that established each.

_(empty — first run will populate)_

## Known-safe patterns

> Patterns that look concerning but are intentional. Examples: a `// @ts-ignore` on a Node↔Electron stub, a SQL string concatenation that's actually a column name from a closed allowlist.

_(empty — first run will populate)_

## Recurring issues

> Findings that keep coming back. If the same regression appears in multiple PRs, write a note about *why* (lint rule missing, no test, easy to forget).

_(empty — first run will populate)_

## Threat-model deltas

> Changes to the threat model itself: new attack surface (e.g., new MCP server, new IPC channel), retired surface (e.g., `development` Plaid env), or new mitigations (e.g., CSP tightening).

_(empty — first run will populate)_

## Run log

> One entry per audit run. Date · scope · top findings · status.

_(empty — first run will populate)_
