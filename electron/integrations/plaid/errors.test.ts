/**
 * Tests for the Plaid error decoder — the helper that turns an opaque axios
 * "Request failed with status code 400" into Plaid's real error_code +
 * error_message (with an actionable hint for the common INVALID_API_KEYS case).
 */
import { describe, expect, it } from 'vitest'
import { describePlaidFailure, extractPlaidError } from './errors'

/** Shape a thrown Plaid SDK (axios) error: details live under response.data. */
function axiosPlaidError(body: Record<string, unknown>, status = 400): unknown {
  return {
    message: `Request failed with status code ${status}`,
    isAxiosError: true,
    response: { status, data: body }
  }
}

describe('extractPlaidError', () => {
  it('pulls error_code + error_message out of an axios 400 body', () => {
    const info = extractPlaidError(
      axiosPlaidError({
        error_type: 'INVALID_INPUT',
        error_code: 'INVALID_PRODUCTS',
        error_message: 'the products requested are not enabled',
        request_id: 'req-9'
      })
    )
    expect(info).toMatchObject({
      code: 'INVALID_PRODUCTS',
      message: 'the products requested are not enabled',
      status: 400,
      requestId: 'req-9'
    })
  })

  it('appends an env/secret hint for INVALID_API_KEYS', () => {
    const info = extractPlaidError(
      axiosPlaidError({
        error_code: 'INVALID_API_KEYS',
        error_message: 'invalid client_id or secret provided'
      })
    )
    expect(info?.code).toBe('INVALID_API_KEYS')
    expect(info?.message).toContain('invalid client_id or secret provided')
    expect(info?.message).toMatch(/sandbox.*production|environment/i)
  })

  it('falls back to display_message, then to the code, when error_message is absent', () => {
    expect(
      extractPlaidError(
        axiosPlaidError({ error_code: 'ITEM_LOGIN_REQUIRED', display_message: 'Please re-login' })
      )?.message
    ).toBe('Please re-login')
    expect(extractPlaidError(axiosPlaidError({ error_code: 'SOME_CODE' }))?.message).toBe(
      'SOME_CODE'
    )
  })

  it('returns null for non-Plaid errors (plain Error, network blip, junk)', () => {
    expect(extractPlaidError(new Error('socket hang up'))).toBeNull()
    expect(extractPlaidError({ response: { data: { message: 'no code here' } } })).toBeNull()
    expect(extractPlaidError({ response: {} })).toBeNull()
    expect(extractPlaidError(null)).toBeNull()
    expect(extractPlaidError('boom')).toBeNull()
  })
})

describe('describePlaidFailure', () => {
  it('prefers the Plaid body when present', () => {
    const out = describePlaidFailure(
      axiosPlaidError({ error_code: 'INVALID_API_KEYS', error_message: 'bad keys' }),
      'LINK_START_FAILED'
    )
    expect(out.errorCode).toBe('INVALID_API_KEYS')
    expect(out.errorMessage).toContain('bad keys')
  })

  it('falls back to the given code + the error message for a non-Plaid error', () => {
    expect(describePlaidFailure(new Error('socket hang up'), 'LINK_START_FAILED')).toEqual({
      errorCode: 'LINK_START_FAILED',
      errorMessage: 'socket hang up'
    })
  })

  it('stringifies a non-Error throw under the fallback code', () => {
    expect(describePlaidFailure('weird', 'EXCHANGE_FAILED')).toEqual({
      errorCode: 'EXCHANGE_FAILED',
      errorMessage: 'weird'
    })
  })
})
