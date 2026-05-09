import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import chokidar from 'chokidar'
import { and, eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { knowledgeFiles, knowledgeSuggestions } from '../db/schema'
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
    const fullPath = join(KNOWLEDGE_DIR, relativePath)
    if (!fullPath.startsWith(KNOWLEDGE_DIR)) throw new Error('Path traversal blocked')
    if (!existsSync(fullPath)) return null
    return readFileSync(fullPath, 'utf8')
  })

  ipcMain.handle('knowledge:write-file', (_event, relativePath: string, content: string) => {
    const fullPath = join(KNOWLEDGE_DIR, relativePath)
    if (!fullPath.startsWith(KNOWLEDGE_DIR)) throw new Error('Path traversal blocked')
    writeFileSync(fullPath, content, 'utf8')
    return { success: true }
  })

  ipcMain.handle('knowledge:create-file', (_event, relativePath: string, title: string) => {
    const fullPath = join(KNOWLEDGE_DIR, relativePath)
    if (!fullPath.startsWith(KNOWLEDGE_DIR)) throw new Error('Path traversal blocked')
    if (existsSync(fullPath)) throw new Error('File already exists')
    writeFileSync(fullPath, `# ${title}\n\n`, 'utf8')
    return { success: true }
  })

  ipcMain.handle('knowledge:delete-file', (_event, relativePath: string) => {
    const fullPath = join(KNOWLEDGE_DIR, relativePath)
    if (!fullPath.startsWith(KNOWLEDGE_DIR)) throw new Error('Path traversal blocked')
    if (existsSync(fullPath)) unlinkSync(fullPath)
    // Remove any stale .prev backup so it doesn't appear on a future re-creation
    const prevPath = `${fullPath}.prev`
    if (existsSync(prevPath)) unlinkSync(prevPath)
    return { success: true }
  })

  ipcMain.handle('knowledge:get-prev', (_event, relativePath: string) => {
    // Sanitize path
    if (relativePath.includes('..')) return null
    const prevPath = join(KNOWLEDGE_DIR, `${relativePath}.prev`)
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
      const alreadyPresent = existing
        .replace(/\r\n/g, '\n')
        .split('\n')
        .some((line) => line.trimEnd() === suggestion.proposedContent.trimEnd())
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
}
