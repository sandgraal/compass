import { useState, useEffect, useCallback } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import Typography from '@tiptap/extension-typography'
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

  const debouncedSearch = useDebounce(searchQuery, 300)

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Typography
    ],
    content: '',
    editorProps: { attributes: { class: 'tiptap-editor' } },
    onUpdate: ({ editor }) => {
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
        editor.commands.setContent(markdownToHtml(c))
        setContent(c)
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

// Minimal markdown → HTML converter for editor seeding
function markdownToHtml(md: string): string {
  return md
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^\- \[x\] (.+)$/gm, '<ul data-type="taskList"><li data-checked="true"><label><input type="checkbox" checked/></label><div><p>$1</p></div></li></ul>')
    .replace(/^\- \[ \] (.+)$/gm, '<ul data-type="taskList"><li data-checked="false"><label><input type="checkbox"/></label><div><p>$1</p></div></li></ul>')
    .replace(/^\- (.+)$/gm, '<ul><li>$1</li></ul>')
    .replace(/^\> (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hupbloc])/gm, '<p>')
    .replace(/(?<![>])$/gm, '</p>')
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h1>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
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
