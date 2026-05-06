import { IpcMain } from 'electron'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join, relative, extname, basename } from 'path'
import chokidar from 'chokidar'
import { KNOWLEDGE_DIR } from '../paths'
import { getDb } from '../db/client'
import { knowledgeFiles } from '../db/schema'
import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'

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
    } catch { /* ignore */ }
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
    const prevPath = fullPath + '.prev'
    if (existsSync(prevPath)) unlinkSync(prevPath)
    return { success: true }
  })

  ipcMain.handle('knowledge:get-prev', (_event, relativePath: string) => {
    // Sanitize path
    if (relativePath.includes('..')) return null
    const prevPath = join(KNOWLEDGE_DIR, relativePath + '.prev')
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
}
