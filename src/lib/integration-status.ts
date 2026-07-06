// Pure derivation of an integration card's display state.
//
// Extracted verbatim (in behavior) from the inline IIFE that used to live in
// src/pages/Integrations.tsx. Plaid + SimpleFIN are multi-connection: their
// "connected" / "error" state comes from the per-connection rows, not the
// singleton `integrations` row, and one bad connection among healthy ones must
// read as "Needs attention" rather than a quiet green "Connected". Keeping this
// pure lets us lock that logic with a unit test before/after the refactor.

/** Minimal shape of a per-connection row (Plaid item / SimpleFIN connection). */
export interface MultiConnRow {
  errorCode: string | null
  lastSyncedAt: number | null
}

export interface CardStatusInput {
  id: string
  /** `integrations.status` for this service ('connected' | 'error' | …). */
  baseStatus?: string | null
  /** `integrations.errorMessage` for this service. */
  baseErrorMessage?: string | null
  /** Whether a status row exists at all (drives the "not connected" glyph). */
  hasStatusRow?: boolean
  plaidItems?: MultiConnRow[]
  simplefinConnections?: MultiConnRow[]
}

export type CardStatusLabel = 'Connected' | 'Not connected' | 'Error' | 'Needs attention'

export interface CardState {
  isMultiConn: boolean
  isConnected: boolean
  hasError: boolean
  /** When true the status pill shows the error state (red) over "connected". */
  errorWins: boolean
  statusLabel: CardStatusLabel
  /** Card-level error message to surface persistently (null for multi-conn). */
  errorMessage: string | null
  /** True only when there is no status row and the card is single-connection. */
  showNotConnectedGlyph: boolean
}

export function deriveCardState(input: CardStatusInput): CardState {
  const isMultiConn = input.id === 'plaid' || input.id === 'simplefin'
  const baseIsConnected = input.baseStatus === 'connected'
  const baseHasError = input.baseStatus === 'error'

  const isConnected =
    input.id === 'plaid'
      ? (input.plaidItems?.length ?? 0) > 0
      : input.id === 'simplefin'
        ? (input.simplefinConnections?.length ?? 0) > 0
        : baseIsConnected

  const hasError =
    input.id === 'plaid'
      ? Boolean(input.plaidItems?.some((i) => i.errorCode))
      : input.id === 'simplefin'
        ? Boolean(input.simplefinConnections?.some((c) => c.errorCode))
        : baseHasError

  const errorWins = hasError && (isMultiConn || !isConnected)

  const statusLabel: CardStatusLabel = errorWins
    ? isMultiConn && isConnected
      ? 'Needs attention'
      : 'Error'
    : isConnected
      ? 'Connected'
      : 'Not connected'

  return {
    isMultiConn,
    isConnected,
    hasError,
    errorWins,
    statusLabel,
    // Per-connection errors render in the multi-conn body, so the card-level
    // banner only carries the singleton row's message.
    errorMessage: !isMultiConn && hasError ? (input.baseErrorMessage ?? null) : null,
    showNotConnectedGlyph: !input.hasStatusRow && !isMultiConn
  }
}
