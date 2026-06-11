/**
 * Builds the one-click Claude Desktop extension (.mcpb) for compass-mcp
 * (Phase 8.3).
 *
 * Steps:
 *   1. esbuild-bundle mcp/compass-mcp/index.ts → dist/mcpb/staging/server/index.mjs
 *      (single ESM file, node20 target; better-sqlite3 stays external — native)
 *   2. npm-install better-sqlite3 (prod-only) into the staging dir so the
 *      platform-prebuilt binding ships INSIDE the bundle
 *   3. write manifest.json (version synced from the root package.json)
 *   4. validate + pack via @anthropic-ai/mcpb → dist/compass-mcp-<os>-<arch>.mcpb
 *   5. smoke-test: boot the bundled server with COMPASS_HOME pointed at the
 *      staging dir (never real data) and exchange an MCP initialize handshake,
 *      which proves the native binding loads. Skipped for cross-arch builds.
 *
 * Usage:  npm run build:mcpb [-- --arch arm64|x64]
 *
 * The native binding is fetched for the CURRENT Node ABI — build with the
 * same major Node that Claude Desktop bundles (see mcp/compass-mcp/README.md).
 * Cross-ARCH builds on the same OS work (npm_config_arch steers
 * prebuild-install); cross-OS builds do not.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packExtension } from '@anthropic-ai/mcpb/cli'
import { validateManifest } from '@anthropic-ai/mcpb/node'
import { build } from 'esbuild'
import { buildMcpbManifest } from '../mcp/compass-mcp/mcpb-manifest.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAGING = join(ROOT, 'dist', 'mcpb', 'staging')

function parseArch(): NodeJS.Architecture {
  const i = process.argv.indexOf('--arch')
  if (i === -1) return process.arch
  const arch = process.argv[i + 1]
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`--arch must be arm64 or x64, got "${arch}"`)
  }
  return arch
}

async function bundleServer(): Promise<void> {
  await build({
    entryPoints: [join(ROOT, 'mcp', 'compass-mcp', 'index.ts')],
    outfile: join(STAGING, 'server', 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['better-sqlite3'],
    // Some transitive CJS deps do dynamic require() of node builtins; in ESM
    // output esbuild leaves those as bare `require`, so provide one.
    banner: {
      js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);"
    }
  })
}

function installNativeDep(targetArch: string): void {
  const mcpPkg = JSON.parse(
    readFileSync(join(ROOT, 'mcp', 'compass-mcp', 'package.json'), 'utf8')
  ) as { dependencies: Record<string, string> }
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string
  }

  writeFileSync(
    join(STAGING, 'package.json'),
    `${JSON.stringify(
      {
        name: 'compass-mcp-bundle',
        version: rootPkg.version,
        private: true,
        type: 'module',
        dependencies: { 'better-sqlite3': mcpPkg.dependencies['better-sqlite3'] }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: STAGING,
    stdio: 'inherit',
    env: { ...process.env, npm_config_arch: targetArch }
  })
}

/**
 * Boots the bundled server and exchanges an MCP initialize handshake.
 * better-sqlite3's binding loads at import time, so a successful response
 * proves the native module inside the bundle works on this machine.
 */
function smokeTest(serverPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      // Point COMPASS_HOME at the staging dir so the smoke test can never
      // touch real user data (the DB simply won't exist there).
      env: { ...process.env, COMPASS_MCP_BUNDLED: '1', COMPASS_HOME: STAGING },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('smoke test timed out waiting for initialize response'))
    }, 15000)
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('"result"')) {
        clearTimeout(timer)
        child.kill()
        resolve()
      }
    })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer)
        reject(new Error(`bundled server exited with code ${code}:\n${err}`))
      }
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'build-smoke-test', version: '0' }
        }
      })}\n`
    )
  })
}

async function main(): Promise<void> {
  const targetArch = parseArch()
  const version = (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version
  const outFile = join(ROOT, 'dist', `compass-mcp-${process.platform}-${targetArch}.mcpb`)

  console.log(`[mcpb] building compass-mcp ${version} for ${process.platform}-${targetArch}`)
  rmSync(STAGING, { recursive: true, force: true })
  mkdirSync(STAGING, { recursive: true })

  await bundleServer()
  installNativeDep(targetArch)

  const manifestPath = join(STAGING, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(buildMcpbManifest(version), null, 2)}\n`, 'utf8')
  if (!validateManifest(manifestPath)) {
    throw new Error('manifest failed schema validation')
  }

  if (targetArch === process.arch) {
    await smokeTest(join(STAGING, 'server', 'index.mjs'))
    console.log('[mcpb] smoke test passed — bundled server answered initialize')
  } else {
    console.log(`[mcpb] cross-arch build (${process.arch} → ${targetArch}) — smoke test skipped`)
  }

  const ok = await packExtension({ extensionPath: STAGING, outputPath: outFile, silent: false })
  if (!ok) throw new Error('mcpb pack failed')
  console.log(`[mcpb] wrote ${outFile}`)
}

main().catch((err) => {
  console.error('[mcpb] build failed:', err)
  process.exit(1)
})
