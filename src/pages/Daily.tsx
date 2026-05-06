import { useState, useEffect, useRef } from 'react'
import { format, addDays, subDays } from 'date-fns'
import { Plus, ChevronLeft, ChevronRight, RefreshCcw, Download, GripVertical, Trash2, ChevronDown, FileText, X } from 'lucide-react'
import { cn, isoDate, todayISO } from '../lib/utils'

const CATEGORIES = ['morning', 'work', 'personal', 'evening'] as const
type Category = typeof CATEGORIES[number]

const CATEGORY_COLORS: Record<Category, string> = {
  morning: 'text-amber-400',
  work: 'text-blue-400',
  personal: 'text-purple-400',
  evening: 'text-indigo-400'
}

/** Parse template markdown into {category, title}[] for seeding a new day */
function parseTemplate(md: string): Array<{ category: Category; title: string }> {
  const catMap: Record<string, Category> = {
    morning: 'morning', work: 'work', personal: 'personal', evening: 'evening'
  }
  const results: Array<{ category: Category; title: string }> = []
  let currentCat: Category = 'personal'
  for (const line of md.split('\n')) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/)
    if (headingMatch) {
      const key = headingMatch[1].trim().toLowerCase()
      currentCat = catMap[key] ?? 'personal'
      continue
    }
    const itemMatch = line.match(/^-\s+\[[ x]\]\s+(.+)/)
    if (itemMatch) {
      results.push({ category: currentCat, title: itemMatch[1].trim() })
    }
  }
  return results
}

