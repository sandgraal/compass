import { useEffect, useRef, useState } from 'react'

export interface UpdaterState {
  phase: UpdaterStatusPayload['phase'] | null
  version?: string
  releaseDate?: string
  percent?: number
  bytesPerSecond?: number
  total?: number
  errorMessage?: string
}

const INITIAL: UpdaterState = { phase: null }

export function useUpdateStatus(): UpdaterState {
  const [state, setState] = useState<UpdaterState>(INITIAL)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!window.api?.updater) return

    const unsubscribe = window.api.updater.onStatus((payload) => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current)
        resetTimerRef.current = null
      }

      switch (payload.phase) {
        case 'checking':
          setState({ phase: 'checking' })
          break
        case 'available':
          setState({
            phase: 'available',
            version: payload.version,
            releaseDate: payload.releaseDate
          })
          break
        case 'not-available':
          setState(INITIAL)
          break
        case 'downloading':
          // Use functional update to preserve `version`/`releaseDate` set by the
          // preceding `available` event — don't wipe them by replacing the whole object.
          setState((prev) => ({
            ...prev,
            phase: 'downloading',
            percent: payload.percent,
            bytesPerSecond: payload.bytesPerSecond,
            total: payload.total
          }))
          break
        case 'downloaded':
          setState({ phase: 'downloaded', version: payload.version })
          break
        case 'error':
          setState({ phase: 'error', errorMessage: payload.message })
          resetTimerRef.current = setTimeout(() => setState(INITIAL), 6_000)
          break
      }
    })

    return () => {
      unsubscribe()
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    }
  }, [])

  return state
}
