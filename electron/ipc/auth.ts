import { IpcMain, BrowserWindow, safeStorage } from 'electron'
import { getDb } from '../db/client'
import { integrations } from '../db/schema'
import { eq } from 'drizzle-orm'

const TOKEN_KEY_PREFIX = 'compass_token_'

export function saveToken(service: string, tokenData: object): void {
  const json = JSON.stringify(tokenData)
  const encrypted = safeStorage.encryptString(json)
  // Store encrypted token in app data (not a file — in-memory map keyed to safeStorage)
  // We use electron-store pattern: write to a sidecar file as encrypted buffer
  const { join } = require('path')
  const { writeFileSync, mkdirSync } = require('fs')
  const { DATA_DIR } = require('../main')
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(join(DATA_DIR, `${TOKEN_KEY_PREFIX}${service}.enc`), encrypted)
}

export function loadToken(service: string): object | null {
  try {
    const { join } = require('path')
    const { readFileSync, existsSync } = require('fs')
    const { DATA_DIR } = require('../main')
    const path = join(DATA_DIR, `${TOKEN_KEY_PREFIX}${service}.enc`)
    if (!existsSync(path)) return null
    const encrypted = readFileSync(path)
    const json = safeStorage.decryptString(encrypted)
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function deleteToken(service: string): void {
  try {
    const { join } = require('path')
    const { unlinkSync, existsSync } = require('fs')
    const { DATA_DIR } = require('../main')
    const path = join(DATA_DIR, `${TOKEN_KEY_PREFIX}${service}.enc`)
    if (existsSync(path)) unlinkSync(path)
  } catch { /* ignore */ }
}

async function oauthFlow(
  authUrl: string,
  redirectUri: string,
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  code_verifier: string
): Promise<object> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 600,
      height: 700,
      show: true,
      modal: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })

    win.loadURL(authUrl)

    win.webContents.on('will-redirect', async (event, url) => {
      if (url.startsWith(redirectUri)) {
        event.preventDefault()
        const urlObj = new URL(url)
        const code = urlObj.searchParams.get('code')
        if (!code) {
          win.close()
          return reject(new Error('No code in redirect'))
        }

        win.close()

        // Exchange code for tokens
        const params = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          ...(code_verifier ? { code_verifier } : {})
        })

        const resp = await fetch(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
          body: params.toString()
        })

        if (!resp.ok) return reject(new Error(`Token exchange failed: ${resp.status}`))
        const tokens = await resp.json()
        resolve(tokens)
      }
    })

    win.on('closed', () => reject(new Error('Auth window closed by user')))
  })
}

export function registerAuthHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('auth:connect-google', async () => {
    const clientId = process.env.GOOGLE_CLIENT_ID || ''
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || ''

    if (!clientId) {
      return { error: 'GOOGLE_CLIENT_ID not set in .env' }
    }

    const redirectUri = 'http://localhost:4242/oauth/google/callback'
    const scopes = [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]

    // PKCE
    const { randomBytes, createHash } = require('crypto')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', scopes.join(' '))
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')

    try {
      const tokens = await oauthFlow(
        authUrl.toString(),
        redirectUri,
        'https://oauth2.googleapis.com/token',
        clientId,
        clientSecret,
        verifier
      )
      saveToken('google', tokens as object)

      const db = getDb()
      db.insert(integrations).values({
        service: 'google',
        connectedAt: new Date(),
        status: 'connected',
        scopes: JSON.stringify(scopes)
      }).onConflictDoUpdate({
        target: integrations.service,
        set: { connectedAt: new Date(), status: 'connected', scopes: JSON.stringify(scopes) }
      }).run()

      return { success: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('auth:connect-github', async () => {
    const clientId = process.env.GITHUB_CLIENT_ID || ''
    const clientSecret = process.env.GITHUB_CLIENT_SECRET || ''

    if (!clientId) {
      return { error: 'GITHUB_CLIENT_ID not set in .env' }
    }

    const redirectUri = 'http://localhost:4242/oauth/github/callback'
    const scopes = 'repo read:project read:user'

    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}`

    try {
      const tokens = await oauthFlow(
        authUrl,
        redirectUri,
        'https://github.com/login/oauth/access_token',
        clientId,
        clientSecret,
        ''
      )
      saveToken('github', tokens as object)

      const db = getDb()
      db.insert(integrations).values({
        service: 'github',
        connectedAt: new Date(),
        status: 'connected',
        scopes: JSON.stringify(scopes.split(' '))
      }).onConflictDoUpdate({
        target: integrations.service,
        set: { connectedAt: new Date(), status: 'connected' }
      }).run()

      return { success: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('auth:disconnect', async (_event, service: string) => {
    deleteToken(service)
    const db = getDb()
    db.update(integrations)
      .set({ status: 'disconnected', lastSyncedAt: null })
      .where(eq(integrations.service, service))
      .run()
    return { success: true }
  })

  ipcMain.handle('auth:get-status', () => {
    const db = getDb()
    const rows = db.select().from(integrations).all()
    return rows
  })
}
