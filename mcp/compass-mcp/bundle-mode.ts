/**
 * Bundled-desktop-extension mode (Phase 8.3).
 *
 * The one-click `.mcpb` bundle ships the compiled server WITHOUT the Compass
 * repo around it, so the two self-knowledge tools that introspect the source
 * tree (git log, test inventory) cannot work there. The bundle's manifest
 * sets COMPASS_MCP_BUNDLED=1; in that mode those tools are dropped from
 * tools/list and their handlers answer with a clear error instead of a
 * confusing git/ENOENT failure. Everything else (DB reads, knowledge reads,
 * proposal enqueue) works identically in both modes.
 */

export const REPO_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'compass_recent_commits',
  'compass_test_status'
])

export function isBundled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPASS_MCP_BUNDLED === '1'
}

export function filterToolsForBundle<T extends { name: string }>(
  tools: readonly T[],
  bundled: boolean
): T[] {
  return bundled ? tools.filter((t) => !REPO_ONLY_TOOLS.has(t.name)) : [...tools]
}
