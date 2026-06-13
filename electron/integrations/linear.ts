/**
 * Linear integration — Phase 7 Track B ("issues alongside GitHub on the
 * dashboard"). Read-only: pulls the issues assigned to the user via Linear's
 * GraphQL API and mirrors the active ones into `linear_issues`.
 *
 * Auth is a paste-once personal API key (no OAuth app), encrypted via the
 * standard `saveToken` path — same trust posture as the GitHub PAT. Linear
 * personal API keys are sent in the `Authorization` header verbatim (NOT as a
 * `Bearer` token — that form is reserved for OAuth access tokens).
 *
 * The response → row transform (`normalizeLinearIssues`) is pure so it
 * unit-tests without any network; `syncLinear` owns the fetch + DB bookkeeping
 * (same insert-on-conflict integration-row + sync_events pattern as the other
 * integrations).
 */

import { eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { integrations, linearIssues, syncEvents } from '../db/schema'
import { loadToken } from '../ipc/auth'

export const LINEAR_API = 'https://api.linear.app/graphql'
/** Max issues pulled per sync — a generous ceiling for an assigned-issue list. */
const MAX_ISSUES = 100
/** Workflow state types we treat as "done" and therefore drop. */
const DONE_STATE_TYPES = new Set(['completed', 'canceled'])

// GraphQL query: the viewer's assigned issues + the fields we surface. We
// fetch without a server-side state filter and drop done issues in the pure
// transformer — simpler and resilient to IssueFilter syntax changes.
export const ASSIGNED_ISSUES_QUERY = `query CompassAssignedIssues($first: Int!) {
  viewer {
    assignedIssues(first: $first, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        url
        priority
        dueDate
        state { name type }
        team { key }
      }
    }
  }
}`

export interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  url: string
  priority?: number | null
  dueDate?: string | null
  state?: { name?: string | null; type?: string | null } | null
  team?: { key?: string | null } | null
}

export interface LinearGraphQLResponse {
  data?: { viewer?: { assignedIssues?: { nodes?: LinearIssueNode[] } } }
  errors?: Array<{ message: string }>
}

export interface LinearIssueRow {
  externalId: string
  identifier: string
  title: string
  url: string
  state: string
  stateType: string
  priority: number
  team: string | null
  dueDate: string | null
}

/**
 * Pure: GraphQL response → active issue rows. Drops completed/canceled issues
 * and anything missing the fields we key on (id/title/url). Tolerates a
 * partial/empty response shape.
 */
export function normalizeLinearIssues(resp: LinearGraphQLResponse): LinearIssueRow[] {
  const nodes = resp.data?.viewer?.assignedIssues?.nodes ?? []
  const rows: LinearIssueRow[] = []
  for (const n of nodes) {
    if (!n?.id || !n.title || !n.url) continue
    const stateType = n.state?.type ?? 'unstarted'
    if (DONE_STATE_TYPES.has(stateType)) continue
    rows.push({
      externalId: n.id,
      identifier: n.identifier || '—',
      title: n.title,
      url: n.url,
      state: n.state?.name ?? 'Unknown',
      stateType,
      priority: Number.isFinite(n.priority) ? Number(n.priority) : 0,
      team: n.team?.key ?? null,
      dueDate: n.dueDate ?? null
    })
  }
  return rows
}

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

/**
 * Fetch the viewer's assigned issues and upsert the active ones. Same
 * insert-on-conflict integration-row + sync_events bookkeeping as the other
 * integrations, so a first-ever failure still surfaces.
 */
export async function syncLinear(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const tokens = loadToken('linear') as { access_token?: string } | null
  if (!tokens?.access_token) {
    return { service: 'linear', success: false, error: 'Not connected' }
  }
  const db = getDb()

  try {
    const resp = await fetch(LINEAR_API, {
      method: 'POST',
      headers: {
        Authorization: tokens.access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: ASSIGNED_ISSUES_QUERY, variables: { first: MAX_ISSUES } })
    })
    if (resp.status === 401 || resp.status === 400) {
      throw new Error('Linear rejected the API key. Reconnect with a fresh key.')
    }
    if (!resp.ok) throw new Error(`Linear API responded with HTTP ${resp.status}.`)
    const json = (await resp.json()) as LinearGraphQLResponse
    if (json.errors?.length) {
      throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join('; ')}`)
    }

    const rows = normalizeLinearIssues(json)
    const seen = new Set<string>()
    for (const row of rows) {
      seen.add(row.externalId)
      db.insert(linearIssues)
        .values({ ...row, syncedAt: new Date() })
        .onConflictDoUpdate({
          target: linearIssues.externalId,
          set: {
            identifier: row.identifier,
            title: row.title,
            url: row.url,
            state: row.state,
            stateType: row.stateType,
            priority: row.priority,
            team: row.team,
            dueDate: row.dueDate,
            syncedAt: new Date()
          }
        })
        .run()
    }
    // Prune issues that are no longer assigned/active so the dashboard list
    // doesn't accumulate stale rows. (Reassigned or completed → gone.)
    let removed = 0
    for (const existing of db
      .select({ externalId: linearIssues.externalId })
      .from(linearIssues)
      .all()) {
      if (!seen.has(existing.externalId)) {
        db.delete(linearIssues).where(eq(linearIssues.externalId, existing.externalId)).run()
        removed++
      }
    }
    const recordsUpdated = rows.length + removed

    db.insert(integrations)
      .values({
        service: 'linear',
        status: 'connected',
        connectedAt: new Date(),
        lastSyncedAt: new Date(),
        errorMessage: null
      })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'connected', lastSyncedAt: new Date(), errorMessage: null }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'linear'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'linear',
      status: 'done',
      recordsUpdated
    })
    return { service: 'linear', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'linear', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'linear'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'linear',
      status: 'error',
      error: message
    })
    return { service: 'linear', success: false, error: message }
  }
}
