import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import chokidar from 'chokidar'
import { and, eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { appSettings, knowledgeFiles, knowledgeSuggestions } from '../db/schema'
import {
  DEFAULT_EMBED_MODEL,
  buildEmbeddingsIndex,
  loadIndex,
  saveIndex,
  semanticSearch
} from '../knowledge/embeddings'
import { KNOWLEDGE_DIR } from '../paths'

// Target paths that are user-owned and safe to auto-append via suggestions
const SUGGESTION_ALLOWED_TARGETS = new Set(['profile/relationships.md', 'work/employers.md'])

let watcher: ReturnType<typeof chokidar.watch> | null = null

export interface KnowledgeFile {
  path: string
  title: string
  category: string
  lastModified: number
  wordCount: number
  autoUpdated: boolean
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Resolve `relativePath` against `KNOWLEDGE_DIR` and throw if it escapes
 * the base. Replaces the old `startsWith(KNOWLEDGE_DIR)` check, which was
 * vulnerable to a prefix-substring bypass: a path like
 * `../compass-kb-2/evil.md` would resolve to `/parent/compass-kb-2/evil.md`,
 * which `startsWith('/parent/compass-kb')` returned `true` for even though
 * the resolved path lives outside the base.
 *
 * The fix uses `path.relative` semantics: if the resolved path is truly
 * inside the base, the relative path between the two doesn't start with
 * `..` and isn't absolute. Same idiom recommended by Node's path docs
 * and used by every well-known path-containment helper.
 *
 * Returns the absolute resolved path so callers can read/write directly.
 */
function safeJoin(base: string, relativePath: string): string {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(resolvedBase, relativePath)
  const rel = relative(resolvedBase, resolvedTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path traversal blocked')
  }
  return resolvedTarget
}

function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : basename(filename, '.md')
}

function getCategory(relativePath: string): string {
  const parts = relativePath.split('/')
  return parts[0] || 'general'
}

function walkDir(dir: string, base: string): KnowledgeFile[] {
  const results: KnowledgeFile[] = []
  if (!existsSync(dir)) return results

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base))
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const relPath = relative(base, fullPath)
      const content = readFileSync(fullPath, 'utf8')
      const stat = statSync(fullPath)
      results.push({
        path: relPath,
        title: extractTitle(content, entry.name),
        category: getCategory(relPath),
        lastModified: stat.mtimeMs,
        wordCount: countWords(content),
        autoUpdated: false
      })
    }
  }
  return results
}

export function startKnowledgeWatcher(mainWindow: BrowserWindow | null): void {
  if (watcher) watcher.close()

  watcher = chokidar.watch(KNOWLEDGE_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500 }
  })

  watcher.on('change', (filePath: string) => {
    const relPath = relative(KNOWLEDGE_DIR, filePath)
    mainWindow?.webContents.send('knowledge:file-changed', relPath)
    // Update word count in DB
    try {
      const content = readFileSync(filePath, 'utf8')
      const db = getDb()
      db.update(knowledgeFiles)
        .set({ wordCount: countWords(content), lastModified: new Date() })
        .where(eq(knowledgeFiles.path, relPath))
        .run()
    } catch {
      /* ignore */
    }
  })
}

