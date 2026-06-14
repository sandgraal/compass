import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { join } from 'node:path'
import { URL } from 'node:url'
import { eq } from 'drizzle-orm'
import { BrowserWindow, type IpcMain, safeStorage } from 'electron'
import { getDb } from '../db/client'
import { integrations } from '../db/schema'
import { DATA_DIR } from '../paths'

const TOKEN_KEY_PREFIX = 'compass_token_'
const OAUTH_PORT = 4242
const GOOGLE_CALLBACK_PATH = '/oauth/google/callback'
const GITHUB_CALLBACK_PATH = '/oauth/github/callback'

export function saveToken(service: string, tokenData: object): void {
  const json = JSON.stringify(tokenData)
  const encrypted = safeStorage.encryptString(json)
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(join(DATA_DIR, `${TOKEN_KEY_PREFIX}${service}.enc`), encrypted)
}

export function loadToken(service: string): object | null {
  try {
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
    const path = join(DATA_DIR, `${TOKEN_KEY_PREFIX}${service}.enc`)
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* ignore */
  }
}

// =====================================================================
// OAuth client credentials (separate from access/refresh tokens)
// =====================================================================
// Pre-PR #N, Google OAuth client_id / client_secret had to live in a
// `.env` file at the repo root — fine for dev workflows, impossible for
// packaged-app users. These helpers move that storage into the same
// encrypted-on-disk pattern we use for access tokens, so the renderer
// can paste credentials into a form and never see them again.
//
// `getOAuthCredentials` reads the encrypted store first and falls back
// to `process.env` so existing dev workflows ("export GOOGLE_CLIENT_ID
// before `npm run dev`") still work.

const CREDS_KEY_PREFIX = 'compass_oauth_creds_'

export type OAuthCredentials = { clientId: string; clientSecret: string }

export function setOAuthCredentials(service: string, creds: OAuthCredentials): void {
  const json = JSON.stringify(creds)
  const encrypted = safeStorage.encryptString(json)
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(join(DATA_DIR, `${CREDS_KEY_PREFIX}${service}.enc`), encrypted)
}

