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

type Tab = 'overview' | 'transactions' | 'accounts' | 'rules'

const ACCOUNT_TYPES = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit', label: 'Credit card' },
  { value: 'investment', label: 'Investment' }
] as const

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

export default function Finance(): JSX.Element {
  const [tab, setTab] = useState<Tab>('overview')
  const [txns, setTxns] = useState<Txn[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [debts, setDebts] = useState<Account[]>([])
  const [budget, setBudget] = useState<BudgetLine[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [ingesting, setIngesting] = useState(false)
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

  const { toast: showToast } = useToast()
  const confirm = useConfirm()

  const month = new Date().toISOString().slice(0, 7)

  const refresh = useCallback(async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    try {
      const [t, a, d, b, r] = await Promise.all([
        window.api.finance.getTransactions({ month, limit: 200 }),
        window.api.finance.getAccounts(),
        window.api.finance.getDebtSummary(),
        window.api.finance.getBudgetStatus(month),
        window.api.finance.getRules()
      ])
      setTxns(t)
      setAccounts(a)
      setDebts(d.debts as Account[])
      setBudget(b.lines)
      setRules(r)
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
    return unsub
  }, [refresh])

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
            ['transactions', 'Transactions'],
            ['accounts', 'Accounts'],
            ['rules', 'Rules']
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
        />
      )}

      {tab === 'transactions' && (
        <TransactionsTab
          txns={txns}
          accounts={accounts}
          onUpdate={updateTxn}
          onDelete={deleteTxn}
        />
      )}

      {tab === 'accounts' && (
        <AccountsTab accounts={accounts} onSave={saveAccount} onDelete={deleteAccount} />
      )}

      {tab === 'rules' && <RulesTab rules={rules} onSave={saveRule} onDelete={deleteRule} />}
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
  budget
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
}): JSX.Element {
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
          <h3 className="text-sm font-semibold mb-3">This month — top categories</h3>
          {budget.length === 0 ? (
            <p className="text-sm text-muted-foreground">No budget configured.</p>
          ) : (
            <div className="space-y-2">
              {[...budget]
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
    </>
  )
}

// ─── Transactions Tab ────────────────────────────────────────────────────────

function TransactionsTab({
  txns,
  accounts,
  onUpdate,
  onDelete
}: {
  txns: Txn[]
  accounts: Account[]
  onUpdate: (
    id: number,
    updates: { category?: string; subcategory?: string; notes?: string; accountId?: number | null }
  ) => Promise<void>
  onDelete: (id: number) => Promise<void>
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
  onCancel
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
          <td colSpan={5} className="px-3 py-4">
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
  onDelete
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

      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-secondary/60 text-xs text-muted-foreground">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Rules apply to <strong>newly ingested</strong> transactions. Existing transactions are not
          re-categorized — edit them individually on the Transactions tab. Lower priority numbers
          run first.
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
