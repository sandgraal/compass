import { format } from 'date-fns'
import {
  AlertCircle,
  Eye,
  FolderOpen,
  Inbox,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Target,
  Trash2,
  TrendingDown,
  Wallet
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

// ─── Types ───────────────────────────────────────────────────────────────────

type Txn = {
  id: number
  hash?: string
  date: string
  amount: number
  description: string
  accountId: number | null
  category: string | null
  subcategory: string | null
  notes: string | null
  taxTag?: string | null
  taxTagSource?: string | null
  taxYear?: number | null
  sourceFile?: string | null
}
type Account = {
  id: number
  name: string
  type: string
  isDebt: boolean | null
  balance: number | null
  apr: number | null
  minPayment: number | null
  creditLimit: number | null
}
type BudgetLine = {
  category: string
  subcategory?: string
  monthlyAmount: number
  actual: number
  variance: number
  pct: number
}
type Rule = {
  id: number
  pattern: string
  category: string
  subcategory: string | null
  priority: number | null
}
type SubscriptionsData = Awaited<ReturnType<Window['api']['finance']['getSubscriptions']>>
type GeoSummary = {
  geo: { name: string; amount: number; count: number }[]
  purpose: { name: string; amount: number }[]
  crCapex: number
  since: string | null
}
type TaxSummary = Awaited<ReturnType<Window['api']['finance']['getTaxSummary']>>

type Tab = 'overview' | 'networth' | 'forecast' | 'transactions' | 'accounts' | 'rules' | 'crsubs'

const ACCOUNT_TYPES = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit', label: 'Credit card' },
  { value: 'investment', label: 'Investment' }
] as const

// ─── Tax tagging (Phase 4.3 UI) ──────────────────────────────────────────────

const TAX_TAGS = [
  'tax:none',
  'tax:capex-airbnb',
  'tax:schedule-c-income',
  'tax:schedule-c-expense',
  'tax:schedule-e-income',
  'tax:schedule-e-expense',
  'tax:charitable',
  'tax:medical',
  'tax:home-office',
  'tax:personal',
  'tax:investment'
] as const

const TAX_TAG_LABEL: Record<string, string> = {
  'tax:none': 'No tax impact',
  'tax:capex-airbnb': 'Capex (Airbnb)',
  'tax:schedule-c-income': 'Schedule C income',
  'tax:schedule-c-expense': 'Schedule C expense',
  'tax:schedule-e-income': 'Schedule E income',
  'tax:schedule-e-expense': 'Schedule E expense',
  'tax:charitable': 'Charitable',
  'tax:medical': 'Medical',
  'tax:home-office': 'Home office',
  'tax:personal': 'Personal',
  'tax:investment': 'Investment'
}

// Short form for the inline badge — full label gets long fast in a table cell.
const TAX_TAG_SHORT_LABEL: Record<string, string> = {
  'tax:none': '—',
  'tax:capex-airbnb': 'Capex',
  'tax:schedule-c-income': 'Sched C in',
  'tax:schedule-c-expense': 'Sched C',
  'tax:schedule-e-income': 'Sched E in',
  'tax:schedule-e-expense': 'Sched E',
  'tax:charitable': 'Charity',
  'tax:medical': 'Medical',
  'tax:home-office': 'Home off',
  'tax:personal': 'Personal',
  'tax:investment': 'Invest'
}

// Tailwind colour classes per tag. Muted for tax:none; semantic colour for
// deductible/income categories so the user can scan the column quickly.
const TAX_TAG_CLASS: Record<string, string> = {
  'tax:none': 'bg-muted text-muted-foreground',
  'tax:capex-airbnb': 'bg-purple-500/15 text-purple-400',
  'tax:schedule-c-income': 'bg-emerald-500/15 text-emerald-400',
  'tax:schedule-c-expense': 'bg-emerald-500/15 text-emerald-400',
  'tax:schedule-e-income': 'bg-cyan-500/15 text-cyan-400',
  'tax:schedule-e-expense': 'bg-cyan-500/15 text-cyan-400',
  'tax:charitable': 'bg-pink-500/15 text-pink-400',
  'tax:medical': 'bg-red-500/15 text-red-400',
  'tax:home-office': 'bg-blue-500/15 text-blue-400',
  'tax:personal': 'bg-muted text-muted-foreground',
  'tax:investment': 'bg-amber-500/15 text-amber-400'
}

function TaxBadge({ tag, source }: { tag: string; source: string }): JSX.Element {
  const label = TAX_TAG_SHORT_LABEL[tag] ?? '—'
  const cls = TAX_TAG_CLASS[tag] ?? 'bg-muted text-muted-foreground'
  return (
    <span
      title={`${TAX_TAG_LABEL[tag] ?? tag}${source === 'user' ? ' · manual' : ''}`}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
        cls,
        source === 'user' && 'ring-1 ring-amber-500/40'
      )}
    >
      {label}
    </span>
  )
}

const PREDEFINED_CATEGORIES = [
  'Groceries',
  'Dining',
  'Transportation',
  'Housing',
  'Utilities',
  'Entertainment',
  'Health',
  'Shopping',
  'Travel',
  'Subscriptions',
  'Income',
  'Transfers',
  'Uncategorized'
]

// ─── Page ────────────────────────────────────────────────────────────────────

// Tab values the command palette can deep-link to. Same string as the
// `Tab` union below so a typo in the palette wouldn't pass typecheck.
const VALID_TABS: ReadonlySet<Tab> = new Set([
  'overview',
  'networth',
  'forecast',
  'transactions',
  'accounts',
  'rules',
  'crsubs'
])

