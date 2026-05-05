import { IpcMain } from 'electron'
import { eq, and, gte, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { habits, habitEntries } from '../db/schema'

export function registerHabitsHandlers(ipcMain: IpcMain): void {
  // ── List habits (active only by default) ─────────────────────────────────
  ipcMain.handle('habits:list', (_event, includeInactive = false) => {
    const db = getDb()
    const rows = db.select().from(habits).all()
    return includeInactive ? rows : rows.filter(h => h.active)
  })

  // ── Create a habit ────────────────────────────────────────────────────────
  ipcMain.handle('habits:create', (_event, habit: {
    name: string
    icon?: string
    color?: string
  }) => {
    const db = getDb()
    const result = db.insert(habits).values({
      name: habit.name,
      icon: habit.icon ?? null,
      color: habit.color ?? '#6272f1',
      active: true,
      createdAt: new Date()
    }).run()
    return { success: true, id: Number(result.lastInsertRowid) }
  })

  // ── Update a habit ────────────────────────────────────────────────────────
  ipcMain.handle('habits:update', (_event, id: number, updates: {
    name?: string
    icon?: string
    color?: string
    active?: boolean
  }) => {
    const db = getDb()
    db.update(habits).set(updates).where(eq(habits.id, id)).run()
    return { success: true }
  })

  // ── Delete a habit (soft delete — sets active = false) ────────────────────
  ipcMain.handle('habits:delete', (_event, id: number) => {
    const db = getDb()
    db.update(habits).set({ active: false }).where(eq(habits.id, id)).run()
    return { success: true }
  })

  // ── Get entries for a month ───────────────────────────────────────────────
  // Returns: { [habitId]: { [date]: boolean } }
  ipcMain.handle('habits:get-entries', (_event, month: string) => {
    const db = getDb()
    const start = `${month}-01`
    // Next month start
    const [y, m] = month.split('-').map(Number)
    const next = new Date(y, m, 1) // JS months are 0-indexed; m is 1-indexed so this gives next month
    const end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`

    const entries = db.select().from(habitEntries)
      .where(and(gte(habitEntries.date, start), lt(habitEntries.date, end)))
      .all()

    // Group by habitId
    const map: Record<number, Record<string, boolean>> = {}
    for (const e of entries) {
      if (!e.habitId) continue
      if (!map[e.habitId]) map[e.habitId] = {}
      map[e.habitId][e.date] = e.completed ?? false
    }
    return map
  })

  // ── Toggle (upsert) a habit entry ─────────────────────────────────────────
  ipcMain.handle('habits:toggle', async (_event, habitId: number, date: string) => {
    const db = getDb()

    // Check if entry exists
    const existing = db.select().from(habitEntries)
      .where(and(eq(habitEntries.habitId, habitId), eq(habitEntries.date, date)))
      .all()[0]

    if (existing) {
      db.update(habitEntries)
        .set({ completed: !existing.completed })
        .where(eq(habitEntries.id, existing.id))
        .run()
      return { success: true, completed: !existing.completed }
    } else {
      db.insert(habitEntries).values({
        habitId,
        date,
        completed: true
      }).run()
      return { success: true, completed: true }
    }
  })
}
