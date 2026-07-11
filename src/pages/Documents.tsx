import { ExternalLink, FileText, Paperclip, Search, Trash2, Upload, X } from 'lucide-react'
import { type JSX, useEffect, useMemo, useState } from 'react'
import { useToast } from '../components/ui/Toast'

type DocRow = Awaited<ReturnType<Window['api']['documents']['list']>>[number]
type DocDetail = NonNullable<Awaited<ReturnType<Window['api']['documents']['get']>>>

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api
const TARGET_KINDS = ['record', 'contact', 'merchant', 'place', 'asset', 'subscription'] as const

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtDate(ms: number | null): string {
  return ms == null ? '' : new Date(ms).toLocaleDateString('en-US', { dateStyle: 'medium' })
}

export default function Documents(): JSX.Element {
  const [docs, setDocs] = useState<DocRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<DocDetail | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const { toast } = useToast()

  async function reload(): Promise<void> {
    if (!isElectron()) return
    try {
      setDocs(await window.api.documents.list())
    } catch {
      toast('Could not load your documents', 'error')
    }
  }

  useEffect(() => {
    if (!isElectron()) {
      setLoaded(true)
      return
    }
    window.api.documents
      .list()
      .then(setDocs)
      .catch(() => toast('Could not load your documents', 'error'))
      .finally(() => setLoaded(true))
  }, [toast])

  function report(r: { imported: number; duplicates: number; skipped: number }): void {
    const parts: string[] = []
    if (r.imported) parts.push(`${r.imported} imported`)
    if (r.duplicates) parts.push(`${r.duplicates} already here`)
    if (r.skipped) parts.push(`${r.skipped} skipped`)
    toast(parts.length ? parts.join(' · ') : 'Nothing to import', r.imported ? 'success' : 'info')
  }

  async function doImport(): Promise<void> {
    if (!isElectron() || busy) return
    setBusy(true)
    try {
      const r = await window.api.documents.import()
      report(r)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function onDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    if (!isElectron() || busy) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths = window.api.records.pathsForFiles(files).filter(Boolean)
    if (paths.length === 0) {
      toast('Could not read the dropped file(s)', 'error')
      return
    }
    setBusy(true)
    try {
      report(await window.api.documents.importPaths(paths))
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function openDetail(id: number): Promise<void> {
    if (!isElectron()) return
    try {
      setSelected(await window.api.documents.get(id))
    } catch {
      toast('Could not open that document', 'error')
    }
  }

  async function doOpen(id: number): Promise<void> {
    const r = await window.api.documents.open(id)
    if (!r.success) toast(r.error ?? 'Could not open the file', 'error')
  }

  async function doDelete(id: number): Promise<void> {
    const r = await window.api.documents.delete(id)
    if (r.success) {
      if (selected?.id === id) setSelected(null)
      await reload()
      toast('Document deleted', 'success')
    } else {
      toast(r.error ?? 'Could not delete', 'error')
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return docs
    return docs.filter(
      (d) => d.title.toLowerCase().includes(q) || d.fileName.toLowerCase().includes(q)
    )
  }, [docs, query])

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <FileText size={22} className="text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Documents</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Your files, kept on-device. PDF and text content is searchable from ⌘K, and any document
            can attach to a record or person.
          </p>
        </div>
        <button
          type="button"
          onClick={doImport}
          disabled={busy}
          className="shrink-0 flex items-center gap-1.5 text-sm px-3 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          <Upload size={15} /> Import
        </button>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`mb-5 rounded-xl border border-dashed px-6 py-6 text-center text-sm transition-colors ${
          dragOver
            ? 'border-primary bg-primary/5 text-foreground'
            : 'border-border text-muted-foreground'
        }`}
      >
        {busy ? 'Importing…' : 'Drop files here (PDF, images, text, Office docs) or use Import'}
      </div>

      {docs.length > 0 && (
        <div className="relative mb-4">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a document…"
            aria-label="Find a document"
            className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
          />
        </div>
      )}

      {loaded && docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
          No documents yet. Import a PDF, receipt, contract, or statement — its text becomes
          searchable and you can attach it to anything on your timeline.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 hover:border-primary/40 transition-colors"
            >
              <button
                type="button"
                onClick={() => openDetail(d.id)}
                className="flex-1 min-w-0 flex items-center gap-3 text-left"
              >
                <FileText size={16} className="text-muted-foreground shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground truncate">
                    {d.title}
                  </span>
                  <span className="block text-[11px] text-muted-foreground truncate">
                    {d.fileName} · {fmtBytes(d.byteSize)}
                    {d.pageCount ? ` · ${d.pageCount}p` : ''}
                    {d.createdAt ? ` · ${fmtDate(d.createdAt)}` : ''}
                  </span>
                </span>
                {d.hasText && (
                  <span className="ml-auto shrink-0 text-[10px] text-emerald-500 border border-emerald-500/30 rounded px-1.5 py-0.5">
                    searchable
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => doOpen(d.id)}
                title="Open the file"
                aria-label={`Open ${d.title}`}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink size={15} />
              </button>
              <button
                type="button"
                onClick={() => doDelete(d.id)}
                title="Delete"
                aria-label={`Delete ${d.title}`}
                className="shrink-0 text-muted-foreground hover:text-rose-500 transition-colors"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
          {shown.length === 0 && query && (
            <li className="text-sm text-muted-foreground px-4 py-3">
              No document matches "{query}".
            </li>
          )}
        </ul>
      )}

      {selected && (
        <DetailPanel
          doc={selected}
          onClose={() => setSelected(null)}
          onChanged={() => openDetail(selected.id)}
          onOpen={() => doOpen(selected.id)}
        />
      )}
    </div>
  )
}

/** Slide-over detail: metadata, extracted-text preview, attachments + a minimal attach form. */
function DetailPanel({
  doc,
  onClose,
  onChanged,
  onOpen
}: {
  doc: DocDetail
  onClose: () => void
  onChanged: () => void
  onOpen: () => void
}): JSX.Element {
  const { toast } = useToast()
  const [kind, setKind] = useState<(typeof TARGET_KINDS)[number]>('record')
  const [targetId, setTargetId] = useState('')

  async function attach(): Promise<void> {
    const id = targetId.trim()
    if (!id) return
    const r = await window.api.documents.attach({
      documentId: doc.id,
      targetKind: kind,
      targetId: id
    })
    if (r.success) {
      setTargetId('')
      onChanged()
    } else {
      toast(r.error ?? 'Could not attach', 'error')
    }
  }

  async function detach(linkId: number): Promise<void> {
    const r = await window.api.documents.detach(linkId)
    if (r.success) onChanged()
  }

  return (
    <div className="fixed inset-y-0 right-0 z-30 w-full max-w-md bg-card border-l border-border shadow-xl overflow-y-auto animate-fade-in">
      <div className="sticky top-0 bg-card border-b border-border px-5 py-3 flex items-center gap-2">
        <FileText size={16} className="text-primary shrink-0" />
        <h2 className="text-sm font-semibold text-foreground truncate flex-1">{doc.title}</h2>
        <button
          type="button"
          onClick={onOpen}
          title="Open the file"
          aria-label="Open the file"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ExternalLink size={16} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      <div className="p-5 space-y-5">
        <div className="text-xs text-muted-foreground space-y-1">
          <div>
            {doc.fileName} · {fmtBytes(doc.byteSize)}
            {doc.pageCount ? ` · ${doc.pageCount} pages` : ''}
          </div>
          {doc.mimeType && <div>{doc.mimeType}</div>}
          {doc.createdAt && <div>Added {fmtDate(doc.createdAt)}</div>}
        </div>

        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground mb-2">
            <Paperclip size={13} /> Attached to
          </div>
          {doc.links.length === 0 ? (
            <p className="text-xs text-muted-foreground">Not attached to anything yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {doc.links.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center gap-2 text-xs text-foreground bg-muted rounded px-2 py-1"
                >
                  <span className="text-muted-foreground">{l.targetKind}</span>
                  <span className="truncate">{l.targetId}</span>
                  <button
                    type="button"
                    onClick={() => detach(l.id)}
                    aria-label="Detach"
                    className="ml-auto text-muted-foreground hover:text-rose-500"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof TARGET_KINDS)[number])}
              aria-label="Attachment kind"
              className="rounded border border-border bg-card text-xs px-1.5 py-1 text-foreground"
            >
              {TARGET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="target id"
              aria-label="Attachment target id"
              className="flex-1 min-w-0 rounded border border-border bg-card text-xs px-2 py-1 text-foreground placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={attach}
              className="text-xs px-2 py-1 bg-secondary hover:bg-secondary/80 text-foreground rounded"
            >
              Attach
            </button>
          </div>
        </div>

        {doc.extractedText && (
          <div>
            <div className="text-xs font-medium text-foreground mb-2">Extracted text</div>
            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words max-h-72 overflow-y-auto bg-muted rounded p-3">
              {doc.extractedText.slice(0, 4000)}
              {doc.extractedText.length > 4000 ? '\n…' : ''}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
