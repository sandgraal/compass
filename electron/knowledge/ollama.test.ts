import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetOllamaCache, detectOllama } from './ollama'

describe('detectOllama cache behavior', () => {
  afterEach(() => {
    _resetOllamaCache()
    vi.unstubAllGlobals()
  })

  it('returns cached detection result when bypassCache is not set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }), { status: 200 })
      )
      .mockRejectedValueOnce(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)

    const first = await detectOllama()
    const second = await detectOllama()

    expect(first.available).toBe(true)
    expect(second.available).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bypasses cache when explicitly requested', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }), { status: 200 })
      )
      .mockRejectedValueOnce(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)

    const first = await detectOllama()
    const refreshed = await detectOllama({ bypassCache: true })

    expect(first.available).toBe(true)
    expect(refreshed.available).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