export default function Daily(): JSX.Element {
  const [date, setDate] = useState(new Date())
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [githubDue, setGithubDue] = useState<GitHubItem[]>([])
  const [gmailActions, setGmailActions] = useState<GmailAction[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [newCategory, setNewCategory] = useState<Category>('personal')
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [templateContent, setTemplateContent] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const dateStr = isoDate(date)
  const isToday = dateStr === todayISO()

  useEffect(() => {
    loadData()
  }, [date])

  // Listen for the ⌘K "New task" command
  useEffect(() => {
    // Check for pending action set by CommandPalette before navigating here
    const pending = sessionStorage.getItem('compass:pending-action')
    if (pending === 'new-task') {
      sessionStorage.removeItem('compass:pending-action')
      setDate(new Date())
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    const handler = () => {
      // Reset to today in case the user is viewing a different date
      setDate(new Date())
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener('compass:new-task', handler)
    return () => window.removeEventListener('compass:new-task', handler)
  }, [])

  async function loadData() {
    setLoading(true)
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) {
      setItems(getMockItems(dateStr))
      setLoading(false)
      return
    }

    const start = new Date(date)
    start.setHours(0, 0, 0)
    const end = new Date(date)
    end.setHours(23, 59, 59)

    const [checkItems, calEvents, ghItems, gmailItems] = await Promise.all([
      window.api.checklist.getItems('daily', dateStr),
      window.api.calendar.getEvents(start.toISOString(), end.toISOString()),
      window.api.github.getItems('open'),
      isToday ? window.api.gmail.getActions(false) : Promise.resolve([])
    ])

    setItems(checkItems)
    setEvents(calEvents)
    setGithubDue(ghItems.filter((g: GitHubItem) => g.dueDate === dateStr))
    setGmailActions((gmailItems as GmailAction[]).slice(0, 5))
    setLoading(false)
  }

  function exportAsMarkdown() {
    const lines: string[] = [
      `# Daily Plan — ${format(date, 'EEEE, MMMM d, yyyy')}`,
      ''
    ]

    if (events.length) {
      lines.push('## Calendar')
      events.forEach(ev => {
        const time = ev.allDay ? 'All day' : ev.startAt ? format(new Date(ev.startAt), 'h:mm a') : ''
        lines.push(`- ${ev.title}${time ? ` (${time})` : ''}`)
      })
      lines.push('')
    }

    CATEGORIES.forEach(cat => {
      const catItems = items.filter(i => i.category === cat)
      if (!catItems.length) return
      lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)}`)
      catItems.forEach(item => {
        lines.push(`- [${item.checked ? 'x' : ' '}] ${item.title}`)
        if (item.body) lines.push(`  ${item.body}`)
      })
      lines.push('')
    })

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `daily-${dateStr}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function addItem() {
    if (!newTitle.trim()) return
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      const created = await window.api.checklist.addItem({
        listType: 'daily',
        listDate: dateStr,
        title: newTitle.trim(),
        category: newCategory,
        source: 'manual'
      })
      setItems((prev) => [...prev, created])
    } else {
      setItems((prev) => [...prev, {
        id: Date.now(),
        listType: 'daily',
        listDate: dateStr,
        title: newTitle.trim(),
        category: newCategory,
        checked: false,
        status: 'unchecked',
        sortOrder: prev.length,
        body: null,
        source: 'manual',
        sourceId: null,
        createdAt: new Date()
      }])
    }
    setNewTitle('')
    inputRef.current?.focus()
  }

  async function toggleItem(id: number, checked: boolean) {
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, checked } : i))
    if (window.api) {
      await window.api.checklist.updateItem(id, { checked, status: checked ? 'done' : 'unchecked' })
    }
  }

  async function deleteItem(id: number) {
    setItems((prev) => prev.filter((i) => i.id !== id))
    if (window.api) {
      await window.api.checklist.deleteItem(id)
    }
  }

  async function updateBody(id: number, body: string) {
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, body } : i))
    if (window.api) {
      await window.api.checklist.updateItem(id, { body })
    }
  }

  async function handleReorder(cat: Category, reordered: ChecklistItem[]) {
    const withOrder = reordered.map((item, idx) => ({ ...item, sortOrder: idx }))
    setItems((prev) => {
      const others = prev.filter((i) => i.category !== cat)
      return [...others, ...withOrder]
    })
    if (window.api) {
      await Promise.all(
        withOrder.map((item, idx) =>
          window.api!.checklist.updateItem(item.id, { sortOrder: idx })
        )
      )
    }
  }

  async function rollOver() {
    if (!window.api) return
    const tomorrow = isoDate(addDays(date, 1))
    const result = await window.api.checklist.rollOver(dateStr, tomorrow)
    alert(`Rolled over ${result.rolledOver} items to ${tomorrow}`)
  }

  async function openTemplateEditor() {
    if (window.api) {
      const content = await window.api.checklist.getTemplate('daily')
      setTemplateContent(content || '')
    }
    setTemplateOpen(true)
  }

  async function saveTemplate() {
    if (window.api) {
      await window.api.checklist.saveTemplate('daily', templateContent)
    }
    setTemplateOpen(false)
  }

  async function seedFromTemplate() {
    if (!window.api) return
    const content = await window.api.checklist.getTemplate('daily')
    const parsed = parseTemplate(content)
    const created: ChecklistItem[] = []
    for (let i = 0; i < parsed.length; i++) {
      const item = await window.api.checklist.addItem({
        listType: 'daily',
        listDate: dateStr,
        title: parsed[i].title,
        category: parsed[i].category,
        sortOrder: i,
        source: 'template'
      })
      created.push(item)
    }
    setItems(created)
  }

  const grouped = CATEGORIES.map((cat) => ({
    cat,
    items: items.filter((i) => i.category === cat)
  })).filter(g => g.items.length > 0)

  const completedCount = items.filter(i => i.checked).length
  const progress = items.length > 0 ? Math.round((completedCount / items.length) * 100) : 0

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => setDate(subDays(date, 1))} className="p-1.5 rounded hover:bg-secondary transition-colors">
            <ChevronLeft size={16} />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              {isToday ? 'Today' : format(date, 'EEEE')}
            </h1>
            <p className="text-sm text-muted-foreground">{format(date, 'MMMM d, yyyy')}</p>
          </div>
          <button onClick={() => setDate(addDays(date, 1))} className="p-1.5 rounded hover:bg-secondary transition-colors">
            <ChevronRight size={16} />
          </button>
          {!isToday && (
            <button onClick={() => setDate(new Date())} className="text-xs text-primary hover:underline">
              Today
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isToday && (
            <button onClick={rollOver} className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors">
              <RefreshCcw size={12} /> Roll over
            </button>
          )}
          <button onClick={openTemplateEditor} className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors">
            <FileText size={12} /> Template
          </button>
          <button onClick={exportAsMarkdown} className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors">
            <Download size={12} /> Export
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {items.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
            <span>{completedCount} of {items.length} completed</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Calendar events strip */}
      {events.length > 0 && (
        <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
          {events.map((ev) => (
            <div key={ev.id} className="shrink-0 bg-primary/10 border border-primary/20 rounded-lg px-3 py-2 min-w-[160px]">
              <p className="text-xs font-medium text-primary truncate">{ev.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {ev.allDay ? 'All day' : ev.startAt ? format(new Date(ev.startAt), 'h:mm a') : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Checklist by category */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map(n => (
            <div key={n} className="h-12 bg-secondary/50 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(({ cat, items: catItems }) => (
            <CategorySection
              key={cat}
              category={cat}
              items={catItems}
              expanded={expandedItems}
              onToggleItem={toggleItem}
              onDeleteItem={deleteItem}
              onUpdateBody={updateBody}
              onReorder={(reordered) => handleReorder(cat, reordered)}
              onToggleExpand={(id) => setExpandedItems(prev => {
                const next = new Set(prev)
                next.has(id) ? next.delete(id) : next.add(id)
                return next
              })}
            />
          ))}

          {items.length === 0 && (
            <div className="text-center py-12">
              <p className="text-muted-foreground text-sm">No tasks yet for this day.</p>
              <p className="text-muted-foreground/60 text-xs mt-1">Add a task below or start from your template.</p>
              {window.api && (
                <button
                  onClick={seedFromTemplate}
                  className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-lg transition-colors mx-auto"
                >
                  <FileText size={12} /> Load from template
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* GitHub items due today */}
      {githubDue.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">GitHub · Due Today</h3>
          {githubDue.map(item => (
            <div key={item.id} className="flex items-center gap-3 py-2">
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">#</span>
              <span className="text-sm text-foreground flex-1 truncate">{item.title}</span>
              <span className="text-xs text-muted-foreground truncate">{item.repo}</span>
            </div>
          ))}
        </div>
      )}

      {/* Gmail action items (today only) */}
      {isToday && gmailActions.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Inbox · Needs Attention</h3>
          <div className="space-y-2">
            {gmailActions.map(msg => (
              <div key={msg.id} className="flex items-start gap-3 py-1.5 group">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0 mt-1.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{msg.subject}</p>
                  <p className="text-xs text-muted-foreground truncate">{msg.fromAddress}</p>
                </div>
                <button
                  onClick={async () => {
                    try {
                      await window.api?.gmail.markDone(msg.id)
                      setGmailActions(prev => prev.filter(m => m.id !== msg.id))
                    } catch (err) {
                      console.error('[Daily] markDone failed:', err)
                    }
                  }}
                  className="text-xs text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                >
                  Done
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add item input */}
      <div className="mt-8 border-t border-border pt-4">
        <div className="flex gap-2">
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as Category)}
            className="bg-secondary border border-border rounded-lg px-2 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
          >
            {CATEGORIES.map(c => <option key={c} value={c} className="capitalize">{c}</option>)}
          </select>
          <input
            ref={inputRef}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addItem()}
            placeholder="Add a task… (Enter to save)"
            className="flex-1 bg-secondary border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={addItem}
            className="px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      {/* Template editor modal */}
      {templateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setTemplateOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Daily Template</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Use <code className="text-primary">## Category</code> headings (morning, work, personal, evening) and <code className="text-primary">- [ ] Task</code> items</p>
              </div>
              <button onClick={() => setTemplateOpen(false)} className="p-1.5 rounded hover:bg-secondary text-muted-foreground">
                <X size={14} />
              </button>
            </div>
            <div className="p-5">
              <textarea
                value={templateContent}
                onChange={(e) => setTemplateContent(e.target.value)}
                className="w-full h-72 bg-secondary border border-border rounded-lg px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-primary resize-none"
                spellCheck={false}
              />
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
              <button onClick={() => setTemplateOpen(false)} className="text-sm px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors">
                Cancel
              </button>
              <button onClick={saveTemplate} className="text-sm px-4 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">
                Save template
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CategorySection({ category, items, expanded, onToggleItem, onDeleteItem, onUpdateBody, onReorder, onToggleExpand }: {
  category: Category
  items: ChecklistItem[]
  expanded: Set<number>
  onToggleItem: (id: number, checked: boolean) => void
  onDeleteItem: (id: number) => void
  onUpdateBody: (id: number, body: string) => void
  onReorder: (newOrder: ChecklistItem[]) => void
  onToggleExpand: (id: number) => void
}): JSX.Element {
  const [dragOverId, setDragOverId] = useState<number | null>(null)

  function handleDrop(e: React.DragEvent, targetId: number) {
    e.preventDefault()
    const fromId = Number(e.dataTransfer.getData('compassItemId'))
    if (!fromId || fromId === targetId) { setDragOverId(null); return }
    const fromIdx = items.findIndex((i) => i.id === fromId)
    const toIdx = items.findIndex((i) => i.id === targetId)
    if (fromIdx < 0 || toIdx < 0) { setDragOverId(null); return }
    const reordered = [...items]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    onReorder(reordered)
    setDragOverId(null)
  }

  return (
    <div>
      <h3 className={cn('text-xs font-semibold uppercase tracking-wider mb-2', CATEGORY_COLORS[category])}>
        {category}
      </h3>
      <div className="space-y-1">
        {items.map((item) => (
          <ChecklistRow
            key={item.id}
            item={item}
            isExpanded={expanded.has(item.id)}
            isDragTarget={dragOverId === item.id}
            onToggle={(checked) => onToggleItem(item.id, checked)}
            onDelete={() => onDeleteItem(item.id)}
            onUpdateBody={(body) => onUpdateBody(item.id, body)}
            onToggleExpand={() => onToggleExpand(item.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData('compassItemId', String(item.id))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => { e.preventDefault(); setDragOverId(item.id) }}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(e) => handleDrop(e, item.id)}
          />
        ))}
      </div>
    </div>
  )
}

function ChecklistRow({ item, isExpanded, isDragTarget, onToggle, onDelete, onUpdateBody, onToggleExpand, onDragStart, onDragOver, onDragLeave, onDrop }: {
  item: ChecklistItem
  isExpanded: boolean
  isDragTarget: boolean
  onToggle: (checked: boolean) => void
  onDelete: () => void
  onUpdateBody: (body: string) => void
  onToggleExpand: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}): JSX.Element {
  const [isDragging, setIsDragging] = useState(false)
  const [bodyText, setBodyText] = useState(item.body || '')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleBodyChange(v: string) {
    setBodyText(v)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => onUpdateBody(v), 800)
  }

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'group rounded-lg border transition-colors',
        isDragging && 'opacity-40',
        isDragTarget ? 'border-primary/60 bg-primary/5' : (
          item.checked ? 'border-border/50 bg-card/40' : 'border-transparent hover:border-border bg-card/60 hover:bg-card'
        )
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span
          draggable={true}
          onDragStart={(e) => { setIsDragging(true); onDragStart(e) }}
          onDragEnd={() => setIsDragging(false)}
          className="shrink-0"
        >
          <GripVertical size={14} className="text-muted-foreground/30 cursor-grab active:cursor-grabbing" />
        </span>
        <button
          onClick={() => onToggle(!item.checked)}
          className={cn(
            'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
            item.checked
              ? 'bg-primary border-primary'
              : 'border-border hover:border-primary'
          )}
        >
          {item.checked && <span className="text-white text-[10px] font-bold">✓</span>}
        </button>

        <span className={cn('text-sm flex-1', item.checked && 'line-through text-muted-foreground')}>
          {item.title}
        </span>

        {item.source && item.source !== 'manual' && (
          <span className="text-xs text-muted-foreground/60 font-mono">{item.source}</span>
        )}

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onToggleExpand} className="p-1 rounded hover:bg-secondary text-muted-foreground">
            <ChevronDown size={12} className={cn('transition-transform', isExpanded && 'rotate-180')} />
          </button>
          <button onClick={onDelete} className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive">
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="px-10 pb-3">
          <textarea
            value={bodyText}
            onChange={(e) => handleBodyChange(e.target.value)}
            placeholder="Add a note…"
            className="w-full text-xs text-muted-foreground bg-transparent resize-none outline-none placeholder:text-muted-foreground/50 min-h-[60px]"
          />
        </div>
      )}
    </div>
  )
}

function getMockItems(dateStr: string): ChecklistItem[] {
  return [
    { id: 1, listType: 'daily', listDate: dateStr, title: 'Review today\'s calendar', category: 'morning', checked: true, status: 'done', sortOrder: 0, body: null, source: 'manual', sourceId: null, createdAt: new Date() },
    { id: 2, listType: 'daily', listDate: dateStr, title: 'Deep work block', category: 'work', checked: false, status: 'unchecked', sortOrder: 1, body: null, source: 'manual', sourceId: null, createdAt: new Date() },
    { id: 3, listType: 'daily', listDate: dateStr, title: 'Review GitHub issues', category: 'work', checked: false, status: 'unchecked', sortOrder: 2, body: null, source: 'github', sourceId: null, createdAt: new Date() },
    { id: 4, listType: 'daily', listDate: dateStr, title: 'Exercise', category: 'personal', checked: false, status: 'unchecked', sortOrder: 3, body: null, source: 'manual', sourceId: null, createdAt: new Date() },
    { id: 5, listType: 'daily', listDate: dateStr, title: 'Plan tomorrow', category: 'evening', checked: false, status: 'unchecked', sortOrder: 4, body: null, source: 'manual', sourceId: null, createdAt: new Date() },
  ]
}