export function getOAuthCredentials(service: string): OAuthCredentials | null {
  // 1. Encrypted store (preferred).
  try {
    const path = join(DATA_DIR, `${CREDS_KEY_PREFIX}${service}.enc`)
    if (existsSync(path)) {
      const encrypted = readFileSync(path)
      const json = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(json) as Partial<OAuthCredentials>
      if (parsed.clientId && parsed.clientSecret) {
        return { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
      }
    }
  } catch {
    /* fall through to env */
  }
  // 2. `.env` fallback for dev workflows.
  const upper = service.toUpperCase()
  const envId = process.env[`${upper}_CLIENT_ID`] || ''
  const envSecret = process.env[`${upper}_CLIENT_SECRET`] || ''
  if (envId && envId !== `your_${service.toLowerCase()}_client_id_here` && envSecret) {
    return { clientId: envId, clientSecret: envSecret }
  }
  return null
}

export function hasOAuthCredentials(service: string): boolean {
  return getOAuthCredentials(service) !== null
}

export function deleteOAuthCredentials(service: string): void {
  try {
    const path = join(DATA_DIR, `${CREDS_KEY_PREFIX}${service}.enc`)
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* ignore */
  }
}

const SUCCESS_HTML = `<!DOCTYPE html><html><head><title>Compass — Connected</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f1117;color:#e2e8f0;}
.box{text-align:center;}.icon{font-size:48px;margin-bottom:16px;}
h2{margin:0 0 8px;font-size:20px;}p{margin:0;color:#64748b;font-size:14px;}
</style></head><body><div class="box"><div class="icon">✓</div>
<h2>Connected!</h2><p>You can close this window and return to Compass.</p></div></body></html>`

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

const ERROR_HTML = (msg: string) =>
  `<!DOCTYPE html><html><head><title>Compass — Error</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f1117;color:#e2e8f0;}
.box{text-align:center;}.icon{font-size:48px;margin-bottom:16px;}
h2{margin:0 0 8px;font-size:20px;color:#f87171;}p{margin:0;color:#64748b;font-size:14px;}
</style></head><body><div class="box"><div class="icon">✗</div>
<h2>Connection failed</h2><p>${escapeHtml(msg)}</p></div></body></html>`

/**
 * Starts a temporary HTTP server on OAUTH_PORT, opens the auth URL in a popup
 * BrowserWindow, and waits for the OAuth provider to redirect back with ?code=.
 * Validates the `state` query parameter to prevent CSRF attacks.
 * Returns the code so the caller can exchange it for tokens.
 */
function waitForOAuthCode(
  authUrl: string,
  callbackPath: string,
  expectedState: string
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
        const returnedState = reqUrl.searchParams.get('state')

        if (returnedState !== expectedState) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(ERROR_HTML('Invalid state parameter. Request may have been tampered with.'))
          cleanup()
          if (!settled) {
            settled = true
            reject(new Error('OAuth state mismatch — possible CSRF attack'))
          }
          return
        }

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(ERROR_HTML(error))
          cleanup()
          if (!settled) {
            settled = true
            reject(new Error(`OAuth error: ${error}`))
          }
          return
        }

        if (!code) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(ERROR_HTML('No authorization code received'))
          cleanup()
          if (!settled) {
            settled = true
            reject(new Error('No code in OAuth callback'))
          }
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(SUCCESS_HTML)
        cleanup()
        if (!settled) {
          settled = true
          resolve(code)
        }
      } catch (e) {
        res.writeHead(500)
        res.end()
        cleanup()
        if (!settled) {
          settled = true
          reject(e instanceof Error ? e : new Error('Internal error handling OAuth callback'))
        }
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
        reject(
          new Error(
            `Port ${OAUTH_PORT} is already in use. Close any other process using it and try again.`
          )
        )
      } else {
        cleanup()
        reject(err)
      }
    })

    function cleanup() {
      try {
        server.close()
      } catch {
        /* ignore */
      }
      try {
        if (win && !win.isDestroyed()) win.close()
      } catch {
        /* ignore */
      }
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
      Accept: 'application/json'
    },
    body: params.toString()
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Token exchange failed (${resp.status}): ${body}`)
  }

  const tokens = (await resp.json()) as {
    error?: string
    expires_in?: number
    [key: string]: unknown
  }
  if (tokens.error) {
    throw new Error(`Token error: ${tokens.error}`)
  }
  // Stamp an absolute expiry so getValidGoogleToken() can check without a clock skew
  if (tokens.expires_in) {
    tokens.expires_at = Date.now() + tokens.expires_in * 1000
  }
  return tokens
}

/**
 * Refreshes a Google access token using the stored refresh_token.
 * Saves the updated token bundle (new access_token + expiry) back to disk.
 * Returns the fresh access token, or throws if refresh fails.
 */
export async function refreshGoogleToken(): Promise<string> {
  const tokens = loadToken('google') as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    token_type?: string
  } | null

  if (!tokens?.refresh_token) {
    throw new Error('No refresh token stored — please reconnect Google.')
  }

  // Reuse the same credential lookup as the initial OAuth dance so packaged-
  // app users who pasted creds via the inline form can refresh their access
  // token. Without this, refresh quietly fell back to process.env (empty on
  // packaged builds) and every refresh failed with an opaque 400.
  const creds = getOAuthCredentials('google')
  if (!creds) {
    throw new Error(
      'Google credentials not configured — open Integrations, click Connect on the Google card, and re-enter your Client ID + Secret.'
    )
  }

  const params = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token'
  })

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString()
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Google token refresh failed (${resp.status}): ${body}`)
  }

  const refreshed = (await resp.json()) as { access_token: string; expires_in: number }

  // Merge new access token into the existing token bundle (preserve refresh_token)
  const updated = {
    ...tokens,
    access_token: refreshed.access_token,
    expires_in: refreshed.expires_in
  }
  saveToken('google', updated)

  return refreshed.access_token
}

