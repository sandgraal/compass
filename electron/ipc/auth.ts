import { IpcMain, BrowserWindow, safeStorage } from 'electron'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'
import { getDb } from '../db/client'
import { integrations } from '../db/schema'
import { eq } from 'drizzle-orm'

const TOKEN_KEY_PREFIX = 'compass_token_'
const OAUTH_PORT = 4242

export function saveToken(service: string, tokenData: object): void {
  const json = JSON.stringify(tokenData)
  const encrypted = safeStorage.encryptString(json)
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

const SUCCESS_HTML = `<!DOCTYPE html><html><head><title>Compass — Connected</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f1117;color:#e2e8f0;}
.box{text-align:center;}.icon{font-size:48px;margin-bottom:16px;}
h2{margin:0 0 8px;font-size:20px;}p{margin:0;color:#64748b;font-size:14px;}
</style></head><body><div class="box"><div class="icon">✓</div>
<h2>Connected!</h2><p>You can close this window and return to Compass.</p></div></body></html>`

const ERROR_HTML = (msg: string) =>
  `<!DOCTYPE html><html><head><title>Compass — Error</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f1117;color:#e2e8f0;}
.box{text-align:center;}.icon{font-size:48px;margin-bottom:16px;}
h2{margin:0 0 8px;font-size:20px;color:#f87171;}p{margin:0;color:#64748b;font-size:14px;}
</style></head><body><div class="box"><div class="icon">✗</div>
<h2>Connection failed</h2><p>${msg}</p></div></body></html>`

/**
 * Starts a temporary HTTP server on OAUTH_PORT, opens the auth URL in a popup
 * BrowserWindow, and waits for the OAuth provider to redirect back with ?code=.
 * Returns the code so the caller can exchange it for tokens.
 */
function waitForOAuthCode(
  authUrl: string,
  callbackPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let win: BrowserWindow | null = null
    let settled = false

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const reqUrl = new URL(req.url || '/', `http://localhost:${OAUTH_PORT}`)
        if (reqUrl.pathname !== callbackPath) {
          res.writeHead(404)
          res.end()
          return
        }

        const code = reqUrl.searchParams.get('code')
        const error = reqUrl.searchParams.get('error')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(ERROR_HTML(error))
          cleanup()
          if (!settled) { settled = true; reject(new Error(`OAuth error: ${error}`)) }
          return
        }

        if (!code) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(ERROR_HTML('No authorization code received'))
          cleanup()
          if (!settled) { settled = true; reject(new Error('No code in OAuth callback')) }
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(SUCCESS_HTML)
        cleanup()
        if (!settled) { settled = true; resolve(code) }
      } catch (e) {
        res.writeHead(500)
        res.end()
      }
    })

    server.listen(OAUTH_PORT, '127.0.0.1', () => {
      win = new BrowserWindow({
        width: 520,
        height: 680,
        show: true,
        alwaysOnTop: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      })
      win.loadURL(authUrl)
      win.on('closed', () => {
        if (!settled) {
          settled = true
          cleanup()
          reject(new Error('Auth window closed before completing sign-in'))
        }
      })
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        cleanup()
        reject(new Error(`Port ${OAUTH_PORT} is already in use. Close any other process using it and try again.`))
      } else {
        cleanup()
        reject(err)
      }
    })

    function cleanup() {
      try { server.close() } catch { /* ignore */ }
      try { if (win && !win.isDestroyed()) win.close() } catch { /* ignore */ }
      win = null
    }
  })
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  codeVerifier: string
): Promise<object> {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    ...(codeVerifier ? { code_verifier: codeVerifier } : {})
  })

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: params.toString()
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Token exchange failed (${resp.status}): ${body}`)
  }

  const tokens = await resp.json() as object
  if ('error' in tokens) {
    throw new Error(`Token error: ${(tokens as { error: string }).error}`)
  }
  return tokens
}

export function registerAuthHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('auth:connect-google', async () => {
    const clientId = process.env.GOOGLE_CLIENT_ID || ''
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || ''

    if (!clientId || clientId === 'your_google_client_id_here') {
      return { error: 'GOOGLE_CLIENT_ID not configured. Add it to your .env file — see the Setup Guide on the Integrations page.' }
    }
    if (!clientSecret || clientSecret === 'your_google_client_secret_here') {
      return { error: 'GOOGLE_CLIENT_SECRET not configured. Add it to your .env file.' }
    }

    const redirectUri = `http://localhost:${OAUTH_PORT}/oauth/google/callback`
    const scopes = [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]

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
      const code = await waitForOAuthCode(authUrl.toString(), '/oauth/google/callback')
      const tokens = await exchangeCodeForTokens(code, redirectUri, 'https://oauth2.googleapis.com/token', clientId, clientSecret, verifier)
      saveToken('google', tokens)

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

    if (!clientId || clientId === 'your_github_client_id_here') {
      return { error: 'GITHUB_CLIENT_ID not configured. Add it to your .env file — see the Setup Guide on the Integrations page.' }
    }
    if (!clientSecret || clientSecret === 'your_github_client_secret_here') {
      return { error: 'GITHUB_CLIENT_SECRET not configured. Add it to your .env file.' }
    }

    const redirectUri = `http://localhost:${OAUTH_PORT}/oauth/github/callback`
    const scopes = 'repo read:project read:user'

    const authUrl = new URL('https://github.com/login/oauth/authorize')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', scopes)

    try {
      const code = await waitForOAuthCode(authUrl.toString(), '/oauth/github/callback')
      // GitHub token endpoint returns application/x-www-form-urlencoded by default;
      // we request JSON via Accept header in exchangeCodeForTokens.
      const tokens = await exchangeCodeForTokens(code, redirectUri, 'https://github.com/login/oauth/access_token', clientId, clientSecret, '')
      saveToken('github', tokens)

      const db = getDb()
      db.insert(integrations).values({
        service: 'github',
        connectedAt: new Date(),
        status: 'connected',
        scopes: JSON.stringify(scopes.split(' '))
      }).onConflictDoUpdate({
        target: integrations.service,
        set: { connectedAt: new Date(), status: 'connected', scopes: JSON.stringify(scopes.split(' ')) }
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
