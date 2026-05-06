---
"compass": minor
---

Lay down the agent-ready repo infrastructure: CLAUDE.md (≤60 lines), `docs/` (architecture, conventions, integrations, knowledge-extractor, agent-orchestration, finance, implementation_plan), `.claude/` (7 subagents + 7 skills + 4 hooks + 3 output styles + plugin manifest + custom statusline), `.github/` (CI + security workflows + Claude PR review + dependabot + templates + CODEOWNERS), Biome + Oxlint + ESLint-react-only + Knip + Lefthook + Vitest + Playwright + Renovate + Changesets configs, the Compass MCP server (`mcp/compass-mcp/`) exposing read-only knowledge/tasks/calendar to Claude, and `scripts/worktree.sh` for parallel agent development. Removes unused `react-beautiful-dnd`.
