import { homedir } from 'node:os'
import { join } from 'node:path'

// Base "home" directory. Normally the OS home dir, but an explicit
// `COMPASS_HOME` override lets E2E / screenshot tooling redirect the ENTIRE
// data store (DB, vault, knowledge base) to a throwaway location without ever
// touching the real user's data. Opt-in only — unset = normal behaviour.
const HOME_BASE =
  process.env.COMPASS_HOME && process.env.COMPASS_HOME.trim().length > 0
    ? process.env.COMPASS_HOME
    : homedir()

export const APP_DATA_DIR = join(HOME_BASE, 'Library', 'Application Support', 'Compass')
export const DATA_DIR = join(APP_DATA_DIR, '.data')
export const VAULT_DIR = join(APP_DATA_DIR, '.vault')
export const KNOWLEDGE_DIR = join(APP_DATA_DIR, 'knowledge-base')
