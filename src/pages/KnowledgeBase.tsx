import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Typography from '@tiptap/extension-typography'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  FileText,
  Focus,
  Folder,
  GitCompare,
  Lightbulb,
  Link2,
  Minimize2,
  Plus,
  RefreshCw,
  Save,
  Search,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDebounce } from '../hooks/useDebounce'
import { cn, formatRelative } from '../lib/utils'

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
  const [searchResults, setSearchResults] = useState<Array<FileNode & { snippet: string }> | null>(
    null
  )
  const [semanticHits, setSemanticHits] = useState<
    Array<{
      path: string
      title: string
      chunkIndex: number
      snippet: string
      score: number
    }>
  >([])
  const [semanticEnabled, setSemanticEnabled] = useState(false)
  const [semanticReason, setSemanticReason] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  // Distraction-free reading mode (Phase 5 backlog): hides the file
  // sidebar so the editor pane has more space.
  // Esc exits.
  const [readingMode, setReadingMode] = useState(false)
  const [diffOld, setDiffOld] = useState<string | null>(null) // content before last sync
  const [suggestions, setSuggestions] = useState<KnowledgeSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [backlinks, setBacklinks] = useState<BacklinkRow[]>([])
  const [showBacklinks, setShowBacklinks] = useState(false)
  const isLoadingRef = useRef(false)
  const currentRawRef = useRef<string>('') // raw markdown of currently open file
  const selectedPathRef = useRef<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const debouncedSearch = useDebounce(searchQuery, 300)

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Typography,
      Link.configure({ openOnClick: false, autolink: true })
    ],
    content: '',
    editorProps: { attributes: { class: 'tiptap-editor' } },
    onUpdate: ({ editor }) => {
      if (isLoadingRef.current) return // suppress updates during initial content load
      const md = editor.getHTML()
      setContent(md)
    }
  })

  useEffect(() => {
    loadFiles()

    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return

    const unsub = window.api.knowledge.onFileChanged((path) => {
      loadFiles()
      if (path === selectedPathRef.current) {
        // Load the .prev snapshot from disk (written by extractor before overwrite)
        window.api.knowledge.getPrev(path).then((prev) => {
          // Guard against stale responses if the user switched files
          if (selectedPathRef.current === path && prev !== null) {
            setDiffOld(prev)
            setShowDiff(false) // available but not shown until user clicks
          }
        })
        loadFileContent(path)
      }
    })
    return unsub
  }, [])

  // Wire ⌘K "Search knowledge base" command
  useEffect(() => {
    // Check for pending action set by CommandPalette before navigating here
    const pending = sessionStorage.getItem('compass:pending-action')
    if (pending === 'focus-search') {
      sessionStorage.removeItem('compass:pending-action')
      searchRef.current?.focus()
    }
    const handler = () => searchRef.current?.focus()
    window.addEventListener('compass:focus-search', handler)
    return () => window.removeEventListener('compass:focus-search', handler)
  }, [])

  // Reading-mode shortcut: Esc exits. Tied to `readingMode` so we don't
  // intercept Escape in normal mode (the editor / palette already handle
  // their own dismissals).
  useEffect(() => {
    if (!readingMode) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setReadingMode(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [readingMode])

  // CommandPalette "open knowledge X" → load that note (also fired on
  // mount when the palette put the path into sessionStorage before nav).
  useEffect(() => {
    const pending = sessionStorage.getItem('compass:open-knowledge')
    if (pending) {
      sessionStorage.removeItem('compass:open-knowledge')
      selectFile(pending)
    }
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (typeof detail === 'string' && detail) selectFile(detail)
    }
    window.addEventListener('compass:open-knowledge', handler)
    return () => window.removeEventListener('compass:open-knowledge', handler)
  }, [])

  // Wikilink click handler: intercept `<a data-wikilink="…">` clicks
  // inside the editor and route to selectFile() instead of letting the
  // browser navigate. Resolves the target to a real .md path using the
  // current file index — title-match wins, then basename, then full path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach on editor mount/swap; `editor` listed to retrigger when TipTap instance changes
  useEffect(() => {
    const editorRoot = document.querySelector('.tiptap-editor') as HTMLElement | null
    if (!editorRoot) return
    function onClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      const anchor = target?.closest('a[data-wikilink]') as HTMLAnchorElement | null
      if (!anchor) return
      event.preventDefault()
      const wantedRaw = anchor.getAttribute('data-wikilink') ?? ''
      const wanted = wantedRaw.trim().toLowerCase()
      if (!wanted) return
      const candidate =
        files.find((f) => f.title.toLowerCase() === wanted) ??
        files.find((f) => f.path.replace(/\.md$/, '').toLowerCase() === wanted) ??
        files.find(
          (f) => f.path.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase() === wanted
        ) ??
        files.find((f) => f.path.toLowerCase() === wanted)
      if (candidate) {
        selectFile(candidate.path)
        return
      }
      // Unresolved → offer to create it under general/<slug>.md
      const slug = wanted.replace(/[^a-z0-9-_ ]/g, '').replace(/\s+/g, '-')
      if (!slug) return
      const newPath = `general/${slug}.md`
      if (typeof window !== 'undefined' && window.api?.knowledge) {
        void window.api.knowledge
          .createFile(newPath, wantedRaw.trim())
          .then(() => {
            loadFiles().then(() => selectFile(newPath))
          })
          .catch(() => {
            /* file may already exist; ignore */
          })
      }
    }
    editorRoot.addEventListener('click', onClick)
    return () => editorRoot.removeEventListener('click', onClick)
  }, [files, editor]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (debouncedSearch.trim().length > 1) {
      const isElectron = typeof window !== 'undefined' && !!window.api
      if (isElectron) {
        window.api.knowledge.search(debouncedSearch).then(setSearchResults)
      }
    } else {
      setSearchResults(null)
      setSemanticHits([])
      setSemanticReason(null)
    }
  }, [debouncedSearch])

  // Read the semantic-search setting once on mount so the renderer knows
  // whether to call the embedding IPC alongside the keyword search.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.api) return
    void window.api.settings.getAll().then((s) => {
      setSemanticEnabled(s.semanticSearchEnabled === 'true')
    })
  }, [])

  // Semantic pass — runs in parallel with the keyword search above so the
  // renderer never blocks on the embedding round-trip. If the index is
  // missing or Ollama is offline the surfaced `reason` lets us render a
  // one-line hint without spamming the user with toasts.
  useEffect(() => {
    if (!semanticEnabled) {
      setSemanticHits([])
      setSemanticReason(null)
      return
    }
    const q = debouncedSearch.trim()
    if (q.length < 2) {
      setSemanticHits([])
      setSemanticReason(null)
      return
    }
    let cancelled = false
    void window.api?.knowledge.semanticSearch(q).then((res) => {
      if (cancelled) return
      setSemanticHits(res.hits ?? [])
      setSemanticReason(res.reason ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, semanticEnabled])

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
        currentRawRef.current = c
        isLoadingRef.current = true
        editor.commands.setContent(markdownToHtml(c))
        setContent('') // reset dirty state — auto-save won't fire until user edits
        isLoadingRef.current = false
      }
    }
  }

  async function loadSuggestions(path: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    const items = await window.api.knowledge.listSuggestions(path)
    if (selectedPathRef.current === path) setSuggestions(items)
  }

  async function loadBacklinks(path: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    try {
      const items = await window.api.knowledge.getBacklinks(path)
      if (selectedPathRef.current === path) setBacklinks(items)
    } catch {
      if (selectedPathRef.current === path) setBacklinks([])
    }
  }

  function selectFile(path: string) {
    selectedPathRef.current = path
    setSelectedPath(path)
    setDiffOld(null)
    setShowDiff(false)
    setShowSuggestions(false)
    setSuggestions([])
    setBacklinks([])
    setShowBacklinks(false)
    loadFileContent(path)
    loadSuggestions(path)
    loadBacklinks(path)
    // Load persisted prev snapshot for diff view
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      window.api.knowledge.getPrev(path).then((prev) => {
        // Guard against stale responses if the user switched files quickly
        if (selectedPathRef.current === path && prev !== null) setDiffOld(prev)
      })
    }
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally fires on debounced content only; saveContent reads the latest selectedPath
  useEffect(() => {
    if (debouncedContent && selectedPath) saveContent()
  }, [debouncedContent])

  async function handleAcceptSuggestion(id: number) {
    if (!window.api) return
    await window.api.knowledge.acceptSuggestion(id)
    // Reload the file content and refresh suggestions
    if (selectedPath) {
      loadFileContent(selectedPath)
      loadSuggestions(selectedPath)
    }
  }

  async function handleDismissSuggestion(id: number) {
    if (!window.api) return
    await window.api.knowledge.dismissSuggestion(id)
    if (selectedPath) loadSuggestions(selectedPath)
  }

  // Grouped by category
  const grouped = files.reduce<Record<string, FileNode[]>>((acc, f) => {
    const cat = f.category || 'general'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(f)
    return acc
  }, {})

  const selectedFile = files.find((f) => f.path === selectedPath)

  return (
    <div className={cn('flex h-full', readingMode ? 'pt-0' : 'pt-10')}>
      {/* File tree sidebar — hidden in distraction-free reading mode */}
      <div
        className={cn(
          'w-64 shrink-0 border-r border-border flex flex-col bg-card/40',
          readingMode && 'hidden'
        )}
      >
        {/* Search */}
        <div className="px-3 py-3 border-b border-border">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={searchRef}
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
              {semanticEnabled && semanticHits.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs text-muted-foreground px-4 py-1 font-medium flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
                    By meaning ({semanticHits.length})
                  </p>
                  {semanticHits.map((hit) => (
                    <button
                      key={`${hit.path}::${hit.chunkIndex}`}
                      type="button"
                      onClick={() => {
                        setSearchQuery('')
                        setSearchResults(null)
                        setSemanticHits([])
                        selectFile(hit.path)
                      }}
                      className={cn(
                        'w-full text-left px-4 py-1.5 hover:bg-secondary/60 transition-colors',
                        selectedPath === hit.path && 'bg-secondary/40'
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm text-foreground truncate">{hit.title}</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {(hit.score * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{hit.snippet}</div>
                    </button>
                  ))}
                </div>
              )}
              {semanticEnabled && semanticReason && semanticHits.length === 0 && (
                <p className="px-4 py-1 text-[10px] text-muted-foreground italic">
                  {semanticReason === 'index-missing'
                    ? 'Semantic index not built — Settings → AI assist → Build index.'
                    : semanticReason === 'ollama-error'
                      ? 'Ollama unreachable — semantic search skipped.'
                      : ''}
                </p>
              )}
              <p className="text-xs text-muted-foreground px-4 py-1 font-medium">
                {searchResults.length} keyword results
              </p>
              {searchResults.map((r) => (
                <FileTreeItem
                  key={r.path}
                  file={r}
                  selected={selectedPath === r.path}
                  onClick={() => {
                    setSearchQuery('')
                    setSearchResults(null)
                    setSemanticHits([])
                    selectFile(r.path)
                  }}
                />
              ))}
            </div>
          ) : (
            Object.entries(grouped).map(([cat, catFiles]) => (
              <CategoryGroup
                key={cat}
                name={cat}
                files={catFiles}
                selectedPath={selectedPath}
                onSelect={selectFile}
              />
            ))
          )}
        </div>

        {/* New file */}
        <div className="px-3 py-2 border-t border-border">
          <button
            type="button"
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
                  <span className="text-xs text-muted-foreground capitalize">
                    {selectedFile.category}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {selectedFile.wordCount} words
                  </span>
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
                  {saving && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <RefreshCw size={10} className="animate-spin" /> Saving…
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {backlinks.length > 0 && (
                  <button
                    type="button"
                    aria-label={`${backlinks.length} backlink${backlinks.length === 1 ? '' : 's'} — click to review`}
                    onClick={() => setShowBacklinks((v) => !v)}
                    className={cn(
                      'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors',
                      showBacklinks
                        ? 'bg-primary/20 text-primary border border-primary/30'
                        : 'bg-secondary hover:bg-secondary/80 text-muted-foreground'
                    )}
                  >
                    <Link2 size={12} />
                    {backlinks.length} backlink{backlinks.length === 1 ? '' : 's'}
                  </button>
                )}
                {suggestions.length > 0 && (
                  <button
                    type="button"
                    aria-label={`${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} — click to review`}
                    onClick={() => setShowSuggestions((v) => !v)}
                    className={cn(
                      'relative flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors',
                      showSuggestions
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-secondary hover:bg-secondary/80 text-amber-400'
                    )}
                  >
                    <Lightbulb size={12} />
                    Suggestions
                    <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold text-white">
                      {suggestions.length}
                    </span>
                  </button>
                )}
                {diffOld !== null && (
                  <button
                    type="button"
                    onClick={() => setShowDiff((v) => !v)}
                    className={cn(
                      'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors',
                      showDiff
                        ? 'bg-primary/20 text-primary border border-primary/30'
                        : 'bg-secondary hover:bg-secondary/80 text-muted-foreground'
                    )}
                  >
                    <GitCompare size={12} /> {showDiff ? 'Hide diff' : 'Show diff'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setReadingMode((v) => !v)}
                  aria-pressed={readingMode}
                  title={
                    readingMode ? 'Exit reading mode (Esc)' : 'Enter distraction-free reading mode'
                  }
                  className={cn(
                    'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors',
                    readingMode
                      ? 'bg-primary/20 text-primary border border-primary/30'
                      : 'bg-secondary hover:bg-secondary/80'
                  )}
                >
                  {readingMode ? <Minimize2 size={12} /> : <Focus size={12} />}
                  {readingMode ? 'Exit' : 'Focus'}
                </button>
                <button
                  type="button"
                  onClick={saveContent}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
                >
                  <Save size={12} /> Save
                </button>
              </div>
            </div>

            {/* Backlinks panel */}
            {showBacklinks && backlinks.length > 0 && (
              <div className="border-b border-border bg-card/60 max-h-72 overflow-y-auto">
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/60">
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Link2 size={11} /> Notes that link here
                  </span>
                  <button
                    type="button"
                    aria-label="Close backlinks panel"
                    onClick={() => setShowBacklinks(false)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    <X size={13} />
                  </button>
                </div>
                <ul className="divide-y divide-border/40">
                  {backlinks.map((b) => (
                    <li key={b.path}>
                      <button
                        type="button"
                        onClick={() => selectFile(b.path)}
                        className="w-full text-left px-4 py-2 hover:bg-secondary/40 transition-colors"
                      >
                        <div className="text-sm text-foreground">{b.title}</div>
                        <div className="text-xs text-muted-foreground truncate">{b.snippet}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Suggestions panel */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="border-b border-border bg-amber-500/5 max-h-80 overflow-y-auto">
                <div className="px-4 py-2 flex items-center justify-between border-b border-amber-500/10">
                  <span className="text-xs font-medium text-amber-400 flex items-center gap-1.5">
                    <Lightbulb size={11} /> Suggested additions for this file
                  </span>
                  <button
                    type="button"
                    aria-label="Close suggestions panel"
                    onClick={() => setShowSuggestions(false)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="divide-y divide-border/40">
                  {suggestions.map((s) => (
                    <SuggestionItem
                      key={s.id}
                      suggestion={s}
                      onAccept={handleAcceptSuggestion}
                      onDismiss={handleDismissSuggestion}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Inline diff panel (shown after sync updates the file) */}
            {showDiff && diffOld !== null && (
              <div className="border-b border-border bg-card/60 max-h-64 overflow-y-auto">
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <GitCompare size={11} /> Changes from last sync
                  </span>
                  <button
                    type="button"
                    onClick={() => setDiffOld(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Dismiss
                  </button>
                </div>
                <DiffView oldText={diffOld} newText={currentRawRef.current} />
              </div>
            )}

            {/* TipTap editor */}
            <div
              className={cn(
                'flex-1 overflow-y-auto',
                readingMode ? 'px-6 py-16 md:py-24' : 'px-10 py-6'
              )}
            >
              <EditorContent
                editor={editor}
                className={cn(
                  'tiptap-editor prose prose-invert text-foreground',
                  readingMode ? 'max-w-2xl mx-auto text-[15px] leading-7' : 'max-w-none'
                )}
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

function CategoryGroup({
  name,
  files,
  selectedPath,
  onSelect
}: {
  name: string
  files: FileNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1 px-4 py-1 text-xs font-medium text-muted-foreground hover:text-foreground uppercase tracking-wider"
      >
        <ChevronRight size={10} className={cn('transition-transform', open && 'rotate-90')} />
        <Folder size={10} />
        {name}
      </button>
      {open &&
        files.map((f) => (
          <FileTreeItem
            key={f.path}
            file={f}
            selected={selectedPath === f.path}
            onClick={() => onSelect(f.path)}
          />
        ))}
    </div>
  )
}

function FileTreeItem({
  file,
  selected,
  onClick
}: { file: FileNode; selected: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-5 py-1.5 text-xs transition-colors text-left',
        selected
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'
      )}
    >
      <FileText size={11} className="shrink-0" />
      <span className="truncate">{file.title}</span>
      {file.autoUpdated && (
        <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0 ml-auto" />
      )}
    </button>
  )
}

// ── Suggestion Item ───────────────────────────────────────────────────────────

/** Map the raw source string to a human-readable label and visual style. */
function sourceBadgeProps(source: KnowledgeSuggestion['source']): {
  label: string
  className: string
} {
  if (source === 'gmail') return { label: 'Gmail', className: 'bg-secondary text-muted-foreground' }
  if (source === 'github')
    return { label: 'GitHub', className: 'bg-secondary text-muted-foreground' }
  if (source === 'calendar')
    return { label: 'Calendar', className: 'bg-secondary text-muted-foreground' }
  if (source === 'ollama:gmail')
    return {
      label: 'AI · Gmail',
      className: 'bg-violet-500/15 text-violet-400 border border-violet-500/25'
    }
  if (source === 'ollama:github')
    return {
      label: 'AI · GitHub',
      className: 'bg-violet-500/15 text-violet-400 border border-violet-500/25'
    }
  return { label: source, className: 'bg-secondary text-muted-foreground' }
}

function SuggestionItem({
  suggestion,
  onAccept,
  onDismiss
}: {
  suggestion: KnowledgeSuggestion
  onAccept: (id: number) => void
  onDismiss: (id: number) => void
}): JSX.Element {
  const badge = sourceBadgeProps(suggestion.source)

  return (
    <div className="px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded',
            badge.className
          )}
          title={`Source: ${suggestion.source}`}
        >
          {badge.label}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-1.5 py-0.5 rounded bg-secondary">
          {suggestion.kind}
        </span>
        {suggestion.context && (
          <span className="text-xs text-muted-foreground truncate">{suggestion.context}</span>
        )}
      </div>
      <code className="block text-xs bg-card/80 border border-border rounded px-2 py-1.5 text-foreground/80 font-mono whitespace-pre-wrap break-all">
        {suggestion.proposedContent}
      </code>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Accept suggestion"
          onClick={() => onAccept(suggestion.id)}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors border border-emerald-500/20"
        >
          <Check size={11} /> Accept
        </button>
        <button
          type="button"
          aria-label="Dismiss suggestion"
          onClick={() => onDismiss(suggestion.id)}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
        >
          <X size={11} /> Dismiss
        </button>
      </div>
    </div>
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
    if (/^# /.test(line)) {
      out.push(`<h1>${inlineHtml(line.slice(2))}</h1>`)
      i++
      continue
    }
    if (/^## /.test(line)) {
      out.push(`<h2>${inlineHtml(line.slice(3))}</h2>`)
      i++
      continue
    }
    if (/^### /.test(line)) {
      out.push(`<h3>${inlineHtml(line.slice(4))}</h3>`)
      i++
      continue
    }

    // Blockquote
    if (/^> /.test(line)) {
      out.push(`<blockquote><p>${inlineHtml(line.slice(2))}</p></blockquote>`)
      i++
      continue
    }

    // Table: detect header row followed by separator row
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s\-|]+\|$/.test(lines[i + 1])) {
      const headers = parseCells(line)
      i += 2 // skip separator row
      const rows: string[][] = []
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(parseCells(lines[i]))
        i++
      }
      const th = headers.map((h) => `<th>${inlineHtml(h)}</th>`).join('')
      const trs = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`)
        .join('')
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`)
      continue
    }

    // Task list items
    if (/^- \[x\] /.test(line)) {
      out.push(
        `<ul data-type="taskList"><li data-checked="true"><label><input type="checkbox" checked/></label><div><p>${inlineHtml(line.slice(6))}</p></div></li></ul>`
      )
      i++
      continue
    }
    if (/^- \[ \] /.test(line)) {
      out.push(
        `<ul data-type="taskList"><li data-checked="false"><label><input type="checkbox"/></label><div><p>${inlineHtml(line.slice(6))}</p></div></li></ul>`
      )
      i++
      continue
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
    if (line.trim() === '') {
      i++
      continue
    }

    // Regular paragraph
    out.push(`<p>${inlineHtml(line)}</p>`)
    i++
  }

  return out.join('\n')
}

function parseCells(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())
}

function inlineHtml(text: string): string {
  return (
    text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Wikilinks (May 2026 Tier 1 #4). Rendered as a styled link with a
      // custom `data-wikilink` attribute so the editor click handler can
      // navigate to the target note. Optional `[[target|display]]` syntax —
      // first segment is the target, second is the display text.
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_full, target: string, display?: string) => {
        const t = target.trim()
        const d = (display ?? target).trim()
        return `<a href="#wikilink" data-wikilink="${escapeAttr(t)}" class="text-primary underline underline-offset-2">${escapeHtml(d)}</a>`
      })
  )
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function htmlToMarkdown(html: string): string {
  return (
    html
      .replace(/<h1>(.*?)<\/h1>/gi, '# $1\n')
      .replace(/<h2>(.*?)<\/h2>/gi, '## $1\n')
      .replace(/<h3>(.*?)<\/h3>/gi, '### $1\n')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      // Wikilinks: must run BEFORE the generic <a> rule, otherwise `[[X]]`
      // round-trips as `[X](#wikilink)` and the [[…]] semantics are lost.
      // The target lives in `data-wikilink`; the display text is the link
      // body. When they match we emit `[[target]]`; when they differ we
      // emit `[[target|display]]`.
      .replace(
        /<a\b[^>]*data-wikilink="([^"]+)"[^>]*>(.*?)<\/a>/gi,
        (_full, target: string, display: string) => {
          const t = target
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
          const d = display.replace(/<[^>]+>/g, '')
          return t.toLowerCase() === d.toLowerCase() ? `[[${t}]]` : `[[${t}|${d}]]`
        }
      )
      .replace(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<li>(.*?)<\/li>/gi, '- $1\n')
      .replace(/<blockquote><p>(.*?)<\/p><\/blockquote>/gi, '> $1\n')
      .replace(/<p>(.*?)<\/p>/gi, '$1\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  )
}

// ── Diff view ────────────────────────────────────────────────────────────────

type DiffLine = { type: 'same' | 'add' | 'remove'; text: string }

const MAX_DIFF_LINES = 2000
const MAX_DIFF_CELLS = 1_000_000

function createDiffTooLargeFallback(oldLines: string[], newLines: string[]): DiffLine[] {
  return [
    {
      type: 'same',
      text: `[Diff omitted: too large to compare safely on this screen (${oldLines.length} old lines, ${newLines.length} new lines).]`
    }
  ]
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  // Simple O(n²) LCS-based diff — keep it for normal-sized files, but avoid
  // allocating a huge DP matrix on the UI thread for large inputs.
  const n = oldLines.length
  const m = newLines.length
  const cellCount = (n + 1) * (m + 1)

  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES || cellCount > MAX_DIFF_CELLS) {
    return createDiffTooLargeFallback(oldLines, newLines)
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1]
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i] === newLines[j]) {
      result.push({ type: 'same', text: oldLines[i] })
      i++
      j++
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      result.push({ type: 'add', text: newLines[j] })
      j++
    } else {
      result.push({ type: 'remove', text: oldLines[i] })
      i++
    }
  }
  return result
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }): JSX.Element {
  const lines = computeDiff(oldText, newText)
  const hasChanges = lines.some((l) => l.type !== 'same')

  if (!hasChanges) {
    return <p className="px-4 py-3 text-xs text-muted-foreground italic">No changes detected.</p>
  }

  // Show only changed lines + 2 lines of context around each change
  const CONTEXT = 2
  const shown = new Set<number>()
  lines.forEach((l, idx) => {
    if (l.type !== 'same') {
      for (
        let k = Math.max(0, idx - CONTEXT);
        k <= Math.min(lines.length - 1, idx + CONTEXT);
        k++
      ) {
        shown.add(k)
      }
    }
  })

  const chunks: JSX.Element[] = []
  let prevIdx = -1
  lines.forEach((line, idx) => {
    if (!shown.has(idx)) return
    if (prevIdx >= 0 && idx > prevIdx + 1) {
      chunks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: diff renderer — line position IS the identity
        <div key={`gap-${idx}`} className="px-4 py-0.5 text-xs text-muted-foreground/40">
          ···
        </div>
      )
    }
    prevIdx = idx
    chunks.push(
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: diff renderer — line position IS the identity
        key={idx}
        className={cn(
          'px-4 py-0.5 font-mono text-xs whitespace-pre-wrap',
          line.type === 'add' && 'bg-emerald-500/10 text-emerald-400',
          line.type === 'remove' && 'bg-red-500/10 text-red-400 line-through',
          line.type === 'same' && 'text-muted-foreground/50'
        )}
      >
        <span className="mr-2 select-none opacity-50">
          {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
        </span>
        {line.text || ' '}
      </div>
    )
  })

  return <div className="pb-2">{chunks}</div>
}

function getMockFiles(): FileNode[] {
  return [
    {
      path: 'profile/personal.md',
      title: 'Personal Profile',
      category: 'profile',
      lastModified: Date.now(),
      wordCount: 45,
      autoUpdated: false
    },
    {
      path: 'profile/goals.md',
      title: 'Goals & Aspirations',
      category: 'profile',
      lastModified: Date.now(),
      wordCount: 32,
      autoUpdated: false
    },
    {
      path: 'work/projects.md',
      title: 'Active Projects',
      category: 'work',
      lastModified: Date.now(),
      wordCount: 67,
      autoUpdated: false
    },
    {
      path: 'work/github-summary.md',
      title: 'GitHub Summary',
      category: 'work',
      lastModified: Date.now(),
      wordCount: 120,
      autoUpdated: true
    },
    {
      path: 'calendar/upcoming.md',
      title: 'Upcoming Events',
      category: 'calendar',
      lastModified: Date.now(),
      wordCount: 89,
      autoUpdated: true
    }
  ]
}
