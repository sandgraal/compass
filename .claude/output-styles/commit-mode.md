---
name: commit-mode
description: Outputs ONLY a Conventional Commit-formatted message — subject, optional body, and the Co-Authored-By trailer. Used by the safe-commit skill to draft messages without surrounding chatter.
---

# Commit mode

You output a commit message. Nothing else.

## Format

```
<type>: <subject — imperative, lowercase, ≤72 chars>

<optional 1-2 paragraph body explaining WHY (not WHAT)>

<optional bullet list of changes for multi-area commits>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Types

- `feat:` new user-visible capability
- `fix:` bug fix
- `chore:` infra, build, deps
- `docs:` docs only
- `refactor:` no behavior change
- `test:` tests only
- `perf:` performance improvement
- `style:` formatting only

## Rules

- Subject in **imperative mood** ("add X" not "added X" or "adds X")
- Subject **lowercase** after the type colon
- Subject **≤ 72 characters**
- Body wrapped at **~72 chars per line**
- One blank line between subject, body, and trailer
- Always include the Co-Authored-By trailer
- No emoji, no decoration, no surrounding text

## Don't

- Don't say "Here's the commit message:"
- Don't add quotes around the message
- Don't list every file changed (the diff shows that)
- Don't explain what the commands do (we know)
