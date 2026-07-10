import { MapPin } from 'lucide-react'
import { useEffect, useState } from 'react'
import DerivedEntityList from '../components/DerivedEntityList'
import LocationMap from '../components/LocationMap'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

export default function Places(): JSX.Element {
  const [mapData, setMapData] = useState<LocationMapData | null>(null)
  const [mapLoaded, setMapLoaded] = useState(false)

  useEffect(() => {
    if (!isElectron() || !window.api.location) {
      setMapLoaded(true)
      return
    }
    window.api.location
      .mapData()
      .then(setMapData)
      .catch(() => setMapData(null))
      .finally(() => setMapLoaded(true))
  }, [])

  const yearRange =
    mapData?.firstSeen != null && mapData.lastSeen != null
      ? `${new Date(mapData.firstSeen).getUTCFullYear()}–${new Date(mapData.lastSeen).getUTCFullYear()}`
      : null

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <MapPin size={22} className="text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Places</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {mapData && mapData.cells.length > 0 ? (
            <>
              <span className="font-semibold text-foreground">
                {mapData.totalPoints.toLocaleString()}
              </span>{' '}
              location points across{' '}
              <span className="font-semibold text-foreground">{mapData.cells.length}</span> places
              {yearRange && ` · ${yearRange}`} — all rendered locally, nothing leaves your machine
            </>
          ) : (
            'The places you go — import your calendar, rides, or a location export on the Timeline to see them here'
          )}
        </p>
      </div>

      {mapData && mapData.cells.length > 0 ? (
        <div className="mb-6">
          <LocationMap data={mapData} />
          {mapData.truncated && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Showing your {mapData.cells.length.toLocaleString()} most-visited places — rarely
              visited spots are omitted to keep the map fast.
            </p>
          )}
        </div>
      ) : mapLoaded ? (
        <div className="mb-6 rounded-lg border border-dashed border-border bg-card/40 px-4 py-6 flex items-center gap-3 text-sm text-muted-foreground">
          <MapPin size={18} className="text-primary shrink-0" />
          Import a location export (Google Location History / Takeout, GPX, OwnTracks, or an Amazon
          export) on the Timeline and your map of everywhere you've been appears here — fully
          offline.
        </div>
      ) : null}

      <DerivedEntityList
        kind="place"
        searchPlaceholder="Find a place…"
        emptyState={
          <>
            No named places yet. Import your <span className="text-foreground">calendar</span>,{' '}
            <span className="text-foreground">Uber/Lyft</span> rides, or a{' '}
            <span className="text-foreground">location history</span> export on the Timeline.
          </>
        }
      />
    </div>
  )
}
