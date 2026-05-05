/**
 * Finance page — stub mirroring the layout patterns in Weekly.tsx and Daily.tsx.
 *
 * Wire-up:
 *   1. Add IPC types in src/types/electron.d.ts:
 *        finance: {
 *          ingestFolder: (folder?: string) => Promise<{ filesProcessed: number; newTransactions: number; duplicatesDropped: number }>
 *          getTransactions: (opts?: { month?: string; category?: string; limit?: number }) => Promise<Txn[]>
 *          getDebtSummary: () => Promise<{ debts: Debt[]; projection: { month: number; balance: number }[] }>
 *          getBudgetStatus: (month?: string) => Promise<{ lines: BudgetLine[]; totals: BudgetTotals }>
 *          setBudget: (line: BudgetLine) => Promise<{ success: boolean }>
 *        }
 *   2. Bridge those in electron/preload.ts via contextBridge.exposeInMainWorld.
 *   3. Add <Route path="/finance" element={<Finance />} /> in App.tsx.
 *   4. Add a sidebar entry in your layout.
 */

import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Wallet, TrendingDown, Target, RefreshCw, Inbox } from 'lucide-react'
import { cn } from '../lib/utils'

type Txn = { id: number; date: string; amount: number; description: string; category: string; subcategory?: string }
type Debt = { id: number; name: string; balance: number; apr: number; minPayment: number }
type BudgetLine = { category: string; subcategory?: string; monthlyAmount: number; actual: number; variance: number; pct: number }

export default function Finance(): JSX.Element {
  const [txns, setTxns] = useState<Txn[]>([])
  const [debts, setDebts] = useState<Debt[]>([])
  const [budget, setBudget] = useState<BudgetLine[]>([])
  const [ingesting, setIngesting] = useState(false)
  const [lastIngest, setLastIngest] = useState<{ filesProcessed: number; newTransactions: number; duplicatesDropped: number } | null>(null)

  const month = new Date().toISOString().slice(0, 7)

  const refresh = async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron || !window.api.finance) return
    const [t, d, b] = await Promise.all([
      window.api.finance.getTransactions({ month, limit: 50 }),
      window.api.finance.getDebtSummary(),
      window.api.finance.getBudgetStatus(month),
    ])
    setTxns(t)
    setDebts(d.debts)
    setBudget(b.lines)
  }

  const ingest = async () => {
    setIngesting(true)
    try {
      if (!window.api.finance) return
      const result = await window.api.finance.ingestFolder()
      setLastIngest(result)
      await refresh()
    } finally {
      setIngesting(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const totalDebt = debts.reduce((a, d) => a + d.balance, 0)
  const wAPR = totalDebt > 0 ? debts.reduce((a, d) => a + d.balance * d.apr, 0) / totalDebt : 0
  const totalBudget = budget.reduce((a, b) => a + b.monthlyAmount, 0)
  const totalActual = budget.reduce((a, b) => a + b.actual, 0)
  const monthIncome = txns.filter(t => t.amount > 0 && t.category !== 'Transfers').reduce((a, t) => a + t.amount, 0)
  const monthExpense = -txns.filter(t => t.amount < 0 && t.category !== 'Transfers').reduce((a, t) => a + t.amount, 0)
  const savingsRate = monthIncome > 0 ? (monthIncome - monthExpense) / monthIncome : 0

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Finance</h1>
          <p className="text-sm text-muted-foreground">{format(new Date(), 'MMMM yyyy')}</p>
        </div>
        <button onClick={ingest} disabled={ingesting}
          className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50">
          {ingesting ? <RefreshCw size={14} className="animate-spin" /> : <Inbox size={14} />}
          {ingesting ? 'Ingesting…' : 'Process inbox'}
        </button>
      </div>

      {lastIngest && (
        <div className="mb-4 px-3 py-2 rounded bg-secondary text-sm text-muted-foreground">
          Last ingest: {lastIngest.newTransactions} new, {lastIngest.duplicatesDropped} dupes from {lastIngest.filesProcessed} file(s).
        </div>
      )}

      {/* Tiles */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <Tile label="Total debt" value={fmtMoney(totalDebt)} sub={`${(wAPR * 100).toFixed(2)}% wAPR`} icon={<TrendingDown size={14} />} tone="bad" />
        <Tile label="Income (mo)" value={fmtMoney(monthIncome)} sub="excl. transfers" icon={<Wallet size={14} />} tone="good" />
        <Tile label="Spent (mo)" value={fmtMoney(monthExpense)} sub={`${budget.length ? Math.round(totalActual / totalBudget * 100) : 0}% of budget`} icon={<Target size={14} />} />
        <Tile label="Savings rate" value={`${(savingsRate * 100).toFixed(1)}%`} sub={savingsRate >= 0.2 ? 'On track' : 'Below 20%'} tone={savingsRate >= 0.2 ? 'good' : 'warn'} />
      </div>

      {/* Two-column: Debts + Budget */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3">Debts (avalanche order)</h3>
          {debts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No debts registered.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr><th className="text-left">Card</th><th className="text-right">Balance</th><th className="text-right">APR</th></tr>
              </thead>
              <tbody>
                {[...debts].sort((a, b) => b.apr - a.apr).map(d => (
                  <tr key={d.id} className="border-t border-border">
                    <td className="py-1.5">{d.name}</td>
                    <td className="text-right">{fmtMoney(d.balance)}</td>
                    <td className="text-right">{(d.apr * 100).toFixed(2)}%</td>
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
              {[...budget].sort((a, b) => b.actual - a.actual).slice(0, 6).map((b, i) => (
                <div key={i}>
                  <div className="flex justify-between text-sm">
                    <span>{b.category}{b.subcategory ? ` / ${b.subcategory}` : ''}</span>
                    <span className="text-muted-foreground">{fmtMoney(b.actual)} / {fmtMoney(b.monthlyAmount)}</span>
                  </div>
                  <div className="h-1 bg-secondary rounded-full overflow-hidden mt-1">
                    <div className={cn('h-full rounded-full', b.pct > 1 ? 'bg-red-500' : 'bg-primary')}
                         style={{ width: `${Math.min(100, b.pct * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent transactions */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h3 className="text-sm font-semibold mb-3">Recent transactions</h3>
        {txns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions yet — drop bank CSVs in your inbox folder and click "Process inbox".</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="text-left">Date</th><th className="text-left">Description</th><th className="text-left">Category</th><th className="text-right">Amount</th></tr>
            </thead>
            <tbody>
              {txns.slice(0, 25).map(t => (
                <tr key={t.id} className="border-t border-border">
                  <td className="py-1.5">{t.date}</td>
                  <td className="truncate max-w-[280px]">{t.description}</td>
                  <td className="text-muted-foreground">{t.category}{t.subcategory ? ` / ${t.subcategory}` : ''}</td>
                  <td className={cn('text-right', t.amount < 0 ? 'text-red-400' : 'text-emerald-400')}>{fmtMoney(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, sub, icon, tone }: { label: string; value: string; sub?: string; icon?: React.ReactNode; tone?: 'good' | 'bad' | 'warn' }): JSX.Element {
  const toneCls = tone === 'good' ? 'text-emerald-500' : tone === 'bad' ? 'text-red-500' : tone === 'warn' ? 'text-amber-500' : 'text-foreground'
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">{icon}{label}</div>
      <div className={cn('text-xl font-semibold mt-1', toneCls)}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

function fmtMoney(n: number): string {
  if (n === undefined || n === null || isNaN(n)) return '—'
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
