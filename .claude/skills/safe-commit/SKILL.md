---
name: safe-commit
description: Pre-commit gauntlet — runs typecheck + Biome check + tests, drafts a conventional-commit message based on the staged diff, asks the user to confirm, then commits with the standard Co-Author-By trailer. Auto-loads when user asks to commit, "save my work", or wrap up a feature.
---

# Safe commit

## Workflow

### 1. Pre-flight
```bash
git status
git diff --cached
```

If nothing is staged, suggest `git add` first (specific files; never `git add .` or `-A`).

### 2. Verify
Run in this order — STOP at the first failure:
```bash
npm run typecheck    # both renderer and main
npm run check        # Biome lint + format
npm test             # Vitest
```

If anything fails:
- Print the error
- Either fix it (if obvious) or ask the user how they want to proceed
- DO NOT commit failing code

### 3. Draft commit message

Read the diff and craft a Conventional Commit:
- `feat: <user-visible capability>`
- `fix: <bug fixed>`
- `chore: <infra/build/deps>`
- `docs: <docs-only>`
- `refactor: <no behavior change>`
- `test: <tests-only>`

Subject line ≤ 72 chars, imperative mood ("add", not "added").

Body (only if needed):
- One paragraph explaining WHY (not WHAT — the diff shows what)
- Bullet list of changes if multi-area

Footer ALWAYS includes:
```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

### 4. Show the user, get confirmation
Don't commit silently. Show the proposed message and ask "Commit?".

### 5. Commit
```bash
git commit -m "$(cat <<'EOF'
<subject>

<body>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

### 6. Report
```
✅ Committed <hash>: <subject>
   - <N> files changed
   - typecheck ✓ check ✓ tests ✓ (<count> passing)
```

## Hard rules

- **Never commit failing code.** Tests/lint/typecheck must pass.
- **Never `git add .` or `-A`.** Stage specific files (less surface for accidentally committing `.env`).
- **Never `--no-verify`.** Pre-commit hooks exist for a reason.
- **Never `--amend` without explicit user request** — easier to revert a bad commit than to recover an amended one.
- **Always include Co-Authored-By** for Claude-touched commits.
- **Don't push** unless the user asks — committing and pushing are separate intentional acts.
