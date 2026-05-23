import { afterEach, describe, expect, it } from 'vitest'
import { restoreEnvVar } from './env'

const ORIGINAL_TZ = process.env.TZ

afterEach(() => {
  restoreEnvVar('TZ', ORIGINAL_TZ)
})

describe('restoreEnvVar', () => {
  it('deletes the env var when its original value was unset', () => {
    process.env.TZ = 'UTC'

    restoreEnvVar('TZ', undefined)

    expect(process.env.TZ).toBeUndefined()
    expect('TZ' in process.env).toBe(false)
  })

  it('restores the original env var value when one existed', () => {
    process.env.TZ = 'UTC'

    restoreEnvVar('TZ', 'America/New_York')

    expect(process.env.TZ).toBe('America/New_York')
  })
})
