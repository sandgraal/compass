/**
 * Plaid error decoding.
 *
 * The official `plaid` SDK is built on axios. When the Plaid API returns a
 * non-2xx (e.g. a 400 on `/link/token/create`), axios throws an error whose
 * `.message` is only the generic "Request failed with status code 400" — which
 * tells the user nothing. The *actual* diagnosis (an `error_code` like
 * `INVALID_API_KEYS` plus a human `error_message`) lives in the response body
 * at `err.response.data`.
 *
 * `extractPlaidError` pulls that body out (duck-typed, so we don't take an
 * axios type dependency) and `describePlaidFailure` collapses any error into a
 * `{ errorCode, errorMessage }` pair for a StartLinkResult — preferring the
 * Plaid body when present, falling back to the raw error message otherwise.
 */

export interface PlaidErrorInfo {
  /** Plaid's machine code, e.g. `INVALID_API_KEYS`, `INVALID_PRODUCTS`. */
  code: string
  /** Human-readable message (Plaid's `error_message`, augmented for common cases). */
  message: string
  /** HTTP status from the response, when available. */
  status: number | null
  /** Plaid `request_id`, useful when contacting Plaid support. */
  requestId: string | null
}

interface PlaidErrorBody {
  error_type?: unknown
  error_code?: unknown
  error_message?: unknown
  display_message?: unknown
  request_id?: unknown
}

/**
 * Pull the Plaid error body out of an axios-style error. Returns null when
 * `err` isn't a Plaid API error (a network failure, a programmer error, a
 * `PlaidNotConfiguredError`, etc. — none of which carry a Plaid `error_code`).
 */
export function extractPlaidError(err: unknown): PlaidErrorInfo | null {
  if (!err || typeof err !== 'object') return null
  const response = (err as { response?: { data?: unknown; status?: unknown } }).response
  if (!response || typeof response !== 'object') return null
  const data = (response as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null

  const body = data as PlaidErrorBody
  const code =
    typeof body.error_code === 'string' && body.error_code.length > 0 ? body.error_code : null
  if (!code) return null

  const human =
    (typeof body.error_message === 'string' && body.error_message) ||
    (typeof body.display_message === 'string' && body.display_message) ||
    code
  const status =
    typeof (response as { status?: unknown }).status === 'number'
      ? (response as { status: number }).status
      : null
  const requestId = typeof body.request_id === 'string' ? body.request_id : null

  let message = human
  // The single most common Connect-time 400 for a local app: the saved secret
  // doesn't match the client_id, or it's the wrong environment's secret.
  if (code === 'INVALID_API_KEYS') {
    message +=
      ' (Check that the Plaid secret saved in Compass matches your client_id and the configured environment — a sandbox secret used against production, or vice versa, returns this error.)'
  }

  return { code, message, status, requestId }
}

/**
 * Collapse any thrown error into the `{ errorCode, errorMessage }` shape a
 * `StartLinkResult` needs. Prefers the Plaid error body; otherwise uses
 * `fallbackCode` + the error's own message.
 */
export function describePlaidFailure(
  err: unknown,
  fallbackCode: string
): { errorCode: string; errorMessage: string } {
  const info = extractPlaidError(err)
  if (info) return { errorCode: info.code, errorMessage: info.message }
  const errorMessage = err instanceof Error ? err.message : String(err)
  return { errorCode: fallbackCode, errorMessage }
}
