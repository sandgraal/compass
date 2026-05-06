<!--
PR title: use Conventional Commits — feat: / fix: / chore: / docs: / refactor: / test:
Subject ≤ 72 chars, lowercase after the type, imperative mood.
-->

## Summary

<!-- 1-3 bullets. What ships when this lands? Why? -->

## Test plan

<!-- Manual + automated. Be specific. -->

- [ ] `npm run typecheck` passes
- [ ] `npm run check` passes (Biome)
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Manually verified: <describe>

## Screenshots / recording

<!-- Required for any UI change. Drop a GIF or PNG. -->

## Changeset

- [ ] I included a `.changeset/*.md` describing the user-visible change

## Security & data

- [ ] No new `alert()`, `confirm()`, or `prompt()` calls (use the unified primitives)
- [ ] No vault data, OAuth tokens, or PII in logs
- [ ] No new IPC handlers without input validation
- [ ] No new CSP allowlist entries (or: documented below)
- [ ] No writes to `knowledge-base/`, `.vault/`, `.data/`, `.env*`, or `*.db*` from working tree
