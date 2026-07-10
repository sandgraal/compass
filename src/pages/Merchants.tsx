import { Store } from 'lucide-react'
import { useState } from 'react'
import DerivedEntityList from '../components/DerivedEntityList'

export default function Merchants(): JSX.Element {
  const [count, setCount] = useState<number | null>(null)
  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Store size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Merchants</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {count
            ? 'The businesses you buy from, derived from your timeline — save the ones you care about'
            : 'The businesses you buy from — import PayPal, Amazon, or Google Pay on the Timeline to see them here'}
        </p>
      </div>
      <DerivedEntityList
        kind="merchant"
        searchPlaceholder="Find a merchant…"
        onCount={setCount}
        emptyState={
          <>
            No merchants yet. Import a <span className="text-foreground">PayPal</span>,{' '}
            <span className="text-foreground">Amazon</span>, or{' '}
            <span className="text-foreground">Google Pay</span> export on the Timeline.
          </>
        }
      />
    </div>
  )
}
