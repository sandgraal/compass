import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'drizzle-kit'

const dataDir = join(homedir(), 'Library', 'Application Support', 'Compass', '.data')

export default defineConfig({
  schema: './electron/db/schema.ts',
  out: './electron/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: join(dataDir, 'compass.db')
  }
})