export default function Finance(): JSX.Element {
  // Initial tab: honor a pending command-palette deep-link if present,
  // otherwise default to Overview. Read at mount; consumed once.
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'overview'
    const pending = sessionStorage.getItem('compass:pending-finance-tab')
    if (pending && VALID_TABS.has(pending as Tab)) {
      sessionStorage.removeItem('compass:pending-finance-tab')
      return pending as Tab
    }
    return 'overview'
  })
  const [txns, setTxns] = useState<Txn[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [debts, setDebts] = useState<Account[]>([])
  const [budget, setBudget] = useState<BudgetLine[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [ingesting, setIngesting] = useState(false)
  const [reapplying, setReapplying] = useState(false)
  const [lastIngest, setLastIngest] = useState<{
    filesProcessed: number
    newTransactions: number
    duplicatesDropped: number
  } | null>(null)
  const [watchFolder, setWatchFolder] = useState<{
    path: string
    isWatching: boolean
    exists: boolean
  } | null>(null)
  const [vaultSeeded, setVaultSeeded] = useState(0)
  const [detectedAccounts, setDetectedAccounts] = useState<string[]>([])
  const [subscriptions, setSubscriptions] = useState<SubscriptionsData | null>(null)
  const [geoSummary, setGeoSummary] = useState<GeoSummary | null>(null)
  const [taxSummary, setTaxSummary] = useState<TaxSummary | null>(null)
  const [excludeProperty, setExcludeProperty] = useState(false)

  const { toast: showToast } = useToast()
  const confirm = useConfirm()

  const month = new Date().toISOString().slice(0, 7)

  const refresh = useCallback(async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    try {
      // Last-12-months window for the geo summary so the headline reflects
      // the bulk of activity, not just the few days of the current month.
      const since = new Date()
      since.setFullYear(since.getFullYear() - 1)
      const sinceIso = since.toISOString().slice(0, 10)
      const [t, a, d, b, r, s, g, x] = await Promise.all([
        window.api.finance.getTransactions({ month, limit: 200 }),
        window.api.finance.getAccounts(),
        window.api.finance.getDebtSummary(),
        window.api.finance.getBudgetStatus(month),
        window.api.finance.getRules(),
        window.api.finance.getSubscriptions().catch(() => null),
        window.api.finance.getGeoSummary({ since: sinceIso }).catch(() => null),
        window.api.finance.getTaxSummary().catch(() => null)
      ])
      setTxns(t)
      setAccounts(a)
      setDebts(d.debts as Account[])
      setBudget(b.lines)
      setRules(r)
      if (s) setSubscriptions(s)
      if (g) setGeoSummary(g)
      if (x) setTaxSummary(x)
    } catch (err) {
      console.error('[finance] refresh failed', err)
      showToast('Failed to load finance data.', 'error')
    }
  }, [month, showToast])

  const ingest = async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    setIngesting(true)
    try {
      await window.api.finance.ingestWatchedNow()
    } finally {
      setIngesting(false)
    }
  }

  const pickFolder = async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    const r = await window.api.finance.pickWatchFolder()
    if (!r.canceled && r.path) {
      const status = await window.api.finance.getWatchFolder()
      setWatchFolder(status)
    }
  }

  // Listen for command-palette tab-switch events (fired when the user
  // picks "Net Worth" or "Cash-flow forecast" while already on /finance).
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent<string>).detail
      if (typeof target === 'string' && VALID_TABS.has(target as Tab)) {
        setTab(target as Tab)
      }
    }
    window.addEventListener('compass:set-finance-tab', handler)
    return () => window.removeEventListener('compass:set-finance-tab', handler)
  }, [])

  useEffect(() => {
    void refresh()
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return

    // Initial watch folder status
    window.api.finance.getWatchFolder().then(setWatchFolder)

    // Listen for ingest events from the watcher
    const unsub = window.api.finance.onIngestComplete((data) => {
      const d = data as {
        result: typeof lastIngest
        detectedAccounts: { name: string }[]
        vaultSeeded: number
      }
      if (d.result) setLastIngest(d.result)
      setVaultSeeded(d.vaultSeeded)
      setDetectedAccounts(d.detectedAccounts.map((a) => a.name))
      void refresh()
    })
    const unsubRulesReapplied = window.api.finance.onRulesReapplied((data) => {
      const d = data as { updated: number }
      showToast(`Recategorized ${d.updated} transaction${d.updated === 1 ? '' : 's'}.`, 'success')
      void refresh()
    })
    return () => {
      unsub()
      unsubRulesReapplied()
    }
  }, [refresh, showToast])

  // ── Derived totals ────────────────────────────────────────────────────────
  const totalDebt = debts.reduce((a, d) => a + (d.balance ?? 0), 0)
  const wAPR =
    totalDebt > 0 ? debts.reduce((a, d) => a + (d.balance ?? 0) * (d.apr ?? 0), 0) / totalDebt : 0
  const totalBudget = budget.reduce((a, b) => a + b.monthlyAmount, 0)
  const totalActual = budget.reduce((a, b) => a + b.actual, 0)
  const monthIncome = txns
    .filter((t) => t.amount > 0 && t.category !== 'Transfers')
    .reduce((a, t) => a + t.amount, 0)
  const monthExpense = -txns
    .filter((t) => t.amount < 0 && t.category !== 'Transfers')
    .reduce((a, t) => a + t.amount, 0)
  const savingsRate = monthIncome > 0 ? (monthIncome - monthExpense) / monthIncome : 0

  // ── Account handlers ──────────────────────────────────────────────────────
  async function saveAccount(account: {
    id?: number
    name: string
    type: string
    isDebt?: boolean
    balance?: number
    apr?: number
    minPayment?: number
    creditLimit?: number
  }) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    try {
      await window.api.finance.upsertAccount(account)
      showToast(account.id ? 'Account updated.' : 'Account added.', 'success')
      await refresh()
    } catch (err) {
      console.error('[finance] saveAccount failed', err)
      showToast('Failed to save account.', 'error')
      throw err
    }
  }

  async function deleteAccount(id: number) {
    const ok = await confirm({
      title: 'Delete account?',
      description: 'This only works when no transactions still reference it.',
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    try {
      await window.api.finance.deleteAccount(id)
      showToast('Account deleted.', 'success')
      await refresh()
    } catch (err) {
      console.error('[finance] deleteAccount failed', err)
      showToast(err instanceof Error ? err.message : 'Failed to delete account.', 'error')
    }
  }

  // ── Transaction handlers ──────────────────────────────────────────────────
  async function updateTxn(
    id: number,
    updates: { category?: string; subcategory?: string; notes?: string; accountId?: number | null }
  ) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    try {
      await window.api.finance.updateTransaction(id, updates)
      showToast('Transaction updated.', 'success')
      await refresh()
    } catch (err) {
      console.error('[finance] updateTxn failed', err)
      showToast('Failed to update transaction.', 'error')
      throw err
    }
  }

  async function setTaxTag(id: number, taxTag: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    try {
      const result = await window.api.finance.setTransactionTaxTag(id, taxTag)
      if (!result.success) {
        showToast(result.error ?? 'Failed to set tax tag.', 'error')
        return
      }
      showToast('Tax tag updated.', 'success')
      // Surgical update of the one row instead of a full refresh.
      // A full refresh would replace the `txns` array, propagating new
      // `txn` props into the expanded TransactionRow, whose `useEffect`
      // would then reset the user's unsaved category/notes/account edits.
      setTxns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, taxTag, taxTagSource: 'user' as const } : t))
      )
      // Tax summary aggregate IS affected by the change — refresh just that.
      try {
        const fresh = await window.api.finance.getTaxSummary()
        setTaxSummary(fresh)
      } catch {
        /* aggregate refresh failure is non-fatal */
      }
    } catch (err) {
      console.error('[finance] setTaxTag failed', err)
      showToast('Failed to set tax tag.', 'error')
    }
  }

  async function deleteTxn(id: number) {
    const ok = await confirm({
      title: 'Delete transaction?',
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    try {
      await window.api.finance.deleteTransaction(id)
      showToast('Transaction deleted.', 'success')
      await refresh()
    } catch (err) {
      console.error('[finance] deleteTxn failed', err)
      showToast('Failed to delete transaction.', 'error')
    }
  }

  // ── Rule handlers ─────────────────────────────────────────────────────────
  async function saveRule(rule: {
    id?: number
    pattern: string
    category: string
    subcategory?: string
    priority?: number
  }) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    try {
      await window.api.finance.saveRule(rule)
      showToast(rule.id ? 'Rule updated.' : 'Rule added.', 'success')
      await refresh()
    } catch (err) {
      console.error('[finance] saveRule failed', err)
      showToast('Failed to save rule.', 'error')
      throw err
    }
  }

  async function deleteRule(id: number) {
    const ok = await confirm({
      title: 'Delete rule?',
      description:
        'The rule will be removed and transactions will no longer be auto-categorized by it.',
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    try {
      await window.api.finance.deleteRule(id)
      showToast('Rule deleted.', 'success')
      await refresh()
    } catch (err) {
      console.error('[finance] deleteRule failed', err)
      showToast('Failed to delete rule.', 'error')
    }
  }

  async function reapplyRules() {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    setReapplying(true)
    try {
      const { updated } = await window.api.finance.reapplyRules()
      showToast(`Recategorized ${updated} transaction${updated === 1 ? '' : 's'}.`, 'success')
      await refresh()
    } catch (err) {
      console.error('[finance] reapplyRules failed', err)
      showToast('Failed to re-apply rules.', 'error')
    } finally {
      setReapplying(false)
    }
  }

  return (
    <div className="p-8 pt-14 max-w-6xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Finance</h1>
          <p className="text-sm text-muted-foreground">{format(new Date(), 'MMMM yyyy')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={pickFolder}
            className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground"
            title={watchFolder?.path}
          >
            <FolderOpen size={13} />
            {watchFolder?.path
              ? watchFolder.path.replace(/^.*?\/Documents\//, '~/Documents/')
              : 'Pick folder'}
          </button>
          <button
            onClick={ingest}
            disabled={ingesting}
            className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
          >
            {ingesting ? <RefreshCw size={14} className="animate-spin" /> : <Inbox size={14} />}
            {ingesting ? 'Processing…' : 'Process now'}
          </button>
        </div>
      </div>

      {/* Watch folder status */}
      {watchFolder && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-border bg-card flex items-center gap-3 text-xs">
          <Eye
            size={13}
            className={cn(watchFolder.isWatching ? 'text-emerald-400' : 'text-muted-foreground/50')}
          />
          <span className="text-foreground font-medium">
            {watchFolder.isWatching ? 'Watching' : 'Not watching'}
          </span>
          <span className="text-muted-foreground font-mono">{watchFolder.path}</span>
          {!watchFolder.exists && (
            <span className="ml-auto text-amber-400">folder doesn't exist</span>
          )}
          {watchFolder.exists && watchFolder.isWatching && (
            <span className="ml-auto text-muted-foreground/70">
              Drop CSVs / xlsx here — auto-processes
            </span>
          )}
        </div>
      )}

      {detectedAccounts.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs">
          <p className="text-emerald-300 font-medium mb-1">
            🎉 Detected {detectedAccounts.length} new account
            {detectedAccounts.length > 1 ? 's' : ''}
          </p>
          <p className="text-foreground/80">{detectedAccounts.join(' · ')}</p>
          {vaultSeeded > 0 && (
            <p className="text-muted-foreground mt-1">
              Created {vaultSeeded} stub{vaultSeeded > 1 ? 's' : ''} in Vault → Financial. Open the
              Vault to fill in account numbers.
            </p>
          )}
        </div>
      )}

      {lastIngest && (
        <div className="mb-4 px-3 py-2 rounded bg-secondary text-sm text-muted-foreground">
          Last ingest: {lastIngest.newTransactions} new, {lastIngest.duplicatesDropped} dupes from{' '}
          {lastIngest.filesProcessed} file(s).
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-border">
        {(
          [
            ['overview', 'Overview'],
            ['networth', 'Net Worth'],
            ['forecast', 'Forecast'],
            ['transactions', 'Transactions'],
            ['accounts', 'Accounts'],
            ['rules', 'Rules'],
            ['crsubs', 'CR & Subs']
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'px-4 py-2 text-sm border-b-2 -mb-px transition-colors',
              tab === key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <Overview
          totalDebt={totalDebt}
          wAPR={wAPR}
          monthIncome={monthIncome}
          monthExpense={monthExpense}
          savingsRate={savingsRate}
          totalBudget={totalBudget}
          totalActual={totalActual}
          debts={debts}
          budget={budget}
          crCapex={geoSummary?.crCapex ?? 0}
          subsAnnual={subscriptions?.totalActiveAnnual ?? 0}
          taxSummary={taxSummary}
          excludeProperty={excludeProperty}
          onToggleExcludeProperty={() => setExcludeProperty((v) => !v)}
        />
      )}

      {tab === 'networth' && <NetWorthTab />}

      {tab === 'forecast' && <ForecastTab accounts={accounts} />}

      {tab === 'crsubs' && <CrSubsTab geoSummary={geoSummary} subscriptions={subscriptions} />}

      {tab === 'transactions' && (
        <TransactionsTab
          txns={txns}
          accounts={accounts}
          onUpdate={updateTxn}
          onDelete={deleteTxn}
          onSetTaxTag={setTaxTag}
        />
      )}

      {tab === 'accounts' && (
        <AccountsTab accounts={accounts} onSave={saveAccount} onDelete={deleteAccount} />
      )}

      {tab === 'rules' && (
        <RulesTab
          rules={rules}
          onSave={saveRule}
          onDelete={deleteRule}
          onReapply={reapplyRules}
          reapplying={reapplying}
        />
      )}
    </div>
  )
}

// ─── Overview ────────────────────────────────────────────────────────────────

function Overview({
  totalDebt,
  wAPR,
  monthIncome,
  monthExpense,
  savingsRate,
  totalBudget,
  totalActual,
  debts,
  budget,
  crCapex,
  subsAnnual,
  taxSummary,
  excludeProperty,
  onToggleExcludeProperty
}: {
  totalDebt: number
  wAPR: number
  monthIncome: number
  monthExpense: number
  savingsRate: number
  totalBudget: number
  totalActual: number
  debts: Account[]
  budget: BudgetLine[]
  crCapex: number
  subsAnnual: number
  taxSummary: TaxSummary | null
  excludeProperty: boolean
  onToggleExcludeProperty: () => void
}): JSX.Element {
  // Property/Construction is the Costa Rica Airbnb capex — at 30-40% of total
  // spend it dominates every category view, so the user can toggle it out to
  // see the actual household-spend pattern.
  const visibleBudget = excludeProperty ? budget.filter((b) => b.category !== 'Property') : budget
  return (
    <>
      <div className="grid grid-cols-4 gap-3 mb-6">
        <Tile
          label="Total debt"
          value={fmtMoney(totalDebt)}
          sub={`${(wAPR * 100).toFixed(2)}% wAPR`}
          icon={<TrendingDown size={14} />}
          tone="bad"
        />
        <Tile
          label="Income (mo)"
          value={fmtMoney(monthIncome)}
          sub="excl. transfers"
          icon={<Wallet size={14} />}
          tone="good"
        />
        <Tile
          label="Spent (mo)"
          value={fmtMoney(monthExpense)}
          sub={`${totalBudget > 0 ? Math.round((totalActual / totalBudget) * 100) : 0}% of budget`}
          icon={<Target size={14} />}
        />
        <Tile
          label="Savings rate"
          value={`${(savingsRate * 100).toFixed(1)}%`}
          sub={savingsRate >= 0.2 ? 'On track' : 'Below 20%'}
          tone={savingsRate >= 0.2 ? 'good' : 'warn'}
        />
      </div>

      {(crCapex > 0 || subsAnnual > 0) && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          {crCapex > 0 && (
            <Tile
              label="CR build (capex, 12mo)"
              value={fmtMoney(crCapex)}
              sub="Airbnb construction investment"
            />
          )}
          {subsAnnual > 0 && (
            <Tile
              label="Subscriptions"
              value={`${fmtMoney(subsAnnual / 12)}/mo`}
              sub={`${fmtMoney(subsAnnual)}/yr active`}
            />
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3">Debts (avalanche order)</h3>
          {debts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No debts registered.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="text-left">Card</th>
                  <th className="text-right">Balance</th>
                  <th className="text-right">APR</th>
                </tr>
              </thead>
              <tbody>
                {[...debts]
                  .sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0))
                  .map((d) => (
                    <tr key={d.id} className="border-t border-border">
                      <td className="py-1.5">{d.name}</td>
                      <td className="text-right">{fmtMoney(d.balance ?? 0)}</td>
                      <td className="text-right">{((d.apr ?? 0) * 100).toFixed(2)}%</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">This month — top categories</h3>
            <button
              type="button"
              onClick={onToggleExcludeProperty}
              className={cn(
                'text-xs px-2 py-1 rounded border transition-colors',
                excludeProperty
                  ? 'bg-primary/10 text-primary border-primary/40'
                  : 'border-border text-muted-foreground hover:text-foreground'
              )}
              title="Hide CR Airbnb construction (Property) from the category view — its scale distorts everything else."
            >
              {excludeProperty ? '✓ ' : ''}Hide Property
            </button>
          </div>
          {visibleBudget.length === 0 ? (
            <p className="text-sm text-muted-foreground">No budget configured.</p>
          ) : (
            <div className="space-y-2">
              {[...visibleBudget]
                .sort((a, b) => b.actual - a.actual)
                .slice(0, 6)
                .map((b) => (
                  <div key={`${b.category}-${b.subcategory ?? ''}`}>
                    <div className="flex justify-between text-sm">
                      <span>
                        {b.category}
                        {b.subcategory ? ` / ${b.subcategory}` : ''}
                      </span>
                      <span className="text-muted-foreground">
                        {fmtMoney(b.actual)} / {fmtMoney(b.monthlyAmount)}
                      </span>
                    </div>
                    <div className="h-1 bg-secondary rounded-full overflow-hidden mt-1">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          b.pct > 1 ? 'bg-red-500' : 'bg-primary'
                        )}
                        style={{ width: `${Math.min(100, b.pct * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      {taxSummary &&
        (() => {
          const rows = taxSummary.tags.filter((row) => row.taxTag !== 'tax:none')
          return (
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">
                  Tax summary{' '}
                  <span className="text-muted-foreground font-normal">
                    · {taxSummary.year} year-to-date
                  </span>
                </h3>
                <span className="text-xs text-muted-foreground">
                  Expand a transaction in the Transactions tab to change its tax tag
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left">Tag</th>
                    <th className="text-right">Count</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.taxTag} className="border-t border-border">
                      <td className="py-1.5">
                        <TaxBadge tag={row.taxTag} source="auto" />
                        <span className="ml-2 text-muted-foreground text-xs">
                          {TAX_TAG_LABEL[row.taxTag] ?? row.taxTag}
                        </span>
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {row.count.toLocaleString()}
                      </td>
                      <td
                        className={cn(
                          'text-right tabular-nums',
                          row.total < 0 ? 'text-red-400' : 'text-emerald-400'
                        )}
                      >
                        {fmtSignedMoney(row.total)}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr className="border-t border-border">
                      <td colSpan={3} className="py-3 text-xs text-muted-foreground text-center">
                        {taxSummary.tags.length === 0
                          ? `No transactions yet for ${taxSummary.year}.`
                          : 'No tax-relevant transactions classified yet this year.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )
        })()}
    </>
  )
}

// ─── Net Worth Tab (Phase 4.4 UI) ────────────────────────────────────────────

type NetWorthSnapshot = Awaited<ReturnType<Window['api']['finance']['getNetWorthSnapshot']>>
type NetWorthTrajectory = Awaited<ReturnType<Window['api']['finance']['getNetWorthTrajectory']>>

const ASSET_CLASS_LABEL: Record<string, string> = {
  spending: 'Spending',
  savings: 'Savings',
  retirement: 'Retirement',
  real_estate: 'Real estate',
  manual_asset: 'Manual asset',
  liability: 'Liability'
}

function NetWorthTab(): JSX.Element {
  const [snapshot, setSnapshot] = useState<NetWorthSnapshot | null>(null)
  const [trajectory, setTrajectory] = useState<NetWorthTrajectory>([])
  const [loading, setLoading] = useState(true)
  const [capturing, setCapturing] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const { toast: showToast } = useToast()

  const refresh = useCallback(async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    setLoading(true)
    try {
      const [s, t] = await Promise.all([
        window.api.finance.getNetWorthSnapshot(),
        window.api.finance.getNetWorthTrajectory({ sinceDays: 365 })
      ])
      setSnapshot(s)
      setTrajectory(t)
    } catch (err) {
      console.error('[networth] refresh failed', err)
      showToast('Failed to load net worth.', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const capture = async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    setCapturing(true)
    try {
      const result = await window.api.finance.captureSnapshot()
      showToast(
        `Captured ${result.written} snapshot${result.written === 1 ? '' : 's'}.`,
        result.written > 0 ? 'success' : 'info'
      )
      await refresh()
    } catch (err) {
      console.error('[networth] capture failed', err)
      showToast('Capture failed.', 'error')
    } finally {
      setCapturing(false)
    }
  }

  const beginEdit = (accountId: number, currentBalance: number) => {
    setEditingId(accountId)
    setEditValue(String(currentBalance))
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditValue('')
  }

  const saveEdit = async (accountId: number) => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) {
      showToast('Cannot save balance outside the Electron app.', 'error')
      return
    }
    const balance = Number(editValue)
    if (!Number.isFinite(balance)) {
      showToast('Balance must be a number.', 'error')
      return
    }
    try {
      const result = await window.api.finance.setAccountBalance(accountId, balance)
      if (!result.success) {
        showToast(result.error ?? 'Failed to save balance.', 'error')
        return
      }
      cancelEdit()
      await refresh()
    } catch (err) {
      console.error('[networth] save failed', err)
      showToast('Save failed.', 'error')
    }
  }

  // Match the backend semantics — `is_debt` is the source of truth, not
  // `asset_class` (Accounts upsert IPC doesn't currently set asset_class).
  const chartData = buildTrajectoryChartData(trajectory)

  const hasAnySnapshot = snapshot?.byAccount.some((a) => a.capturedAt != null) ?? false
  const hasManualAssetWithoutBalance =
    snapshot?.byAccount.some((a) => a.assetClass === 'manual_asset' && a.capturedAt == null) ??
    false

  if (loading) {
    return <p className="text-sm text-muted-foreground p-4">Loading net worth…</p>
  }

  if (!snapshot) {
    return (
      <p className="text-sm text-muted-foreground p-4">Net worth unavailable. Try refreshing.</p>
    )
  }

  return (
    <div className="space-y-6">
      {/* 4-tile summary */}
      <div className="grid grid-cols-4 gap-4">
        <NetWorthTile label="Assets" value={fmtMoney(snapshot.assets)} />
        <NetWorthTile label="Liabilities" value={fmtMoney(snapshot.liabilities)} />
        <NetWorthTile label="Net worth" value={fmtMoney(snapshot.net)} emphasize />
        <NetWorthTile
          label="Δ 30d"
          value={snapshot.deltas.d30 == null ? '—' : fmtSignedMoney(snapshot.deltas.d30)}
          sub={
            snapshot.deltas.d90 == null
              ? undefined
              : `${fmtSignedMoney(snapshot.deltas.d90)} 90d · ${snapshot.deltas.d365 == null ? '—' : fmtSignedMoney(snapshot.deltas.d365)} 1y`
          }
        />
      </div>

      {/* Trajectory chart */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">Trajectory · last 12 months</h3>
            <p className="text-xs text-muted-foreground">
              Net worth (Assets − Liabilities) per snapshot date
            </p>
          </div>
          <button
            type="button"
            onClick={capture}
            disabled={capturing}
            className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-muted disabled:opacity-50"
          >
            {capturing ? 'Capturing…' : 'Capture now'}
          </button>
        </div>
        {chartData.length < 2 ? (
          <div className="py-8 text-center space-y-2">
            <p className="text-xs text-muted-foreground">
              {hasAnySnapshot
                ? 'Need at least 2 snapshot days to draw a trajectory. Capture again tomorrow.'
                : 'No snapshots yet. The nightly cron at 00:05 captures these automatically — or use "Capture now" to seed one.'}
            </p>
            {hasManualAssetWithoutBalance && (
              <p className="text-xs text-muted-foreground">
                Heads up: manual-asset accounts with a $0 balance get skipped. Use the table below
                to set their starting value.
              </p>
            )}
          </div>
        ) : (
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                <defs>
                  <linearGradient id="netGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickMargin={6}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(v) => fmtMoney(v as number)}
                  width={70}
                />
                <Tooltip
                  formatter={(v) => fmtMoney(Number(v))}
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    fontSize: 12
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="net"
                  stroke="hsl(var(--primary))"
                  fill="url(#netGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Per-account breakdown */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Accounts</h3>
          <span className="text-xs text-muted-foreground">
            Click "Set" on a manual asset to update its balance
          </span>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="text-left">Account</th>
              <th className="text-left">Class</th>
              <th className="text-right">Balance</th>
              <th className="text-left">Last captured</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snapshot.byAccount.map((a) => {
              const isManual = a.assetClass === 'manual_asset'
              const editing = editingId === a.accountId
              return (
                <tr key={a.accountId} className="border-t border-border">
                  <td className="py-1.5">{a.name}</td>
                  <td className="text-muted-foreground">
                    {ASSET_CLASS_LABEL[a.assetClass] ?? a.assetClass}
                  </td>
                  <td className="text-right tabular-nums">
                    {editing ? (
                      <input
                        type="number"
                        step="0.01"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        aria-label={`New balance for ${a.name}`}
                        // biome-ignore lint/a11y/noAutofocus: keyboard focus follows the click on the inline edit row, mirroring how the existing Accounts/Transactions inline editors behave
                        autoFocus
                        className="w-28 bg-background border border-border rounded px-2 py-1 text-right text-sm"
                      />
                    ) : (
                      <span className={a.isDebt ? 'text-foreground' : ''}>
                        {fmtMoney(a.balance)}
                      </span>
                    )}
                  </td>
                  <td className="text-muted-foreground text-xs">
                    {a.capturedAt ? format(new Date(a.capturedAt), 'yyyy-MM-dd') : 'never'}
                  </td>
                  <td className="text-right">
                    {isManual && !editing && (
                      <button
                        type="button"
                        onClick={() => beginEdit(a.accountId, a.balance)}
                        className="text-xs text-primary hover:underline"
                      >
                        Set
                      </button>
                    )}
                    {editing && (
                      <span className="space-x-2">
                        <button
                          type="button"
                          onClick={() => saveEdit(a.accountId)}
                          className="text-xs text-primary hover:underline"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="text-xs text-muted-foreground hover:underline"
                        >
                          Cancel
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function NetWorthTile({
  label,
  value,
  sub,
  emphasize
}: {
  label: string
  value: string
  sub?: string
  emphasize?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'bg-card border border-border rounded-xl p-4',
        emphasize && 'border-primary/50'
      )}
    >
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div
        className={cn('tabular-nums', emphasize ? 'text-2xl font-semibold' : 'text-xl font-medium')}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  )
}

/**
 * Roll up per-account snapshots into per-date `{ date, net }` chart points.
 * Latest known balance per account is forward-filled across days the chart
 * spans, so a single missing snapshot doesn't leave a hole in the line.
 *
 * Liabilities are classified by `isDebt` to match the backend's
 * `getNetWorthSnapshot` totals. (`asset_class` is informational only — the
 * Accounts upsert IPC doesn't always set it on debt accounts, so relying
 * on `assetClass === 'liability'` produces a chart that contradicts the
 * tile math.)
 */
export function buildTrajectoryChartData(
  trajectory: NetWorthTrajectory
): Array<{ date: string; net: number }> {
  if (trajectory.length === 0) return []

  // Group all snapshots by date (sorted), then walk forward maintaining the
  // latest known balance per account.
  const dates = Array.from(new Set(trajectory.map((p) => p.date))).sort()
  const latestByAccount = new Map<number, { balance: number; isDebt: boolean }>()

  // Pre-index trajectory by (date → accountId → snapshot)
  const byDate = new Map<string, NetWorthTrajectory>()
  for (const p of trajectory) {
    const list = byDate.get(p.date) ?? []
    list.push(p)
    byDate.set(p.date, list)
  }

  const out: Array<{ date: string; net: number }> = []
  for (const date of dates) {
    for (const p of byDate.get(date) ?? []) {
      latestByAccount.set(p.accountId, { balance: p.balance, isDebt: p.isDebt })
    }
    let assets = 0
    let liabilities = 0
    for (const { balance, isDebt } of latestByAccount.values()) {
      if (isDebt) liabilities += balance
      else assets += balance
    }
    out.push({ date, net: Math.round((assets - liabilities) * 100) / 100 })
  }
  return out
}

// ─── Forecast Tab (Phase 4.5 UI) ─────────────────────────────────────────────

type ForecastResult = Awaited<ReturnType<Window['api']['finance']['getForecast']>>
type ForecastEvent = ForecastResult['events'][number]

const SOURCE_LABEL: Record<string, string> = {
  subscription: 'Subscription',
  income: 'Income',
  debt: 'Debt payment',
  calendar: 'Calendar bill',
  override: 'Override'
}

const CONFIDENCE_DOT_CLASS: Record<string, string> = {
  high: 'bg-emerald-500',
  medium: 'bg-amber-500',
  low: 'bg-muted-foreground/40'
}

function ForecastTab({ accounts }: { accounts: Account[] }): JSX.Element {
  const [forecast, setForecast] = useState<ForecastResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ForecastEvent | null>(null)
  const { toast: showToast } = useToast()

  const refresh = useCallback(async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) {
      // Without the bridge there's nothing to load. Clear loading so the
      // tab shows the "Forecast unavailable" branch instead of being stuck
      // on the spinner forever.
      setForecast(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const result = await window.api.finance.getForecast({ windowDays: 90 })
      setForecast(result)
    } catch (err) {
      console.error('[forecast] refresh failed', err)
      showToast('Failed to load forecast.', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const accountName = (id: number | null): string =>
    id == null ? '—' : (accountById.get(id)?.name ?? `Account ${id}`)

  const chartData = forecast
    ? buildForecastChartData(forecast.trajectory)
    : { points: [] as Array<Record<string, number | string>>, accountIds: [] as number[] }
  const eventsByWeek = forecast ? groupEventsByWeek(forecast.events) : []

  if (loading) {
    return <p className="text-sm text-muted-foreground p-4">Loading forecast…</p>
  }

  if (!forecast) {
    return (
      <p className="text-sm text-muted-foreground p-4">Forecast unavailable. Try refreshing.</p>
    )
  }

  return (
    <div className="space-y-6">
      {/* Low-cash banner */}
      {forecast.lowDates.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-amber-500 mt-0.5" size={18} />
          <div className="flex-1">
            <h3 className="text-sm font-semibold mb-1">Cash low warning</h3>
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {forecast.lowDates.map((l) => (
                <li key={`${l.accountId}:${l.date}`}>
                  <span className="text-foreground font-medium">{accountName(l.accountId)}</span>{' '}
                  drops to {fmtMoney(l.balance)} on {l.date}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Trajectory chart */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">90-day trajectory</h3>
            <p className="text-xs text-muted-foreground">
              Per-account daily balance · combines subscriptions, income, debt minimums, calendar
              bills, and your overrides
            </p>
          </div>
        </div>
        {chartData.points.length < 2 ? (
          <p className="text-xs text-muted-foreground py-8 text-center">
            Not enough projected events to draw a trajectory.
          </p>
        ) : (
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData.points}
                margin={{ top: 10, right: 20, bottom: 10, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickMargin={6}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(v) => fmtMoney(v as number)}
                  width={70}
                />
                <Tooltip
                  formatter={(v) => fmtMoney(Number(v))}
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    fontSize: 12
                  }}
                />
                {chartData.accountIds.map((id, idx) => (
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={`acct_${id}`}
                    name={accountName(id)}
                    stroke={`hsl(var(--chart-${(idx % 5) + 1}, ${FALLBACK_COLORS[idx % FALLBACK_COLORS.length]}))`}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Event list grouped by week */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Projected events</h3>
          <span className="text-xs text-muted-foreground">
            {forecast.events.length} event{forecast.events.length === 1 ? '' : 's'} · click any row
            to skip / shift / override
          </span>
        </div>
        {eventsByWeek.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4">No projected events in the window.</p>
        ) : (
          <div className="space-y-4">
            {eventsByWeek.map((week) => (
              <div key={week.weekStart}>
                <div className="text-xs text-muted-foreground font-medium mb-1">
                  Week of {week.weekStart}
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {week.events.map((ev) => (
                      <tr
                        key={`${ev.date}:${ev.accountId}:${ev.label}:${ev.source}`}
                        // biome-ignore lint/a11y/useSemanticElements: clickable <tr> mirrors the Transactions tab pattern; a button child would break tabular flow
                        role="button"
                        tabIndex={0}
                        className={cn(
                          'border-t border-border hover:bg-muted/50 cursor-pointer',
                          ev.skipped && 'text-muted-foreground line-through'
                        )}
                        onClick={() => setEditing(ev)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setEditing(ev)
                          }
                        }}
                      >
                        <td className="py-1.5 w-20 text-xs tabular-nums">{ev.date}</td>
                        <td className="w-3">
                          <span
                            aria-label={`${ev.confidence} confidence`}
                            className={cn(
                              'inline-block w-2 h-2 rounded-full',
                              CONFIDENCE_DOT_CLASS[ev.confidence] ?? 'bg-muted-foreground/40'
                            )}
                          />
                        </td>
                        <td className="py-1.5">
                          {ev.label}
                          {ev.skipped && (
                            <span className="ml-2 text-xs text-amber-500 not-italic no-underline">
                              skipped — click to restore
                            </span>
                          )}
                        </td>
                        <td className="text-xs">{SOURCE_LABEL[ev.source] ?? ev.source}</td>
                        <td className="text-xs">{accountName(ev.accountId)}</td>
                        <td
                          className={cn(
                            'text-right tabular-nums',
                            !ev.skipped &&
                              (ev.amount < 0
                                ? 'text-red-500'
                                : ev.amount > 0
                                  ? 'text-emerald-500'
                                  : '')
                          )}
                        >
                          {ev.amount === 0 ? '?' : fmtSignedMoney(ev.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ForecastOverrideDialog
          event={editing}
          accountName={accountName(editing.accountId)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

// Tailwind `var(--chart-N)` aren't defined in the design tokens yet; these
// fallbacks keep multi-line charts readable in both light and dark themes.
const FALLBACK_COLORS = ['221 83% 53%', '142 71% 45%', '38 92% 50%', '262 83% 58%', '199 89% 48%']

/**
 * Build per-day chart points. Each point is `{ date, acct_<id>: balance, ... }`
 * so Recharts can render one line per account by indexing the keys directly.
 * Only emits dates where at least one account's balance changed (the trajectory
 * already produces points only on event days plus today's seed).
 */
export function buildForecastChartData(trajectory: ForecastResult['trajectory']): {
  points: Array<Record<string, number | string>>
  accountIds: number[]
} {
  if (trajectory.length === 0) return { points: [], accountIds: [] }

  const accountIds = Array.from(new Set(trajectory.map((p) => p.accountId))).sort((a, b) => a - b)
  // Date → accountId → latest balance on or before that date.
  const dates = Array.from(new Set(trajectory.map((p) => p.date))).sort()
  const latestByAccount = new Map<number, number>()

  // Index the trajectory by date for ordered walking.
  const byDate = new Map<string, ForecastResult['trajectory']>()
  for (const p of trajectory) {
    const list = byDate.get(p.date) ?? []
    list.push(p)
    byDate.set(p.date, list)
  }

  const points: Array<Record<string, number | string>> = []
  for (const date of dates) {
    for (const p of byDate.get(date) ?? []) {
      latestByAccount.set(p.accountId, p.balance)
    }
    const point: Record<string, number | string> = { date }
    for (const id of accountIds) {
      const v = latestByAccount.get(id)
      if (v !== undefined) point[`acct_${id}`] = v
    }
    points.push(point)
  }

  return { points, accountIds }
}

/**
 * Group forecast events into ISO-week buckets (week starts Monday). Events
 * inside each week stay in chronological order. Used by the event list UI.
 */
export function groupEventsByWeek(
  events: ForecastEvent[]
): Array<{ weekStart: string; events: ForecastEvent[] }> {
  const buckets = new Map<string, ForecastEvent[]>()
  for (const ev of events) {
    const weekStart = startOfIsoWeek(ev.date)
    const list = buckets.get(weekStart) ?? []
    list.push(ev)
    buckets.set(weekStart, list)
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, evs]) => ({
      weekStart,
      events: evs.slice().sort((a, b) => a.date.localeCompare(b.date))
    }))
}

/** Returns the ISO date string of the Monday in the same week as `dateStr`. */
function startOfIsoWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const dow = dt.getDay() // 0 = Sun, 1 = Mon, ... 6 = Sat
  const offsetToMonday = dow === 0 ? -6 : 1 - dow
  dt.setDate(dt.getDate() + offsetToMonday)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function ForecastOverrideDialog({
  event,
  accountName,
  onClose,
  onSaved
}: {
  event: ForecastEvent
  accountName: string
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const [kind, setKind] = useState<'skip' | 'shift' | 'override'>('skip')
  const [shiftDate, setShiftDate] = useState(event.date)
  const [amount, setAmount] = useState(String(event.amount))
  const [saving, setSaving] = useState(false)
  const { toast: showToast } = useToast()

  const submit = async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) {
      showToast('Cannot save override outside the Electron app.', 'error')
      return
    }
    if (event.accountId == null) {
      showToast('This event has no account; cannot override.', 'error')
      return
    }
    if (kind === 'shift' && !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      showToast('Shift date must be YYYY-MM-DD.', 'error')
      return
    }
    if (kind === 'override') {
      // Number('') === 0, so an empty/whitespace input would silently save
      // a zero override. Reject it explicitly so the user has to type
      // something — a real "0" is still allowed.
      if (amount.trim() === '' || !Number.isFinite(Number(amount))) {
        showToast('Override amount must be a number.', 'error')
        return
      }
    }
    setSaving(true)
    try {
      const result = await window.api.finance.setForecastOverride({
        accountId: event.accountId,
        date: event.date,
        label: event.label,
        kind,
        amount: kind === 'override' ? Number(amount) : null,
        shiftToDate: kind === 'shift' ? shiftDate : null
      })
      if (!result.success) {
        showToast(result.error ?? 'Failed to save override.', 'error')
        return
      }
      await onSaved()
    } catch (err) {
      console.error('[forecast] override failed', err)
      showToast('Override failed.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    if (event.accountId == null) return
    setSaving(true)
    try {
      // For shifted events, `event.date` is the SHIFTED display date;
      // override rows are keyed in the DB by the original auto-event date.
      // Without this fallback, Reset on a shifted row would delete nothing
      // and the shift would stay stuck in place.
      const dbKeyDate = event.originalDate ?? event.date
      const result = await window.api.finance.deleteForecastOverride(
        event.accountId,
        dbKeyDate,
        event.label
      )
      if (!result.success) {
        showToast(result.error ?? 'Failed to clear override.', 'error')
        return
      }
      await onSaved()
    } catch (err) {
      console.error('[forecast] clear failed', err)
      showToast('Clear failed.', 'error')
    } finally {
      setSaving(false)
    }
  }

  // Esc-to-close: bind a window listener while the dialog is mounted instead
  // of putting onKeyDown on the backdrop (Biome a11y rules dislike static
  // elements with key handlers).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <button
        type="button"
        aria-label="Close override dialog"
        onClick={onClose}
        // Excluded from keyboard tab order — Esc handles keyboard close, and
        // a viewport-sized invisible Tab stop just confuses users.
        tabIndex={-1}
        className="absolute inset-0 w-full h-full cursor-default"
      />
      <dialog
        open
        aria-modal="true"
        aria-labelledby="forecast-override-title"
        className="relative bg-card border border-border rounded-xl p-6 w-96 text-foreground open:flex open:flex-col gap-4 m-0"
      >
        <div>
          <h3 id="forecast-override-title" className="text-sm font-semibold">
            Override forecasted event
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            <span className="font-medium text-foreground">{event.label}</span> ·{' '}
            {fmtSignedMoney(event.amount)} on {event.date} · {accountName}
          </p>
        </div>
        <fieldset className="space-y-2">
          <legend className="sr-only">Override action</legend>
          {(['skip', 'shift', 'override'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="override-kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
              />
              <span className="capitalize">{k}</span>
              <span className="text-xs text-muted-foreground">
                {k === 'skip' && '— remove this event from the projection'}
                {k === 'shift' && '— move it to a different date'}
                {k === 'override' && '— change the amount'}
              </span>
            </label>
          ))}
        </fieldset>
        {kind === 'shift' && (
          <label className="block text-sm">
            <span className="block mb-1 text-xs text-muted-foreground">New date</span>
            <input
              type="date"
              value={shiftDate}
              onChange={(e) => setShiftDate(e.target.value)}
              className="w-full bg-background border border-border rounded px-2 py-1 text-sm"
            />
          </label>
        )}
        {kind === 'override' && (
          <label className="block text-sm">
            <span className="block mb-1 text-xs text-muted-foreground">
              New amount (negative = outflow)
            </span>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full bg-background border border-border rounded px-2 py-1 text-sm"
            />
          </label>
        )}
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={reset}
            disabled={saving}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Reset (clear any override)
          </button>
          <div className="space-x-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-sm border border-border rounded hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  )
}

// ─── CR & Subscriptions Tab ──────────────────────────────────────────────────

function CrSubsTab({
  geoSummary,
  subscriptions
}: {
  geoSummary: GeoSummary | null
  subscriptions: SubscriptionsData | null
}): JSX.Element {
  const totalGeo = geoSummary?.geo.reduce((s, g) => s + g.amount, 0) ?? 0
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-1">Geography of spend</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Last 12 months · derived from <code>geo:</code> tags on each transaction
          </p>
          {!geoSummary || geoSummary.geo.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No geography tags yet — re-ingest a CSV to populate.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="text-left">Country</th>
                  <th className="text-right">Spend</th>
                  <th className="text-right">Txns</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {geoSummary.geo.map((g) => (
                  <tr key={g.name} className="border-t border-border">
                    <td className="py-1.5">{g.name}</td>
                    <td className="text-right">{fmtMoney(g.amount)}</td>
                    <td className="text-right">{g.count.toLocaleString()}</td>
                    <td className="text-right">
                      {totalGeo > 0 ? `${((g.amount / totalGeo) * 100).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-1">Costa Rica purpose breakdown</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Capex (Airbnb build) · Operating · Household · Travel
          </p>
          {!geoSummary || geoSummary.purpose.length === 0 ? (
            <p className="text-sm text-muted-foreground">No CR transactions tagged.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="text-left">Purpose</th>
                  <th className="text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {geoSummary.purpose.map((p) => (
                  <tr key={p.name} className="border-t border-border">
                    <td className="py-1.5 capitalize">{p.name}</td>
                    <td className="text-right">{fmtMoney(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Active subscriptions</h3>
          {subscriptions && (
            <span className="text-xs text-muted-foreground">
              {subscriptions.active.length} active · {fmtMoney(subscriptions.totalActiveAnnual)}/yr
              · {fmtMoney(subscriptions.totalActiveAnnual / 12)}/mo
            </span>
          )}
        </div>
        {!subscriptions || subscriptions.active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No subscriptions detected. Need ≥3 charges with consistent cadence to qualify.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="text-left">Merchant</th>
                <th className="text-left">Account</th>
                <th className="text-left">Cadence</th>
                <th className="text-right">Each</th>
                <th className="text-right">Annual</th>
                <th className="text-left">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.active.map((s) => (
                <tr key={`${s.merchant}::${s.account}`} className="border-t border-border">
                  <td className="py-1.5">{s.merchant}</td>
                  <td className="text-muted-foreground">{s.account}</td>
                  <td>{s.cadence}</td>
                  <td className="text-right">{fmtMoney(s.medianAmount)}</td>
                  <td className="text-right font-medium">{fmtMoney(s.annualCost)}</td>
                  <td className="text-muted-foreground">{s.lastSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {subscriptions && subscriptions.zombies.length > 0 && (
        <div className="bg-card border border-amber-500/30 rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-1">
            Zombie subscriptions{' '}
            <span className="text-xs text-muted-foreground">— verify cancellation</span>
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            No charge in 60-180 days but historically recurring.
          </p>
          <ul className="space-y-1 text-sm">
            {subscriptions.zombies.map((z) => (
              <li key={`${z.merchant}::${z.account}`} className="text-muted-foreground">
                <span className="text-foreground font-medium">{z.merchant}</span> ({z.account},{' '}
                {z.cadence}) — last seen {z.lastSeen}, was {fmtMoney(z.annualCost)}/yr
              </li>
            ))}
          </ul>
        </div>
      )}

      {subscriptions && subscriptions.duplicates.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-1">Possible duplicates</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Same merchant billed across multiple accounts (could be PayPal-funded card showing on
            both).
          </p>
          <ul className="space-y-1 text-sm">
            {subscriptions.duplicates.slice(0, 10).map((d) => (
              <li key={d.merchant} className="text-muted-foreground">
                <span className="text-foreground font-medium">{d.merchant}</span> on{' '}
                {d.accounts.join(', ')} — combined {fmtMoney(d.combinedAnnual)}/yr
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── Transactions Tab ────────────────────────────────────────────────────────

function TransactionsTab({
  txns,
  accounts,
  onUpdate,
  onDelete,
  onSetTaxTag
}: {
  txns: Txn[]
  accounts: Account[]
  onUpdate: (
    id: number,
    updates: { category?: string; subcategory?: string; notes?: string; accountId?: number | null }
  ) => Promise<void>
  onDelete: (id: number) => Promise<void>
  onSetTaxTag: (id: number, taxTag: string) => Promise<void>
}): JSX.Element {
  const [expandedId, setExpandedId] = useState<number | null>(null)

  if (txns.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No transactions yet — drop bank CSVs in your inbox folder and click "Process inbox".
        </p>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <h3 className="text-sm font-semibold mb-3">
        Transactions{' '}
        <span className="text-muted-foreground font-normal">
          ({txns.length}) — click a row to edit
        </span>
      </h3>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="text-left">Date</th>
            <th className="text-left">Description</th>
            <th className="text-left">Category</th>
            <th className="text-left">Tax</th>
            <th className="text-right">Amount</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {txns.map((t) => (
            <TransactionRow
              key={t.id}
              txn={t}
              accounts={accounts}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onCancel={() => setExpandedId(null)}
              onSetTaxTag={onSetTaxTag}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TransactionRow({
  txn,
  accounts,
  expanded,
  onToggle,
  onUpdate,
  onDelete,
  onCancel,
  onSetTaxTag
}: {
  txn: Txn
  accounts: Account[]
  expanded: boolean
  onToggle: () => void
  onUpdate: (
    id: number,
    updates: { category?: string; subcategory?: string; notes?: string; accountId?: number | null }
  ) => Promise<void>
  onDelete: (id: number) => Promise<void>
  onCancel: () => void
  onSetTaxTag: (id: number, taxTag: string) => Promise<void>
}): JSX.Element {
  const [category, setCategory] = useState(txn.category ?? 'Uncategorized')
  const [customCategory, setCustomCategory] = useState('')
  const [subcategory, setSubcategory] = useState(txn.subcategory ?? '')
  const [notes, setNotes] = useState(txn.notes ?? '')
  const [accountId, setAccountId] = useState<number | ''>(txn.accountId ?? '')
  const [saving, setSaving] = useState(false)

  const isCustom = !PREDEFINED_CATEGORIES.includes(txn.category ?? '')

  useEffect(() => {
    if (expanded) {
      if (isCustom && txn.category) {
        setCategory('__custom__')
        setCustomCategory(txn.category)
      } else {
        setCategory(txn.category ?? 'Uncategorized')
        setCustomCategory('')
      }
      setSubcategory(txn.subcategory ?? '')
      setNotes(txn.notes ?? '')
      setAccountId(txn.accountId ?? '')
    }
  }, [expanded, txn, isCustom])

  async function save() {
    setSaving(true)
    try {
      const finalCategory =
        category === '__custom__' ? customCategory.trim() || 'Uncategorized' : category
      const updates: {
        category?: string
        subcategory?: string
        notes?: string
        accountId?: number | null
      } = {
        category: finalCategory,
        subcategory: subcategory.trim(),
        notes: notes.trim()
      }
      if (accountId !== (txn.accountId ?? '')) {
        updates.accountId = typeof accountId === 'number' ? accountId : null
      }
      await onUpdate(txn.id, updates)
      onCancel()
    } catch {
      // toast surfaced by parent
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <tr
        className={cn(
          'border-t border-border group cursor-pointer hover:bg-secondary/30',
          expanded && 'bg-secondary/40'
        )}
        onClick={() => !expanded && onToggle()}
        onKeyDown={(e) => {
          if (!expanded && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            onToggle()
          }
        }}
        // biome-ignore lint/a11y/useSemanticElements: a clickable <tr> in a data table is the natural affordance; a button child would break tabular flow.
        role="button"
        tabIndex={expanded ? -1 : 0}
      >
        <td className="py-1.5">{txn.date}</td>
        <td className="truncate max-w-[280px]">{txn.description}</td>
        <td className="text-muted-foreground">
          {txn.category ?? 'Uncategorized'}
          {txn.subcategory ? ` / ${txn.subcategory}` : ''}
        </td>
        <td>
          <TaxBadge tag={txn.taxTag ?? 'tax:none'} source={txn.taxTagSource ?? 'auto'} />
        </td>
        <td className={cn('text-right', txn.amount < 0 ? 'text-red-400' : 'text-emerald-400')}>
          {fmtMoney(txn.amount)}
        </td>
        <td className="text-right pr-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void onDelete(txn.id)
            }}
            aria-label="Delete transaction"
            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-colors"
          >
            <Trash2 size={13} />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-secondary/40">
          <td colSpan={6} className="px-3 py-4">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label
                  htmlFor={`txn-cat-${txn.id}`}
                  className="text-xs text-muted-foreground mb-1 block"
                >
                  Category
                </label>
                <select
                  id={`txn-cat-${txn.id}`}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                >
                  {PREDEFINED_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
                {category === '__custom__' && (
                  <input
                    type="text"
                    placeholder="Custom category"
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value)}
                    className="mt-2 w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                  />
                )}
              </div>
              <div>
                <label
                  htmlFor={`txn-sub-${txn.id}`}
                  className="text-xs text-muted-foreground mb-1 block"
                >
                  Subcategory
                </label>
                <input
                  id={`txn-sub-${txn.id}`}
                  type="text"
                  value={subcategory}
                  onChange={(e) => setSubcategory(e.target.value)}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label
                  htmlFor={`txn-acct-${txn.id}`}
                  className="text-xs text-muted-foreground mb-1 block"
                >
                  Account
                </label>
                <select
                  id={`txn-acct-${txn.id}`}
                  value={accountId === '' ? '' : String(accountId)}
                  onChange={(e) =>
                    setAccountId(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">— Unassigned —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor={`txn-taxtag-${txn.id}`}
                  className="text-xs text-muted-foreground mb-1 block"
                >
                  Tax tag
                  {txn.taxTagSource === 'user' && (
                    <span className="ml-1 text-amber-500">· manual override</span>
                  )}
                </label>
                <select
                  id={`txn-taxtag-${txn.id}`}
                  value={txn.taxTag ?? 'tax:none'}
                  onChange={(e) => {
                    void onSetTaxTag(txn.id, e.target.value)
                  }}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                >
                  {TAX_TAGS.map((t) => (
                    <option key={t} value={t}>
                      {TAX_TAG_LABEL[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label
                  htmlFor={`txn-notes-${txn.id}`}
                  className="text-xs text-muted-foreground mb-1 block"
                >
                  Notes
                </label>
                <textarea
                  id={`txn-notes-${txn.id}`}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Accounts Tab ────────────────────────────────────────────────────────────

type AccountFormState = {
  id?: number
  name: string
  type: string
  isDebt: boolean
  balance: string
  apr: string // user-entered as percent (e.g. "22.99")
  minPayment: string
  creditLimit: string
}

function emptyAccountForm(): AccountFormState {
  return {
    name: '',
    type: 'checking',
    isDebt: false,
    balance: '',
    apr: '',
    minPayment: '',
    creditLimit: ''
  }
}

function AccountsTab({
  accounts,
  onSave,
  onDelete
}: {
  accounts: Account[]
  onSave: (account: {
    id?: number
    name: string
    type: string
    isDebt?: boolean
    balance?: number
    apr?: number
    minPayment?: number
    creditLimit?: number
  }) => Promise<void>
  onDelete: (id: number) => Promise<void>
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<AccountFormState>(emptyAccountForm())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function startAdd() {
    setAdding(true)
    setEditingId(null)
    setForm(emptyAccountForm())
    setError(null)
  }

  function startEdit(a: Account) {
    setAdding(false)
    setEditingId(a.id)
    setForm({
      id: a.id,
      name: a.name,
      type: a.type,
      isDebt: !!a.isDebt,
      balance: a.balance != null ? String(a.balance) : '',
      apr: a.apr != null ? String(a.apr * 100) : '',
      minPayment: a.minPayment != null ? String(a.minPayment) : '',
      creditLimit: a.creditLimit != null ? String(a.creditLimit) : ''
    })
    setError(null)
  }

  function cancel() {
    setAdding(false)
    setEditingId(null)
    setForm(emptyAccountForm())
    setError(null)
  }

  async function submit() {
    if (!form.name.trim()) {
      setError('Name is required.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const aprPct = form.apr.trim() === '' ? undefined : Number(form.apr)
      const payload: {
        id?: number
        name: string
        type: string
        isDebt?: boolean
        balance?: number
        apr?: number
        minPayment?: number
        creditLimit?: number
      } = {
        name: form.name.trim(),
        type: form.type,
        isDebt: form.isDebt
      }
      if (form.id) payload.id = form.id
      if (form.balance.trim() !== '') payload.balance = Number(form.balance)
      if (form.isDebt && aprPct !== undefined && !Number.isNaN(aprPct)) payload.apr = aprPct / 100
      if (form.isDebt && form.minPayment.trim() !== '') payload.minPayment = Number(form.minPayment)
      if (form.isDebt && form.creditLimit.trim() !== '')
        payload.creditLimit = Number(form.creditLimit)

      await onSave(payload)
      cancel()
    } catch {
      // toast surfaced by parent
    } finally {
      setSaving(false)
    }
  }

  const showForm = adding || editingId !== null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Accounts ({accounts.length})</h3>
        {!showForm && (
          <button
            type="button"
            onClick={startAdd}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
          >
            <Plus size={14} /> Add account
          </button>
        )}
      </div>

      {showForm && (
        <div className="bg-card border border-primary/30 rounded-xl p-5">
          <h4 className="text-sm font-semibold mb-4">
            {editingId !== null ? 'Edit account' : 'New account'}
          </h4>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <FormField label="Name" required>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Chase Sapphire"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
            </FormField>
            <FormField label="Type" required>
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              >
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Current balance">
              <input
                type="number"
                step="0.01"
                value={form.balance}
                onChange={(e) => setForm((f) => ({ ...f, balance: e.target.value }))}
                placeholder="0.00"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
            </FormField>
            <FormField label="Is debt?">
              <label className="inline-flex items-center gap-2 text-sm py-2">
                <input
                  type="checkbox"
                  checked={form.isDebt}
                  onChange={(e) => setForm((f) => ({ ...f, isDebt: e.target.checked }))}
                  className="rounded border-border"
                />
                Treat balance as amount owed
              </label>
            </FormField>
            {form.isDebt && (
              <>
                <FormField label="APR (%)">
                  <input
                    type="number"
                    step="0.01"
                    value={form.apr}
                    onChange={(e) => setForm((f) => ({ ...f, apr: e.target.value }))}
                    placeholder="22.99"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                  />
                </FormField>
                <FormField label="Min payment">
                  <input
                    type="number"
                    step="0.01"
                    value={form.minPayment}
                    onChange={(e) => setForm((f) => ({ ...f, minPayment: e.target.value }))}
                    placeholder="25.00"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                  />
                </FormField>
                <FormField label="Credit limit">
                  <input
                    type="number"
                    step="0.01"
                    value={form.creditLimit}
                    onChange={(e) => setForm((f) => ({ ...f, creditLimit: e.target.value }))}
                    placeholder="10000.00"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                  />
                </FormField>
              </>
            )}
          </div>
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive mb-3">
              <AlertCircle size={14} /> {error}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={cancel}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save account'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-5">
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No accounts yet — add one to get started.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="text-left">Name</th>
                <th className="text-left">Type</th>
                <th className="text-right">Balance</th>
                <th className="text-right">APR</th>
                <th className="text-right">Credit limit</th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-t border-border group">
                  <td className="py-2">
                    {a.name}
                    {a.isDebt ? (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">
                        debt
                      </span>
                    ) : null}
                  </td>
                  <td className="text-muted-foreground capitalize">
                    {ACCOUNT_TYPES.find((t) => t.value === a.type)?.label ?? a.type}
                  </td>
                  <td className="text-right">{fmtMoney(a.balance ?? 0)}</td>
                  <td className="text-right">
                    {a.apr != null ? `${(a.apr * 100).toFixed(2)}%` : '—'}
                  </td>
                  <td className="text-right">
                    {a.creditLimit != null ? fmtMoney(a.creditLimit) : '—'}
                  </td>
                  <td className="text-right pr-1">
                    <div className="inline-flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => startEdit(a)}
                        aria-label="Edit account"
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(a.id)}
                        aria-label="Delete account"
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Rules Tab ───────────────────────────────────────────────────────────────

type RuleFormState = {
  id?: number
  pattern: string
  category: string
  customCategory: string
  subcategory: string
  priority: string
}

function emptyRuleForm(): RuleFormState {
  return {
    pattern: '',
    category: 'Uncategorized',
    customCategory: '',
    subcategory: '',
    priority: '100'
  }
}

function RulesTab({
  rules,
  onSave,
  onDelete,
  onReapply,
  reapplying
}: {
  rules: Rule[]
  onSave: (rule: {
    id?: number
    pattern: string
    category: string
    subcategory?: string
    priority?: number
  }) => Promise<void>
  onDelete: (id: number) => Promise<void>
  onReapply: () => Promise<void>
  reapplying: boolean
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<RuleFormState>(emptyRuleForm())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const sorted = [...rules].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))

  function startAdd() {
    setAdding(true)
    setEditingId(null)
    setForm(emptyRuleForm())
    setError(null)
  }

  function startEdit(r: Rule) {
    setAdding(false)
    setEditingId(r.id)
    const isCustom = !PREDEFINED_CATEGORIES.includes(r.category)
    setForm({
      id: r.id,
      pattern: r.pattern,
      category: isCustom ? '__custom__' : r.category,
      customCategory: isCustom ? r.category : '',
      subcategory: r.subcategory ?? '',
      priority: r.priority != null ? String(r.priority) : '100'
    })
    setError(null)
  }

  function cancel() {
    setAdding(false)
    setEditingId(null)
    setForm(emptyRuleForm())
    setError(null)
  }

  async function submit() {
    if (!form.pattern.trim()) {
      setError('Pattern is required.')
      return
    }
    const finalCategory =
      form.category === '__custom__' ? form.customCategory.trim() : form.category
    if (!finalCategory) {
      setError('Category is required.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const payload: {
        id?: number
        pattern: string
        category: string
        subcategory?: string
        priority?: number
      } = {
        pattern: form.pattern.trim().toLowerCase(),
        category: finalCategory,
        priority: form.priority.trim() === '' ? 100 : Number(form.priority)
      }
      if (form.id) payload.id = form.id
      if (form.subcategory.trim()) payload.subcategory = form.subcategory.trim()
      await onSave(payload)
      cancel()
    } catch {
      // toast surfaced by parent
    } finally {
      setSaving(false)
    }
  }

  const showForm = adding || editingId !== null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Categorization rules ({rules.length})</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onReapply()}
            disabled={reapplying}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
            title="Re-run all rules against every existing transaction"
          >
            <RefreshCw size={13} className={reapplying ? 'animate-spin' : ''} />
            {reapplying ? 'Applying…' : 'Re-apply to all'}
          </button>
          {!showForm && (
            <button
              type="button"
              onClick={startAdd}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
            >
              <Plus size={14} /> Add rule
            </button>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-secondary/60 text-xs text-muted-foreground">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Rules apply automatically to <strong>newly ingested</strong> transactions. Use{' '}
          <strong>Re-apply to all</strong> to update existing transactions after adding or changing
          rules.
        </span>
      </div>

      {showForm && (
        <div className="bg-card border border-primary/30 rounded-xl p-5">
          <h4 className="text-sm font-semibold mb-4">
            {editingId !== null ? 'Edit rule' : 'New rule'}
          </h4>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <FormField label="Pattern (substring, lowercased)" required>
              <input
                type="text"
                value={form.pattern}
                onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
                placeholder="e.g. starbucks"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
            </FormField>
            <FormField label="Priority (lower = first)">
              <input
                type="number"
                step="1"
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                placeholder="100"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
            </FormField>
            <FormField label="Category" required>
              <select
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              >
                {PREDEFINED_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value="__custom__">Custom…</option>
              </select>
              {form.category === '__custom__' && (
                <input
                  type="text"
                  value={form.customCategory}
                  onChange={(e) => setForm((f) => ({ ...f, customCategory: e.target.value }))}
                  placeholder="Custom category"
                  className="mt-2 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                />
              )}
            </FormField>
            <FormField label="Subcategory (optional)">
              <input
                type="text"
                value={form.subcategory}
                onChange={(e) => setForm((f) => ({ ...f, subcategory: e.target.value }))}
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
            </FormField>
          </div>
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive mb-3">
              <AlertCircle size={14} /> {error}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={cancel}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save rule'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-5">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No rules yet — add one to auto-categorize new transactions.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="text-left">Priority</th>
                <th className="text-left">Pattern</th>
                <th className="text-left">Category</th>
                <th className="text-left">Subcategory</th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="border-t border-border group">
                  <td className="py-2 text-muted-foreground tabular-nums">{r.priority ?? 0}</td>
                  <td className="font-mono text-xs">{r.pattern}</td>
                  <td>{r.category}</td>
                  <td className="text-muted-foreground">{r.subcategory ?? '—'}</td>
                  <td className="text-right pr-1">
                    <div className="inline-flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => startEdit(r)}
                        aria-label="Edit rule"
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(r.id)}
                        aria-label="Delete rule"
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function FormField({
  label,
  required,
  children
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </p>
      {children}
    </div>
  )
}

function Tile({
  label,
  value,
  sub,
  icon,
  tone
}: {
  label: string
  value: string
  sub?: string
  icon?: React.ReactNode
  tone?: 'good' | 'bad' | 'warn'
}): JSX.Element {
  const toneCls =
    tone === 'good'
      ? 'text-emerald-500'
      : tone === 'bad'
        ? 'text-red-500'
        : tone === 'warn'
          ? 'text-amber-500'
          : 'text-foreground'
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className={cn('text-xl font-semibold mt-1', toneCls)}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

function fmtMoney(n: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—'
  return (
    (n < 0 ? '-$' : '$') +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  )
}

function fmtSignedMoney(n: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}
