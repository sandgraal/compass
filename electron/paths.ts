import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Compass')
export const DATA_DIR = join(APP_DATA_DIR, '.data')
export const VAULT_DIR = join(APP_DATA_DIR, '.vault')
export const KNOWLEDGE_DIR = join(APP_DATA_DIR, 'knowledge-base')
