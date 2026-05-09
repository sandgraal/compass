import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { type IpcMain, app, dialog, shell } from 'electron'
import { restartCronJobs } from '../cron'
import { getDb } from '../db/client'
import {
  appSettings,
  budgetRules,
  calendarEvents,
  categorizationRules,
  checklistItems,
  checklistTemplates,
  driveFiles,
  financeAccounts,
  financeTransactions,
  githubItems,
  gmailActions,
  habitEntries,
  habits,
  integrations,
  knowledgeFiles,
  syncEvents
} from '../db/schema'
import { restartQuickCaptureShortcut } from '../menu-bar'
import { DATA_DIR, KNOWLEDGE_DIR, VAULT_DIR } from '../paths'

const DEFAULTS: Record<string, string> = {
  theme: 'system',
  syncInterval: '15',
  knowledgeBaseLocation: 'default',
  showContextDrawer: 'true',
  notificationsEnabled: 'true',
  quickCaptureShortcut: 'CommandOrControl+Shift+Space'
}

/** Validates that a string looks like an Electron accelerator with at least one modifier. */
function isValidAccelerator(value: string): boolean {
  // Must be non-empty, contain at least one '+' separator, and end with a key name
  if (!value || !value.includes('+')) return false
  // Allowed modifier tokens (Electron accelerator spec)
  const modifiers = new Set([
    'Command',
    'Cmd',
    'Control',
    'Ctrl',
    'CommandOrControl',
    'CmdOrCtrl',
    'Alt',
    'Option',
    'AltGr',
    'Shift',
    'Super',
    'Meta'
  ])
  const parts = value.split('+').map((part) => part.trim())
  if (parts.length < 2) return false
  // All parts except the last must be recognised modifiers
  for (let i = 0; i < parts.length - 1; i++) {
    if (!modifiers.has(parts[i])) return false
  }
  // Final part must be a non-empty key name, not another modifier
  const key = parts[parts.length - 1]
  if (!key || modifiers.has(key)) return false
  return true
}