/**
 * Returns a valid Google access token, automatically refreshing if expired or close to expiry.
 * Call this instead of reading the token directly in sync handlers.
 */
export async function getValidGoogleToken(): Promise<string> {
  const tokens = loadToken('google') as {
    access_token?: string
    refresh_token?: string
    expires_at?: number // ms epoch — we set this on save
  } | null

  if (!tokens?.access_token) {
    throw new Error('Google not connected')
  }

  // Refresh if within 5 minutes of expiry (or no expiry tracked yet)
  const now = Date.now()
  const expiresAt = tokens.expires_at ?? 0
  if (expiresAt - now < 5 * 60 * 1000) {
    return refreshGoogleToken()
  }

  return tokens.access_token
}

export function registerAuthHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('auth:connect-google', async () => {
    const creds = getOAuthCredentials('google')
    if (!creds) {
      return {
        error:
          'Google credentials not configured. Click Connect on the Google card to paste your Client ID + Secret.'
      }
    }
    const { clientId, clientSecret } = creds

    const redirectUri = `http://localhost:${OAUTH_PORT}${GOOGLE_CALLBACK_PATH}`
    const scopes = [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]

    const { randomBytes, createHash } = require('node:crypto')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('base64url')

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', scopes.join(' '))
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)

    try {
      const code = await waitForOAuthCode(authUrl.toString(), GOOGLE_CALLBACK_PATH, state)
      const tokens = await exchangeCodeForTokens(
        code,
        redirectUri,
        'https://oauth2.googleapis.com/token',
        clientId,
        clientSecret,
        verifier
      )
      saveToken('google', tokens)

      const db = getDb()
      db.insert(integrations)
        .values({
          service: 'google',
          connectedAt: new Date(),
          status: 'connected',
          scopes: JSON.stringify(scopes)
        })
        .onConflictDoUpdate({
          target: integrations.service,
          set: { connectedAt: new Date(), status: 'connected', scopes: JSON.stringify(scopes) }
        })
        .run()

      return { success: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('auth:connect-github', async () => {
    const clientId = process.env.GITHUB_CLIENT_ID || ''
    const clientSecret = process.env.GITHUB_CLIENT_SECRET || ''

    if (!clientId || clientId === 'your_github_client_id_here') {
      return {
        error:
          'GITHUB_CLIENT_ID not configured. Add it to your .env file — see the Setup Guide on the Integrations page.'
      }
    }
    if (!clientSecret || clientSecret === 'your_github_client_secret_here') {
      return { error: 'GITHUB_CLIENT_SECRET not configured. Add it to your .env file.' }
    }

    const redirectUri = `http://localhost:${OAUTH_PORT}${GITHUB_CALLBACK_PATH}`
    const scopes = 'repo read:project read:user'

    const { randomBytes } = require('node:crypto')
    const state = randomBytes(16).toString('base64url')

    const authUrl = new URL('https://github.com/login/oauth/authorize')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', scopes)
    authUrl.searchParams.set('state', state)

    try {
      const code = await waitForOAuthCode(authUrl.toString(), GITHUB_CALLBACK_PATH, state)
      // GitHub token endpoint returns application/x-www-form-urlencoded by default;
      // we request JSON via Accept header in exchangeCodeForTokens.
      const tokens = await exchangeCodeForTokens(
        code,
        redirectUri,
        'https://github.com/login/oauth/access_token',
        clientId,
        clientSecret,
        ''
      )
      saveToken('github', tokens)

      const db = getDb()
      db.insert(integrations)
        .values({
          service: 'github',
          connectedAt: new Date(),
          status: 'connected',
          scopes: JSON.stringify(scopes.split(' '))
        })
        .onConflictDoUpdate({
          target: integrations.service,
          set: {
            connectedAt: new Date(),
            status: 'connected',
            scopes: JSON.stringify(scopes.split(' '))
          }
        })
        .run()

      return { success: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // PAT-based GitHub connect. Skips the OAuth dance entirely: user pastes a
  // Personal Access Token, we validate it against /user, and store it in the
  // same encrypted shape as an OAuth access_token (so syncGitHub doesn't care
  // which way the credential was acquired). Much friendlier than walking a
  // non-developer through registering an OAuth App.
  //
  // Token shape accepted:
  //   - Classic PATs: `ghp_...` (typically 36+ chars, mixed alphanumeric)
  //   - Fine-grained PATs: `github_pat_...` (longer, two-segment)
  // Anything else fails the regex below before we even hit the network.
  ipcMain.handle('auth:connect-github-pat', async (_event, token: string) => {
    if (typeof token !== 'string') {
      return { error: 'Token must be a string.' }
    }
    const trimmed = token.trim()
    if (!/^(ghp_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})$/.test(trimmed)) {
      return {
        error:
          "That doesn't look like a GitHub Personal Access Token. Expected a string starting with `ghp_` (classic) or `github_pat_` (fine-grained)."
      }
    }
    try {
      const userResp = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${trimmed}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Compass'
        }
      })
      if (userResp.status === 401) {
        return { error: 'Token rejected by GitHub (401). It may be expired or revoked.' }
      }
      if (!userResp.ok) {
        return { error: `GitHub responded with HTTP ${userResp.status}.` }
      }
      const user = (await userResp.json()) as { login?: string }
      if (!user.login) {
        return { error: 'GitHub returned a 200 with no `login` field — unexpected.' }
      }

      // Surface the granted scopes so the user can see at a glance what
      // Compass can do with this token. Fine-grained PATs may omit this
      // header or return it empty (their permissions live in a different
      // format); fall back to the `fine-grained` sentinel in that case.
      const rawScopes = userResp.headers.get('x-oauth-scopes')
      const parsedScopes = rawScopes
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const grantedScopes =
        parsedScopes && parsedScopes.length > 0 ? parsedScopes : ['fine-grained']

      saveToken('github', { access_token: trimmed, auth_method: 'pat', login: user.login })

      const db = getDb()
      db.insert(integrations)
        .values({
          service: 'github',
          connectedAt: new Date(),
          status: 'connected',
          scopes: JSON.stringify(grantedScopes)
        })
        .onConflictDoUpdate({
          target: integrations.service,
          set: {
            connectedAt: new Date(),
            status: 'connected',
            scopes: JSON.stringify(grantedScopes)
          }
        })
        .run()

      return { success: true, login: user.login }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // Notion internal-integration token (Phase 7 Track B). Same paste-once
  // PAT pattern as GitHub: validate the format, prove it works against
  // /v1/users/me, encrypt to disk, flip the integrations row. Only pages
  // the user explicitly shares with the integration are visible to the API,
  // so Notion's own sharing model is the consent surface.
  ipcMain.handle('auth:connect-notion', async (_event, token: string) => {
    if (typeof token !== 'string') {
      return { error: 'Token must be a string.' }
    }
    const trimmed = token.trim()
    if (!/^(ntn_|secret_)[A-Za-z0-9]{20,255}$/.test(trimmed)) {
      return {
        error:
          "That doesn't look like a Notion integration token. Expected a string starting with `ntn_` (or legacy `secret_`) from notion.so/my-integrations."
      }
    }
    try {
      const meResp = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          Authorization: `Bearer ${trimmed}`,
          'Notion-Version': '2022-06-28'
        }
      })
      if (meResp.status === 401) {
        return { error: 'Token rejected by Notion (401). It may be revoked or mistyped.' }
      }
      if (!meResp.ok) {
        return { error: `Notion responded with HTTP ${meResp.status}.` }
      }
      const me = (await meResp.json()) as {
        name?: string
        bot?: { workspace_name?: string }
      }
      const workspace = me.bot?.workspace_name ?? me.name ?? null

      saveToken('notion', {
        access_token: trimmed,
        auth_method: 'internal-integration',
        workspace
      })

      const db = getDb()
      db.insert(integrations)
        .values({
          service: 'notion',
          connectedAt: new Date(),
          status: 'connected',
          scopes: JSON.stringify(['pages:read'])
        })
        .onConflictDoUpdate({
          target: integrations.service,
          set: {
            connectedAt: new Date(),
            status: 'connected',
            scopes: JSON.stringify(['pages:read'])
          }
        })
        .run()

      return { success: true, workspace }
    } catch (err) {
      // Non-Error throws (e.g. a re-thrown string) must still produce a
      // string error, or the renderer gets `{ error: undefined }`.
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Linear personal API key (Phase 7 Track B). Paste-once, like the GitHub
  // PAT: validate the format, prove it works against the GraphQL `viewer`,
  // encrypt to disk, flip the integrations row. Linear personal keys go in
  // the Authorization header verbatim (no `Bearer` prefix — that's OAuth).
  ipcMain.handle('auth:connect-linear', async (_event, token: string) => {
    if (typeof token !== 'string') {
      return { error: 'Token must be a string.' }
    }
    const trimmed = token.trim()
    if (!/^lin_api_[A-Za-z0-9]{16,255}$/.test(trimmed)) {
      return {
        error:
          "That doesn't look like a Linear API key. Create a Personal API key (starts with `lin_api_`) in Linear → Settings → Security & access → API."
      }
    }
    try {
      const resp = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: trimmed, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ viewer { id name } }' })
      })
      if (resp.status === 401 || resp.status === 400) {
        return { error: 'Linear rejected the key (auth failed). It may be revoked or mistyped.' }
      }
      if (!resp.ok) {
        return { error: `Linear responded with HTTP ${resp.status}.` }
      }
      const json = (await resp.json()) as {
        data?: { viewer?: { name?: string } }
        errors?: Array<{ message: string }>
      }
      if (json.errors?.length || !json.data?.viewer) {
        return { error: 'Linear rejected the key (auth failed). It may be revoked or mistyped.' }
      }
      const name = json.data.viewer.name ?? null

      saveToken('linear', { access_token: trimmed, auth_method: 'personal-api-key', name })

      const db = getDb()
      db.insert(integrations)
        .values({
          service: 'linear',
          connectedAt: new Date(),
          status: 'connected',
          scopes: JSON.stringify(['issues:read'])
        })
        .onConflictDoUpdate({
          target: integrations.service,
          set: {
            connectedAt: new Date(),
            status: 'connected',
            scopes: JSON.stringify(['issues:read'])
          }
        })
        .run()

      return { success: true, name }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Todoist personal API token (Phase 7 Track B). Paste-once, like the GitHub
  // PAT: validate the format, prove it works against the REST API, encrypt to
  // disk, flip the integrations row. Todoist personal tokens are Bearer tokens.
  ipcMain.handle('auth:connect-todoist', async (_event, token: string) => {
    if (typeof token !== 'string') {
      return { error: 'Token must be a string.' }
    }
    // Bound length BEFORE trim/regex. The renderer is an untrusted boundary;
    // without this a compromised renderer could send a huge string and force
    // allocations during trim()/regex. Real tokens are ~40 chars.
    if (token.length > 256) {
      return { error: 'Token is too long.' }
    }
    const trimmed = token.trim()
    // Todoist personal API tokens are 40-char hex; keep the check lenient
    // enough to tolerate format changes but reject obvious garbage.
    if (!/^[A-Za-z0-9]{20,64}$/.test(trimmed)) {
      return {
        error:
          "That doesn't look like a Todoist API token. Copy your token from Todoist → Settings → Integrations → Developer."
      }
    }
    try {
      const resp = await fetch('https://api.todoist.com/rest/v2/projects', {
        headers: { Authorization: `Bearer ${trimmed}` }
      })
      if (resp.status === 401 || resp.status === 403) {
        return { error: 'Todoist rejected the token (auth failed). It may be revoked or mistyped.' }
      }
      if (!resp.ok) {
        return { error: `Todoist responded with HTTP ${resp.status}.` }
      }

      saveToken('todoist', { access_token: trimmed, auth_method: 'personal-api-token' })

      const db = getDb()
      db.insert(integrations)
        .values({
          service: 'todoist',
          connectedAt: new Date(),
          status: 'connected',
          scopes: JSON.stringify(['tasks:read'])
        })
        .onConflictDoUpdate({
          target: integrations.service,
          set: {
            connectedAt: new Date(),
            status: 'connected',
            scopes: JSON.stringify(['tasks:read'])
          }
        })
        .run()

      return { success: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Validate + store Google OAuth client credentials. Replaces the `.env`
  // workflow with an in-app form: paste once, encrypted to disk, never
  // crosses the IPC boundary again. The OAuth dance (`auth:connect-google`)
  // then reads from the encrypted store transparently.
  ipcMain.handle(
    'auth:set-google-credentials',
    async (_event, clientId: string, clientSecret: string) => {
      if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
        return { error: 'Client ID and Client Secret must be strings.' }
      }
      // Cap input length before we trim. The renderer is an untrusted boundary
      // in Electron; without this, a compromised renderer could send 100MB
      // strings and OOM the main process during safeStorage encryption. Real
      // Google Client IDs are ~70-80 chars; real Secrets are ~24-40. Pick a
      // bound that's generous enough for future format changes but rejects
      // anything obviously pathological.
      const MAX_INPUT = 512
      if (clientId.length > MAX_INPUT || clientSecret.length > MAX_INPUT) {
        return { error: `Client ID and Client Secret must each be ≤ ${MAX_INPUT} characters.` }
      }
      const id = clientId.trim()
      const secret = clientSecret.trim()
      // Google web/desktop OAuth Client IDs look like
      // `<digits>-<random>.apps.googleusercontent.com`. We don't reject on
      // edge cases — anything else is left for the OAuth dance to reject
      // with a meaningful error from Google.
      if (!/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(id)) {
        return {
          error:
            'Client ID looks wrong — expected the form `<digits>-<random>.apps.googleusercontent.com`.'
        }
      }
      if (secret.length < 8) {
        return { error: 'Client Secret looks too short.' }
      }
      try {
        setOAuthCredentials('google', { clientId: id, clientSecret: secret })
        return { success: true }
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('auth:has-google-credentials', () => ({
    configured: hasOAuthCredentials('google')
  }))

  ipcMain.handle('auth:clear-google-credentials', () => {
    deleteOAuthCredentials('google')
    return { success: true }
  })

  ipcMain.handle('auth:disconnect', async (_event, service: string) => {
    deleteToken(service)
    const db = getDb()
    db.update(integrations)
      .set({ status: 'disconnected', lastSyncedAt: null })
      .where(eq(integrations.service, service))
      .run()
    // Note: imported items (Things/Todoist daily-checklist rows, etc.) are
    // intentionally left in place on disconnect — the disconnect dialog
    // promises "your synced data will remain", and syncThings self-gates on a
    // disconnected row so they won't be refreshed or re-imported until the
    // user reconnects.
    return { success: true }
  })

  ipcMain.handle('auth:get-status', () => {
    const db = getDb()
    const rows = db.select().from(integrations).all()
    return rows
  })

  ipcMain.handle('auth:get-redirect-uris', () => ({
    google: `http://localhost:${OAUTH_PORT}${GOOGLE_CALLBACK_PATH}`,
    github: `http://localhost:${OAUTH_PORT}${GITHUB_CALLBACK_PATH}`
  }))
}
