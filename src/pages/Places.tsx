import { Map as MapIcon, MapPin } from 'lucide-react'
import { useState } from 'react'
import DerivedEntityList from '../components/DerivedEntityList'

export default function Places(): JSX.Element {
  const [count, setCount] = useState<number | null>(null)
  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <MapPin size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Places</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {count
            ? 'The places you go, derived from your timeline'
            : 'The places you go — import your calendar, rides, or a location export on the Timeline to see them here'}
        </p>
      </div>

      {/* The map of everywhere you've been lands here (offline, from your local
          GPS history) — next slice of the curation arc. */}
      <div className="mb-6 rounded-lg border border-dashed border-border bg-card/40 px-4 py-6 flex items-center gap-3 text-sm text-muted-foreground">
        <MapIcon size={18} className="text-primary shrink-0" />A map of everywhere you've been is
        coming here — pins from your imported location history, fully offline.
      </div>

      <DerivedEntityList
        kind="place"
        searchPlaceholder="Find a place…"
        onCount={setCount}
        emptyState={
          <>
            No places yet. Import your <span className="text-foreground">calendar</span>,{' '}
            <span className="text-foreground">Uber/Lyft</span> rides, or a{' '}
            <span className="text-foreground">location history</span> export on the Timeline.
          </>
        }
      />
    </div>
  )
}