export function registerSettingsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('settings:get', (_event, key: string) => {
    const db = getDb()
    const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
    return row?.value ?? DEFAULTS[key] ?? null
  })

  ipcMain.handle('settings:get-all', () => {
    const db = getDb()
    const rows = db.select().from(appSettings).all()
    const result = { ...DEFAULTS }
    for (const row of rows) result[row.key] = row.value
    return result
  })

  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    const db = getDb()
    db.insert(appSettings)
      .values({ key, value: String(value), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: String(value), updatedAt: new Date() }
      })
      .run()
    if (key === 'syncInterval') {
      restartCronJobs()
    }
    return { success: true }
  })

  ipcMain.handle('settings:set-quick-capture-shortcut', (_event, accelerator: unknown) => {
    const chord = String(accelerator ?? '').trim()
    if (!isValidAccelerator(chord)) {
      return { success: false, error: `"${chord}" is not a valid accelerator string` }
    }

    const ok = restartQuickCaptureShortcut(chord)
    if (!ok) {
      return {
        success: false,
        error: `Could not register "${chord}" — it may be in use by another app or macOS`
      }
    }

    // Persist to DB only after successful registration
    const db = getDb()
    db.insert(appSettings)
      .values({ key: 'quickCaptureShortcut', value: chord, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: chord, updatedAt: new Date() }
      })
      .run()

    return { success: true }
  })

  // ---- Checklist handlers ----
  ipcMain.handle('checklist:get-items', (_event, listType: string, date: string) => {
    const db = getDb()
    return db
      .select()
      .from(checklistItems)
      .where(eq(checklistItems.listType, listType))
      .all()
      .filter((i) => i.listDate === date)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  })

  ipcMain.handle('checklist:add-item', (_event, item: Record<string, unknown>) => {
    const db = getDb()
    const result = db
      .insert(checklistItems)
      .values({
        listType: item.listType as string,
        listDate: item.listDate as string,
        title: item.title as string,
        body: item.body as string | undefined,
        category: (item.category as string) || 'personal',
        sortOrder: (item.sortOrder as number) || 0,
        source: (item.source as string) || 'manual',
        createdAt: new Date()
      })
      .returning()
      .get()
    return result
  })

  ipcMain.handle(
    'checklist:update-item',
    (_event, id: number, updates: Record<string, unknown>) => {
      const db = getDb()
      db.update(checklistItems).set(updates).where(eq(checklistItems.id, id)).run()
      return { success: true }
    }
  )

  ipcMain.handle('checklist:delete-item', (_event, id: number) => {
    const db = getDb()
    db.delete(checklistItems).where(eq(checklistItems.id, id)).run()
    return { success: true }
  })

  ipcMain.handle('checklist:roll-over', (_event, fromDate: string, toDate: string) => {
    const db = getDb()
    const unfinished = db
      .select()
      .from(checklistItems)
      .where(eq(checklistItems.listType, 'daily'))
      .all()
      .filter((i) => i.listDate === fromDate && !i.checked && i.source === 'manual')

    for (const item of unfinished) {
      db.insert(checklistItems)
        .values({
          listType: 'daily',
          listDate: toDate,
          title: item.title,
          body: item.body,
          category: item.category,
          sortOrder: item.sortOrder,
          source: 'manual',
          createdAt: new Date()
        })
        .run()
    }
    return { rolledOver: unfinished.length }
  })

  ipcMain.handle('checklist:get-template', (_event, listType: string) => {
    const db = getDb()
    const row = db
      .select()
      .from(checklistTemplates)
      .where(eq(checklistTemplates.listType, listType))
      .get()
    return row?.contentMd ?? getDefaultTemplate(listType)
  })

  ipcMain.handle('checklist:save-template', (_event, listType: string, content: string) => {
    const db = getDb()
    db.insert(checklistTemplates)
      .values({ listType, contentMd: content, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: checklistTemplates.listType,
        set: { contentMd: content, updatedAt: new Date() }
      })
      .run()
    return { success: true }
  })

  // Quick-capture: used only by the tray popover window
  ipcMain.handle('checklist:quick-add', (_event, title: string) => {
    try {
      const db = getDb()
      const today = new Date().toISOString().slice(0, 10)
      const trimmed = String(title).trim()
      if (!trimmed) return { success: false, error: 'Title cannot be empty' }
      db.insert(checklistItems)
        .values({
          listType: 'daily',
          listDate: today,
          title: trimmed.slice(0, 500),
          category: 'personal',
          sortOrder: 999,
          source: 'manual',
          createdAt: new Date()
        })
        .run()
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Data management ----
  ipcMain.handle('settings:open-data-dir', async () => {
    const error = await shell.openPath(DATA_DIR)
    if (error) return { success: false, error }
    return { success: true }
  })

  ipcMain.handle('settings:wipe-knowledge', () => {
    try {
      // Remove all files/dirs inside knowledge-base subdirs, keep the dirs
      const subdirs = ['profile', 'work', 'calendar', 'inbox', 'drive', 'templates']
      for (const sub of subdirs) {
        const dir = join(KNOWLEDGE_DIR, sub)
        try {
          for (const f of readdirSync(dir)) {
            rmSync(join(dir, f), { recursive: true, force: true })
          }
        } catch {
          /* dir may not exist */
        }
      }
      // Also remove any top-level .md files
      try {
        for (const f of readdirSync(KNOWLEDGE_DIR)) {
          if (f.endsWith('.md')) rmSync(join(KNOWLEDGE_DIR, f), { force: true })
        }
      } catch {
        /* ignore */
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('settings:wipe-vault', () => {
    try {
      for (const f of readdirSync(VAULT_DIR)) {
        if (f.endsWith('.enc')) rmSync(join(VAULT_DIR, f), { force: true })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('settings:export-data', async () => {
    try {
      const db = getDb()

      const payload = {
        exportedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        tables: {
          integrations: db.select().from(integrations).all(),
          syncEvents: db.select().from(syncEvents).all(),
          checklistItems: db.select().from(checklistItems).all(),
          checklistTemplates: db.select().from(checklistTemplates).all(),
          calendarEvents: db.select().from(calendarEvents).all(),
          githubItems: db.select().from(githubItems).all(),
          gmailActions: db.select().from(gmailActions).all(),
          driveFiles: db.select().from(driveFiles).all(),
          habits: db.select().from(habits).all(),
          habitEntries: db.select().from(habitEntries).all(),
          financeAccounts: db.select().from(financeAccounts).all(),
          financeTransactions: db.select().from(financeTransactions).all(),
          budgetRules: db.select().from(budgetRules).all(),
          categorizationRules: db.select().from(categorizationRules).all(),
          knowledgeFiles: db.select().from(knowledgeFiles).all(),
          appSettings: db.select().from(appSettings).all()
        }
      }

      const dateSlug = new Date().toISOString().slice(0, 10)
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export Compass Data',
        defaultPath: join(app.getPath('downloads'), `compass-export-${dateSlug}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })

      if (canceled || !filePath) return { success: false, canceled: true }

      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
      return { success: true, path: filePath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

function getDefaultTemplate(listType: string): string {
  const templates: Record<string, string> = {
    daily: `## Morning\n- [ ] Review today's calendar\n- [ ] Check email & prioritize\n- [ ] Set 3 main goals for the day\n\n## Work\n- [ ] Deep work block (2 hrs)\n- [ ] Review GitHub issues\n- [ ] Team sync / standups\n\n## Personal\n- [ ] Exercise\n- [ ] Read (30 min)\n\n## Evening\n- [ ] Plan tomorrow\n- [ ] Tidy workspace\n- [ ] Wind down`,
    weekly: `## This Week's Goals\n- [ ] \n- [ ] \n\n## Projects Status\n- [ ] \n\n## Weekly Review\n- What went well?\n- What were the blockers?\n- What needs attention next week?`,
    monthly:
      '## Monthly Priorities\n1. \n2. \n3. \n\n## Habits Review\n- [ ] \n\n## Financial Check-in\n- [ ] Review budget\n- [ ] Check upcoming bills\n\n## Monthly Reflection\n- Biggest win:\n- Biggest challenge:\n- Focus for next month:'
  }
  return templates[listType] || ''
}