export function registerKnowledgeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('knowledge:list-files', () => {
    return walkDir(KNOWLEDGE_DIR, KNOWLEDGE_DIR)
  })

  ipcMain.handle('knowledge:read-file', (_event, relativePath: string) => {
    const fullPath = safeJoin(KNOWLEDGE_DIR, relativePath)
    if (!existsSync(fullPath)) return null
    return readFileSync(fullPath, 'utf8')
  })

  ipcMain.handle('knowledge:write-file', (_event, relativePath: string, content: string) => {
    const fullPath = safeJoin(KNOWLEDGE_DIR, relativePath)
    writeFileSync(fullPath, content, 'utf8')
    return { success: true }
  })

  ipcMain.handle('knowledge:create-file', (_event, relativePath: string, title: string) => {
    const fullPath = safeJoin(KNOWLEDGE_DIR, relativePath)
    if (existsSync(fullPath)) throw new Error('File already exists')
    // The unresolved-wikilink path drops files under `general/<slug>.md`,
    // but `general/` isn't one of the dirs `ensureDirectories()` seeds.
    // Create the parent so the first wikilink on a fresh profile works
    // instead of failing silently with ENOENT. `safeJoin` above already
    // guaranteed `fullPath` lives inside KNOWLEDGE_DIR, so the parent
    // is necessarily a descendant of KNOWLEDGE_DIR too — no need for
    // a second containment check here.
    const parent = dirname(fullPath)
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true })
    }
    writeFileSync(fullPath, `# ${title}\n\n`, 'utf8')
    return { success: true }
  })

  ipcMain.handle('knowledge:delete-file', (_event, relativePath: string) => {
    const fullPath = safeJoin(KNOWLEDGE_DIR, relativePath)
    if (existsSync(fullPath)) unlinkSync(fullPath)
    // Remove any stale .prev backup so it doesn't appear on a future re-creation
    const prevPath = `${fullPath}.prev`
    if (existsSync(prevPath)) unlinkSync(prevPath)
    return { success: true }
  })

  ipcMain.handle('knowledge:get-prev', (_event, relativePath: string) => {
    // Read-only sibling lookup: returns null instead of throwing on
    // bad input so the renderer's "show me the previous version" UI
    // can fail soft when the user navigates to anything weird.
    let prevPath: string
    try {
      prevPath = safeJoin(KNOWLEDGE_DIR, `${relativePath}.prev`)
    } catch {
      return null
    }
    if (!existsSync(prevPath)) return null
    return readFileSync(prevPath, 'utf8')
  })

  ipcMain.handle('knowledge:search', (_event, query: string) => {
    // Simple in-process full-text search across all markdown files
    const files = walkDir(KNOWLEDGE_DIR, KNOWLEDGE_DIR)
    const lq = query.toLowerCase()
    return files
      .map((f) => {
        const content = readFileSync(join(KNOWLEDGE_DIR, f.path), 'utf8')
        const matches = content.toLowerCase().includes(lq)
        if (!matches) return null
        // Find snippet around first match
        const idx = content.toLowerCase().indexOf(lq)
        const snippet = content.slice(Math.max(0, idx - 60), idx + 100).replace(/\n/g, ' ')
        return { ...f, snippet }
      })
      .filter(Boolean)
  })

  // Backlinks (May 2026 strategic-review Tier 1 #4).
  //
  // `[[link]]` semantics: a target is matched if the bracketed text equals
  //   - the file's title (the H1 line), case-insensitive, OR
  //   - the file's basename without `.md`, case-insensitive, OR
  //   - the file's relative path with or without the `.md` extension.
  //
  // We return one row per referencing file with a short snippet centred on
  // the matched `[[...]]` token. Heavy file ops live in the main process so
  // the renderer can render the panel synchronously off the result.
  ipcMain.handle('knowledge:get-backlinks', (_event, relativePath: string) => {
    if (typeof relativePath !== 'string') {
      return [] as Array<{ path: string; title: string; snippet: string }>
    }
    // Read-only: fail soft (return []) instead of throwing on a bad target.
    let targetFull: string
    try {
      targetFull = safeJoin(KNOWLEDGE_DIR, relativePath)
    } catch {
      return [] as Array<{ path: string; title: string; snippet: string }>
    }
    if (!existsSync(targetFull)) {
      return [] as Array<{ path: string; title: string; snippet: string }>
    }
    const targetContent = readFileSync(targetFull, 'utf8')
    const titleMatch = targetContent.match(/^#\s+(.+)$/m)
    const targetTitle = (titleMatch ? titleMatch[1].trim() : '').toLowerCase()
    const targetBasename = relativePath.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase()
    const targetPathNoExt = relativePath.replace(/\.md$/, '').toLowerCase()
    const targetPathLc = relativePath.toLowerCase()

    const aliases = new Set(
      [targetTitle, targetBasename, targetPathNoExt, targetPathLc].filter(Boolean)
    )

    const files = walkDir(KNOWLEDGE_DIR, KNOWLEDGE_DIR)
    const hits: Array<{ path: string; title: string; snippet: string }> = []
    const wikilinkRe = /\[\[([^\]]+)\]\]/g

    for (const f of files) {
      if (f.path === relativePath) continue
      const content = readFileSync(join(KNOWLEDGE_DIR, f.path), 'utf8')
      let m: RegExpExecArray | null
      let firstMatchIdx = -1
      wikilinkRe.lastIndex = 0
      while ((m = wikilinkRe.exec(content)) != null) {
        const inner = m[1].trim().toLowerCase()
        // Strip optional "|alias" — `[[foo|display]]` still links to foo.
        const target = inner.split('|')[0].trim()
        if (aliases.has(target)) {
          firstMatchIdx = m.index
          break
        }
      }
      if (firstMatchIdx === -1) continue
      const snippet = content
        .slice(Math.max(0, firstMatchIdx - 60), firstMatchIdx + 100)
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      hits.push({ path: f.path, title: f.title, snippet })
    }
    return hits
  })

  // ---- Knowledge Suggestions ----

  ipcMain.handle('knowledge:list-suggestions', (_event, targetPath?: string) => {
    const db = getDb()
    const rows = db
      .select()
      .from(knowledgeSuggestions)
      .where(
        targetPath
          ? and(
              eq(knowledgeSuggestions.status, 'pending'),
              eq(knowledgeSuggestions.targetPath, targetPath)
            )
          : eq(knowledgeSuggestions.status, 'pending')
      )
      .all()
    return rows
  })

  ipcMain.handle('knowledge:accept-suggestion', (_event, id: number) => {
    const db = getDb()
    const suggestion = db
      .select()
      .from(knowledgeSuggestions)
      .where(eq(knowledgeSuggestions.id, id))
      .get()

    if (!suggestion) throw new Error('Suggestion not found')
    if (suggestion.status !== 'pending') throw new Error('Suggestion already reviewed')

    // Path safety: only allow pre-approved target paths
    if (!SUGGESTION_ALLOWED_TARGETS.has(suggestion.targetPath)) {
      throw new Error('Target path not in allowlist')
    }

    const fullPath = join(KNOWLEDGE_DIR, suggestion.targetPath)
    if (!fullPath.startsWith(KNOWLEDGE_DIR)) throw new Error('Path traversal blocked')

    // Append the proposed content to the target file
    if (existsSync(fullPath)) {
      const existing = readFileSync(fullPath, 'utf8')
      const normalizedExisting = `\n${existing.replace(/\r\n/g, '\n')}\n`
      const normalizedProposedContent = suggestion.proposedContent.trimEnd()
      const alreadyPresent = normalizedExisting.includes(`\n${normalizedProposedContent}\n`)
      if (!alreadyPresent) {
        const separator = existing.endsWith('\n') ? '' : '\n'
        writeFileSync(fullPath, `${existing}${separator}${suggestion.proposedContent}\n`, 'utf8')
      }
    } else {
      writeFileSync(fullPath, `${suggestion.proposedContent}\n`, 'utf8')
    }

    db.update(knowledgeSuggestions)
      .set({ status: 'accepted', reviewedAt: new Date() })
      .where(eq(knowledgeSuggestions.id, id))
      .run()

    return { success: true }
  })

  ipcMain.handle('knowledge:dismiss-suggestion', (_event, id: number) => {
    const db = getDb()
    const suggestion = db
      .select()
      .from(knowledgeSuggestions)
      .where(eq(knowledgeSuggestions.id, id))
      .get()

    if (!suggestion) throw new Error('Suggestion not found')
    if (suggestion.status !== 'pending') return { success: true }

    db.update(knowledgeSuggestions)
      .set({ status: 'dismissed', reviewedAt: new Date() })
      .where(eq(knowledgeSuggestions.id, id))
      .run()

    return { success: true }
  })

  // ─── Semantic search via Ollama embeddings (Tier 2 #6) ──────────────────
  //
  // The build call runs entirely on the main process so the renderer
  // never owns the embedding index. We treat builds as serial — the
  // simple lock avoids two concurrent rebuilds racing on the JSON file.
  let buildInFlight: Promise<unknown> | null = null

  function readEmbeddingModelFromSettings(): string {
    try {
      const db = getDb()
      const row = db.select().from(appSettings).where(eq(appSettings.key, 'embeddingModel')).get()
      return row?.value && row.value.trim().length > 0 ? row.value : DEFAULT_EMBED_MODEL
    } catch {
      return DEFAULT_EMBED_MODEL
    }
  }

  ipcMain.handle('knowledge:get-embedding-status', () => {
    const index = loadIndex()
    if (!index) {
      return {
        builtAt: null,
        model: null,
        fileCount: 0,
        chunkCount: 0,
        building: buildInFlight !== null
      }
    }
    return {
      builtAt: index.builtAt,
      model: index.model,
      fileCount: Object.keys(index.fileMtimes).length,
      chunkCount: index.chunks.length,
      building: buildInFlight !== null
    }
  })

  ipcMain.handle('knowledge:rebuild-embeddings', async () => {
    if (buildInFlight) {
      return { success: false, error: 'A rebuild is already in progress' }
    }
    const model = readEmbeddingModelFromSettings()
    const promise = (async () => {
      try {
        const { index, result } = await buildEmbeddingsIndex({ model })
        saveIndex(index)
        return result
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err))
      }
    })()
    buildInFlight = promise
    try {
      const result = await promise
      // If every file failed (errors present but no usable chunks were built),
      // report the rebuild as failed so the renderer shows a meaningful error
      // rather than a successful-but-empty index.
      const hasUsableChunks = (result.totalChunks ?? 0) > 0
      const allFailed = (result.errors?.length ?? 0) > 0 && !hasUsableChunks
      if (allFailed) {
        return {
          success: false,
          error: `All files failed to embed: ${result.errors![0].message}`,
          ...result
        }
      }
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    } finally {
      buildInFlight = null
    }
  })

  ipcMain.handle('knowledge:semantic-search', async (_event, query: unknown) => {
    if (typeof query !== 'string') return { hits: [], reason: 'invalid-query' }
    if (query.length > 500) return { hits: [], reason: 'query-too-long' }
    const model = readEmbeddingModelFromSettings()
    try {
      const hits = await semanticSearch(query, { model })
      if (hits === null) return { hits: [], reason: 'index-missing' }
      return { hits }
    } catch (err) {
      return { hits: [], reason: 'ollama-error', error: (err as Error).message }
    }
  })
}
