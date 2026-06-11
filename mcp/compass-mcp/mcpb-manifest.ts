/**
 * MCPB manifest for the one-click Claude Desktop extension (Phase 8.3).
 *
 * Pure builder so the manifest is unit-testable against the official schema
 * (`@anthropic-ai/mcpb`'s v0.3 JSON schema) without running the packaging
 * script. `scripts/build-mcpb.ts` calls this with the root package.json
 * version and writes the result into the staging dir before packing.
 */

export function buildMcpbManifest(version: string) {
  return {
    manifest_version: '0.3',
    name: 'compass-mcp',
    display_name: 'Compass',
    version,
    description:
      'Read + propose tools over your local Compass data: tasks, calendar, knowledge base, finance summaries, habit streaks.',
    long_description:
      'Connects Claude Desktop to the Compass app on this machine. Read tools open the local ' +
      'Compass database read-only (vault excluded; finance exposed as aggregates, never raw ' +
      'rows). Write tools never mutate anything directly — they enqueue proposals that you ' +
      'approve or reject in the Compass app (Claude Inbox). Requires the Compass app to be ' +
      'installed; all data stays on this machine.',
    author: { name: 'sandgraal' },
    repository: { type: 'git', url: 'https://github.com/sandgraal/compass' },
    homepage: 'https://github.com/sandgraal/compass',
    license: 'UNLICENSED',
    keywords: ['compass', 'life-os', 'tasks', 'calendar', 'knowledge', 'finance', 'habits'],
    server: {
      type: 'node',
      entry_point: 'server/index.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.mjs'],
        // Drops the repo self-knowledge tools (git log / test inventory) —
        // there is no source checkout inside the bundle. See bundle-mode.ts.
        env: { COMPASS_MCP_BUNDLED: '1' }
      }
    },
    // Compass itself is macOS-first (its app-data path is
    // ~/Library/Application Support/Compass), so the bundle is too.
    compatibility: { platforms: ['darwin'], runtimes: { node: '>=20' } }
  }
}
