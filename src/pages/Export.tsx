import {
  CalendarDays,
  CreditCard,
  Download,
  FileSpreadsheet,
  Lock,
  Package,
  ShieldAlert,
  TrendingUp,
  Users
} from 'lucide-react'
import { useState } from 'react'
import { useToast } from '../components/ui/Toast'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

type ExportResult = { success: boolean; canceled?: boolean; error?: string; count?: number }

export default function Export(): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const { toast } = useToast()

  async function run(key: string, fn: () => Promise<ExportResult>, label: string): Promise<void> {
    if (!isElectron() || busy !== null) return // guard against overlapping exports
    setBusy(key)
    try {
      const r = await fn()
      if (r.canceled) return
      if (r.success) {
        const suffix =
          typeof r.count === 'number' ? ` (${r.count} item${r.count === 1 ? '' : 's'})` : ''
        toast(`${label} exported${suffix}.`, 'success')
      } else {
        toast(`${label} export failed: ${r.error}`, 'error')
      }
    } finally {
      setBusy(null)
    }
  }

  async function exportAll(): Promise<void> {
    if (!isElectron() || busy !== null) return // guard against overlapping exports
    setBusy('all')
    try {
      const r = await window.api.exporter.all()
      if (r.canceled) return
      if (r.success) {
        toast(`Full export written to ${r.path}`, 'success')
      } else {
        toast(`Export failed: ${r.error}`, 'error')
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-center gap-2.5 mb-2">
        <Download size={22} className="text-primary" />
        <h1 className="text-2xl font-semibold text-foreground">Export &amp; Portability</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6 max-w-2xl">
        Your data is yours. Export any part of Compass into an open, standard format you can
        re-import into another service — vCard for contacts, iCalendar for events, CSV for finance,
        Markdown for notes. Nothing here depends on Compass continuing to exist.
      </p>

      {/* Plaintext warning */}
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 mb-6">
        <ShieldAlert size={16} className="text-amber-500 mt-0.5 shrink-0" />
        <p className="text-xs text-amber-200/90">
          These files are <strong>unencrypted</strong> and contain your personal data. Save them
          somewhere safe and delete them when you're done. For an encrypted, passphrase-protected
          archive of <em>everything</em> (including the vault), use{' '}
          <span className="font-medium">Settings → Backup</span> instead.
        </p>
      </div>

      {/* Export everything */}
      <button
        type="button"
        onClick={exportAll}
        disabled={busy !== null}
        className="w-full flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/10 hover:bg-primary/15 px-5 py-4 mb-6 text-left transition-colors disabled:opacity-50"
      >
        <Package size={20} className="text-primary shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground">Export everything</p>
          <p className="text-xs text-muted-foreground">
            One folder with contacts, calendar, transactions, and all notes — plus a manifest. Vault
            excluded.
          </p>
        </div>
        <span className="text-xs text-primary font-medium">
          {busy === 'all' ? 'Exporting…' : 'Choose folder →'}
        </span>
      </button>

      {/* Per-domain */}
      <div className="space-y-3">
        <DomainCard
          icon={<Users size={16} className="text-primary" />}
          title="Contacts"
          description="Your address book — names, phones, emails, addresses."
          actions={[
            {
              label: 'vCard (.vcf)',
              busy: busy === 'contacts-vcf',
              onClick: () =>
                run('contacts-vcf', () => window.api.contacts.exportVcard(), 'Contacts')
            },
            {
              label: 'CSV',
              busy: busy === 'contacts-csv',
              onClick: () => run('contacts-csv', () => window.api.contacts.exportCsv(), 'Contacts')
            }
          ]}
        />
        <DomainCard
          icon={<CalendarDays size={16} className="text-primary" />}
          title="Calendar"
          description="All synced events as an iCalendar file."
          actions={[
            {
              label: 'iCalendar (.ics)',
              busy: busy === 'cal',
              onClick: () => run('cal', () => window.api.exporter.calendarIcs(), 'Calendar')
            }
          ]}
        />
        <DomainCard
          icon={<TrendingUp size={16} className="text-primary" />}
          title="Finance"
          description="Your full transaction ledger with account names."
          actions={[
            {
              label: 'CSV',
              busy: busy === 'txn',
              onClick: () => run('txn', () => window.api.exporter.transactionsCsv(), 'Transactions')
            }
          ]}
        />
        <DomainCard
          icon={<CreditCard size={16} className="text-primary" />}
          title="Subscriptions"
          description="Your tracked recurring costs and renewals."
          actions={[
            {
              label: 'CSV',
              busy: busy === 'subs',
              onClick: () =>
                run('subs', () => window.api.subscriptions.exportCsv(), 'Subscriptions')
            }
          ]}
        />
        <DomainCard
          icon={<FileSpreadsheet size={16} className="text-primary" />}
          title="Knowledge base"
          description="Every note copied out as plain Markdown files."
          actions={[
            {
              label: 'Markdown folder',
              busy: busy === 'kb',
              onClick: () => run('kb', () => window.api.exporter.knowledgeFolder(), 'Knowledge')
            }
          ]}
        />
      </div>

      <div className="flex items-center gap-2 mt-8 text-xs text-muted-foreground">
        <Lock size={12} />
        Passwords, IDs, and account numbers live in the encrypted vault and are never written by
        these exports. Use Settings → Backup to carry the vault to a new machine.
      </div>
    </div>
  )
}

function DomainCard({
  icon,
  title,
  description,
  actions
}: {
  icon: React.ReactNode
  title: string
  description: string
  actions: Array<{ label: string; onClick: () => void; busy: boolean }>
}): JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-5 py-4">
      <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={a.onClick}
            disabled={a.busy}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
          >
            <Download size={11} /> {a.busy ? 'Exporting…' : a.label}
          </button>
        ))}
      </div>
    </div>
  )
}
