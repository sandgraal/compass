import { defineConfig } from 'drizzle-kit'
import { join } from 'path'
import { homedir } from 'os'

const dataDir = join(homedir(), 'Library', 'Application Support', 'Compass', '.data')

export default defineConfig({
  schema: './electron/db/schema.ts',
  out: './electron/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: join(dataDir, 'compass.db')
  }
})
