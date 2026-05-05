import { useState, useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import Typography from '@tiptap/extension-typography'
import Link from '@tiptap/extension-link'
import { BookOpen, Search, Plus, ChevronRight, RefreshCw, FileText, Folder, Save, Bot } from 'lucide-react'
import { cn, formatRelative } from '../lib/utils'
import { useDebounce } from '../hooks/useDebounce'

interface FileNode {
  path: string
  title: string
  category: string
  lastModified: number
  wordCount: number
  autoUpdated: boolean
}

export default function KnowledgeBase(): JSX.Element {
  const [files, setFiles] = useState<FileNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<FileNode & { snippet: string }> | null>(null)
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const isLoadingRef = useRef(false)

  const debouncedSearch = useDebounce(searchQuery, 300)

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Typography,
      Link.configure({ openOnClick: true, autolink: true })
    ],
    content: '',
    editorProps: { attributes: { class: 'tiptap-editor' } },
    onUpdate: ({ editor }) => {
      if (isLoadingRef.current) return  // suppress updates during initial content load
      const md = editor.getHTML()
      setContent(md)
    }
  })

  useEffect(() => {
    loadFiles()

    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      const unsub = window.api.knowledge.onFileChanged((path) => {
        loadFiles()
        if (path === selectedPath) loadFileContent(path)
      })
      return unsub
    }
  }, [])

  useEffect(() => {
    if (debouncedSearch.trim().length > 1) {
      const isElectron = typeof window !== 'undefined' && !!window.api
      if (isElectron) {
        window.api.knowledge.search(debouncedSearch).then(setSearchResults)
      }
    } else {
      setSearchResults(null)
    }
  }, [debouncedSearch])

  async function loadFiles() {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      const f = await window.api.knowledge.listFiles()
      setFiles(f)
      if (!selectedPath && f.length > 0) {
        selectFile(f[0].path)
      }
    } else {
      setFiles(getMockFiles())
    }
  }

  async function loadFileContent(path: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      const c = await window.api.knowledge.readFile(path)
      if (editor && c !== null) {
        isLoadingRef.current = true
        editor.commands.setContent(markdownToHtml(c))
        setContent('')  // reset dirty state — auto-save won't fire until user edits
        isLoadingRef.current = false
      }
    }
  }

  function selectFile(path: string) {
    setSelectedPath(path)
    loadFileContent(path)
  }

  const saveContent = useCallback(async () => {
    if (!selectedPath || !editor) return
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      setSaving(true)
      // Convert editor HTML back to a readable format
      const html = editor.getHTML()
      await window.api.knowledge.writeFile(selectedPath, htmlToMarkdown(html))
      setSaving(false)
      setLastSaved(new Date())
    }
  }, [selectedPath, editor])

  // Auto-save on content change (debounced)
  const debouncedContent = useDebounce(content, 2000)
  useEffect(() => {
    if (debouncedContent && selectedPath) saveContent()
  }, [debouncedContent])

  // Grouped by category
  const grouped = files.reduce<Record<string, FileNode[]>>((acc, f) => {
    const cat = f.category || 'general'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(f)
    return acc
  }, {})

  const selectedFile = files.find(f => f.path === selectedPath)

  return (
    <div className="flex h-full pt-10">
      {/* File tree sidebar */}
      <div className="w-64 shrink-0 border-r border-border flex flex-col bg-card/40">
        {/* Search */}
        <div className="px-3 py-3 border-b border-border">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search knowledge…"
              className="w-full bg-secondary/60 rounded-lg pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* File tree or search results */}
        <div className="flex-1 overflow-y-auto py-2">
          {searchResults ? (
            <div>
              <p className="text-xs text-muted-foreground px-4 py-1 font-medium">{searchResults.length} results</p>
              {searchResults.map(r => (
                <FileTreeItem
                  key={r.path}
                  file={r}
                  selected={selectedPath === r.path}
                  onClick={() => { setSearchQuery(''); setSearchResults(null); selectFile(r.path) }}
                />
              ))}
            </div>
          ) : (
            Object.entries(grouped).map(([cat, catFiles]) => (
              <CategoryGroup key={cat} name={cat} files={catFiles} selectedPath={selectedPath} onSelect={selectFile} />
            ))
          )}
        </div>

        {/* New file */}
        <div className="px-3 py-2 border-t border-border">
          <button
            onClick={async () => {
              const title = prompt('File name:')
              if (!title) return
              const path = `general/${title.toLowerCase().replace(/\s+/g, '-')}.md`
              if (window.api) {
                await window.api.knowledge.createFile(path, title)
                await loadFiles()
                selectFile(path)
              }
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-primary hover:bg-secondary/60 rounded transition-colors"
          >
            <Plus size={12} /> New file
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            {/* File header */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
              <div>
                <h2 className="text-base font-semibold text-foreground">{selectedFile.title}</h2>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-muted-foreground capitalize">{selectedFile.category}</span>
                  <span className="text-xs text-muted-foreground">{selectedFile.wordCount} words</span>
                  {selectedFile.autoUpdated && (
                    <span className="flex items-center gap-1 text-xs text-primary/70">
                      <Bot size={10} /> Auto-updated
                    </span>
                  )}
                  {lastSaved && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Save size={10} /> Saved {formatRelative(lastSaved)}
                    </span>
                  )}
                  {saving && <span className="flex items-center gap-1 text-xs text-muted-foreground"><RefreshCw size={10} className="animate-spin" /> Saving…</span>}
                </div>
              </div>
              <button onClick={saveContent} className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors">
                <Save size={12} /> Save
              </button>
            </div>

            {/* TipTap editor */}
            <div className="flex-1 overflow-y-auto px-10 py-6">
              <EditorContent
                editor={editor}
                className="tiptap-editor prose prose-invert max-w-none text-foreground"
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <BookOpen size={40} className="text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-muted-foreground">Select a file to start editing</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CategoryGroup({ name, files, selectedPath, onSelect }: {
  name: string
  files: FileNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1 px-4 py-1 text-xs font-medium text-muted-foreground hover:text-foreground uppercase tracking-wider"
      >
        <ChevronRight size={10} className={cn('transition-transform', open && 'rotate-90')} />
        <Folder size={10} />
        {name}
      </button>
      {open && files.map(f => (
        <FileTreeItem key={f.path} file={f} selected={selectedPath === f.path} onClick={() => onSelect(f.path)} />
      ))}
    </div>
  )
}

function FileTreeItem({ file, selected, onClick }: { file: FileNode; selected: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-5 py-1.5 text-xs transition-colors text-left',
        selected ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'
      )}
    >
      <FileText size={11} className="shrink-0" />
      <span className="truncate">{file.title}</span>
      {file.autoUpdated && <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0 ml-auto" />}
    </button>
  )
}

// Markdown → HTML converter for editor seeding
function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Headings
    if (/^# /.test(line)) { out.push(`<h1>${inlineHtml(line.slice(2))}</h1>`); i++; continue }
    if (/^## /.test(line)) { out.push(`<h2>${inlineHtml(line.slice(3))}</h2>`); i++; continue }
    if (/^### /.test(line)) { out.push(`<h3>${inlineHtml(line.slice(4))}</h3>`); i++; continue }

    // Blockquote
    if (/^> /.test(line)) { out.push(`<blockquote><p>${inlineHtml(line.slice(2))}</p></blockquote>`); i++; continue }

    // Table: detect header row followed by separator row
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s\-|]+\|$/.test(lines[i + 1])) {
      const headers = parseCells(line)
      i += 2 // skip separator row
      const rows: string[][] = []
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(parseCells(lines[i]))
        i++
      }
      const th = headers.map(h => `<th>${inlineHtml(h)}</th>`).join('')
      const trs = rows.map(r => `<tr>${r.map(c => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`)
      continue
    }

    // Task list items
    if (/^- \[x\] /.test(line)) {
      out.push(`<ul data-type="taskList"><li data-checked="true"><label><input type="checkbox" checked/></label><div><p>${inlineHtml(line.slice(6))}</p></div></li></ul>`)
      i++; continue
    }
    if (/^- \[ \] /.test(line)) {
      out.push(`<ul data-type="taskList"><li data-checked="false"><label><input type="checkbox"/></label><div><p>${inlineHtml(line.slice(6))}</p></div></li></ul>`)
      i++; continue
    }

    // Unordered list — collect consecutive items
    if (/^- /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^- /.test(lines[i])) {
        items.push(`<li>${inlineHtml(lines[i].slice(2))}</li>`)
        i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // Blank line
    if (line.trim() === '') { i++; continue }

    // Regular paragraph
    out.push(`<p>${inlineHtml(line)}</p>`)
    i++
  }

  return out.join('\n')
}

function parseCells(row: string): string[] {
  return row.split('|').slice(1, -1).map(c => c.trim())
}

function inlineHtml(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h1>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<blockquote><p>(.*?)<\/p><\/blockquote>/gi, '> $1\n')
    .replace(/<p>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function getMockFiles(): FileNode[] {
  return [
    { path: 'profile/personal.md', title: 'Personal Profile', category: 'profile', lastModified: Date.now(), wordCount: 45, autoUpdated: false },
    { path: 'profile/goals.md', title: 'Goals & Aspirations', category: 'profile', lastModified: Date.now(), wordCount: 32, autoUpdated: false },
    { path: 'work/projects.md', title: 'Active Projects', category: 'work', lastModified: Date.now(), wordCount: 67, autoUpdated: false },
    { path: 'work/github-summary.md', title: 'GitHub Summary', category: 'work', lastModified: Date.now(), wordCount: 120, autoUpdated: true },
    { path: 'calendar/upcoming.md', title: 'Upcoming Events', category: 'calendar', lastModified: Date.now(), wordCount: 89, autoUpdated: true },
  ]
}
