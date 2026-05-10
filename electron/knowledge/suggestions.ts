/**
 * Pattern-based knowledge suggestion extractors — Phase 2.7 regex baseline.
 *
 * All extractors are PURE: they take input data and return KnowledgeSuggestionCandidate[].
 * No DB access, no file I/O. The caller (runSuggestionExtractors) handles persistence.
 *
 * No AI, no Ollama — purely deterministic regex/string pattern matching.
 */

export interface KnowledgeSuggestionCandidate {
  source: 'gmail' | 'github' | 'calendar'
  sourceId?: string
  targetPath: string // e.g. 'profile/relationships.md'
  kind: 'contact' | 'employer' | 'date' | 'note'
  proposedContent: string // markdown snippet ready to append
  context: string // human-readable explanation
}

// ── Domain helpers ────────────────────────────────────────────────────────────

// Free email / personal domains to ignore when extracting org suggestions
const IGNORED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'aol.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'fastmail.com',
  'hey.com',
  'substack.com',
  'noreply',
  'no-reply',
  'notifications',
  'mailer-daemon',
  'bounce',
  'donotreply'
])

/**
 * Parse a "Display Name <email@domain>" or bare "email@domain" string.
 * Returns { displayName, email, domain } or null if unparseable.
 */
function parseFromHeader(
  from: string
): { displayName: string; email: string; domain: string } | null {
  const full = from.trim()
  if (!full) return null

  let displayName = ''
  let email = ''

  const angleMatch = full.match(/^(.+?)\s*<([^>]+)>$/)
  if (angleMatch) {
    displayName = angleMatch[1].trim().replace(/^"|"$/g, '') // strip surrounding quotes
    email = angleMatch[2].trim().toLowerCase()
  } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(full)) {
    email = full.toLowerCase()
    displayName = ''
  } else {
    return null
  }

  const atIdx = email.lastIndexOf('@')
  if (atIdx < 0) return null
  const domain = email.slice(atIdx + 1)
  return { displayName, email, domain }
}

/** Capitalize the first letter of each word. */
function titleCase(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** Derive a human-readable org name from a domain (best-effort). */
function orgNameFromDomain(domain: string): string {
  // Strip www., mail., etc.
  const cleaned = domain.replace(/^(www|mail|smtp|support|noreply|info|help)\./, '')
  // Take the registrable part (strip TLD)
  const parts = cleaned.split('.')
  const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
  return titleCase(base)
}

/** Check if a string is already present in existing file content (case-insensitive). */
function alreadyMentioned(content: string, needle: string): boolean {
  return content.toLowerCase().includes(needle.toLowerCase())
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface GmailInputMessage {
  id: string
  threadId: string
  subject: string
  from: string // raw From header
  snippet?: string
  date?: string
}

export interface GitHubInputItem {
  id: number
  html_url: string
  type: 'issue' | 'pr'
  repo: string
  assignee?: { login: string } | null
  user?: { login: string } | null
  labels?: Array<{ name: string }>
}

// ── Extractor 1: Contact names from Gmail senders ────────────────────────────

/**
 * Aggregate Gmail From headers. If a display name appears >= 2 times in the
 * last 30 days AND is not already in relationships.md, propose a table row.
 */
export function extractContactsFromGmail(
  messages: GmailInputMessage[],
  existingRelationships: string
): KnowledgeSuggestionCandidate[] {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000

  // Count how many threads each sender (name → email) appears in, within cutoff
  const nameCounts = new Map<string, { email: string; count: number; threadId: string }>()

  for (const msg of messages) {
    const parsed = parseFromHeader(msg.from)
    if (!parsed) continue

    const { displayName, email, domain } = parsed

    // Skip noisy / machine senders
    if (IGNORED_DOMAINS.has(domain)) continue
    if (/noreply|no-reply|donotreply|notification|automated|mailer/i.test(email)) continue

    // Only use entries with a proper display name
    const name = displayName || email.split('@')[0]
    if (name.length < 2) continue

    // Filter by date if we have it
    if (msg.date) {
      const msgMs = new Date(msg.date).getTime()
      if (!Number.isNaN(msgMs) && msgMs < cutoff) continue
    }

    const existing = nameCounts.get(name)
    if (existing) {
      existing.count++
    } else {
      nameCounts.set(name, { email, count: 1, threadId: msg.threadId })
    }
  }

  const candidates: KnowledgeSuggestionCandidate[] = []

  for (const [name, { email, count, threadId }] of nameCounts) {
    if (count < 2) continue
    if (alreadyMentioned(existingRelationships, name)) continue
    if (alreadyMentioned(existingRelationships, email)) continue

    const proposedContent = `| ${name} | (from email) | ${email} |`
    candidates.push({
      source: 'gmail',
      sourceId: threadId,
      targetPath: 'profile/relationships.md',
      kind: 'contact',
      proposedContent,
      context: `Appeared ${count}x in recent inbox (${email})`
    })
  }

  return candidates
}

// ── Extractor 2: Org names from Gmail domains ─────────────────────────────────

/**
 * If a non-personal domain appears in >= 3 emails AND no row in employers.md
 * mentions it, propose adding the org name.
 */
export function extractOrgsFromGmail(
  messages: GmailInputMessage[],
  existingEmployers: string
): KnowledgeSuggestionCandidate[] {
  const domainCounts = new Map<string, { orgName: string; count: number; threadId: string }>()

  for (const msg of messages) {
    const parsed = parseFromHeader(msg.from)
    if (!parsed) continue

    const { domain, email } = parsed

    // Skip noisy senders
    if (IGNORED_DOMAINS.has(domain)) continue
    if (/noreply|no-reply|notification|automated/i.test(email)) continue

    const orgName = orgNameFromDomain(domain)
    const existing = domainCounts.get(domain)
    if (existing) {
      existing.count++
    } else {
      domainCounts.set(domain, { orgName, count: 1, threadId: msg.threadId })
    }
  }

  const candidates: KnowledgeSuggestionCandidate[] = []

  for (const [domain, { orgName, count, threadId }] of domainCounts) {
    if (count < 3) continue
    if (alreadyMentioned(existingEmployers, domain)) continue
    if (alreadyMentioned(existingEmployers, orgName)) continue

    const proposedContent = `| ${orgName} | | | (seen ${count}x in email from ${domain}) |`
    candidates.push({
      source: 'gmail',
      sourceId: threadId,
      targetPath: 'work/employers.md',
      kind: 'employer',
      proposedContent,
      context: `Domain ${domain} appeared in ${count} emails`
    })
  }

  return candidates
}

// ── Extractor 3: Contacts from calendar events ───────────────────────────────

export interface CalendarInputEvent {
  externalId: string
  title: string
  description?: string | null
  startAt?: Date | null
}

/**
 * Simple email extractor — pull every RFC-5322-like address out of a string.
 * Returns an array of { name, email } objects (name may be empty).
 */
function extractEmailsFromText(text: string): Array<{ name: string; email: string }> {
  const results: Array<{ name: string; email: string }> = []

  // Match "Display Name <email>" patterns first
  const namedRe = /([A-Za-z][^<]*?)\s*<([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>/g
  let m: RegExpExecArray | null
  const namedEmails = new Set<string>()
  while ((m = namedRe.exec(text)) !== null) {
    const name = m[1].trim().replace(/^"|"$/g, '')
    const email = m[2].trim().toLowerCase()
    results.push({ name, email })
    namedEmails.add(email)
  }

  // Then bare email addresses that weren't captured above
  const bareRe = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g
  while ((m = bareRe.exec(text)) !== null) {
    const email = m[1].trim().toLowerCase()
    if (!namedEmails.has(email)) {
      results.push({ name: '', email })
      namedEmails.add(email)
    }
  }

  return results
}

/**
 * Aggregate calendar event attendees from the description field.
 * If a person (by email) appears in >= 2 events in the last 30 days AND
 * they are not already in relationships.md, propose a contact row.
 */
export function extractContactsFromCalendar(
  events: CalendarInputEvent[],
  existingRelationships: string
): KnowledgeSuggestionCandidate[] {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000

  // email → { name, distinctEventIds, firstEventId }
  const emailCounts = new Map<
    string,
    { name: string; eventIds: Set<string>; firstEventId: string }
  >()

  for (const ev of events) {
    // Filter to last 30 days when we have a date
    if (ev.startAt) {
      const ms = ev.startAt instanceof Date ? ev.startAt.getTime() : new Date(ev.startAt).getTime()
      if (!Number.isNaN(ms) && ms < cutoff) continue
    }

    if (!ev.description) continue

    const contacts = extractEmailsFromText(ev.description)
    const seenInEvent = new Set<string>()
    for (const { name, email } of contacts) {
      // Skip noisy / machine senders
      const atIdx = email.lastIndexOf('@')
      if (atIdx < 0) continue
      const domain = email.slice(atIdx + 1)
      if (IGNORED_DOMAINS.has(domain)) continue
      if (/noreply|no-reply|donotreply|notification|automated|mailer/i.test(email)) continue
      if (seenInEvent.has(email)) continue
      seenInEvent.add(email)

      const existing = emailCounts.get(email)
      if (existing) {
        existing.eventIds.add(ev.externalId)
        // Prefer the longer/better name
        if (name.length > existing.name.length) existing.name = name
      } else {
        emailCounts.set(email, {
          name,
          eventIds: new Set([ev.externalId]),
          firstEventId: ev.externalId
        })
      }
    }
  }

  const candidates: KnowledgeSuggestionCandidate[] = []

  for (const [email, { name, eventIds, firstEventId }] of emailCounts) {
    const count = eventIds.size
    if (count < 2) continue
    if (alreadyMentioned(existingRelationships, email)) continue

    const displayName = name || email.split('@')[0]
    if (name && alreadyMentioned(existingRelationships, name)) continue

    const proposedContent = `| ${displayName} | (from calendar) | ${email} |`
    candidates.push({
      source: 'calendar',
      sourceId: firstEventId,
      targetPath: 'profile/relationships.md',
      kind: 'contact',
      proposedContent,
      context: `Appeared in ${count} calendar event(s) (${email})`
    })
  }

  return candidates
}

// ── Extractor 4: Contacts from GitHub items ───────────────────────────────────

/**
 * Extract GitHub user logins (assignees, authors) from issues/PRs and propose
 * contact rows in relationships.md.
 */
export function extractContactsFromGithub(
  items: GitHubInputItem[],
  existingRelationships: string
): KnowledgeSuggestionCandidate[] {
  // Count unique logins
  const loginCounts = new Map<string, { url: string; count: number; itemId: number }>()

  for (const item of items) {
    const logins: string[] = []
    if (item.assignee?.login) logins.push(item.assignee.login)
    if (item.user?.login) logins.push(item.user.login)

    for (const login of logins) {
      // Skip bot accounts
      if (/\[bot\]$/.test(login) || /^dependabot/.test(login)) continue

      const existing = loginCounts.get(login)
      if (existing) {
        existing.count++
      } else {
        loginCounts.set(login, {
          url: `https://github.com/${login}`,
          count: 1,
          itemId: item.id
        })
      }
    }
  }

  const candidates: KnowledgeSuggestionCandidate[] = []

  for (const [login, { url, count, itemId }] of loginCounts) {
    if (alreadyMentioned(existingRelationships, login)) continue

    const proposedContent = `| ${login} | (GitHub collaborator) | ${url} |`
    candidates.push({
      source: 'github',
      sourceId: String(itemId),
      targetPath: 'profile/relationships.md',
      kind: 'contact',
      proposedContent,
      context: `GitHub collaborator — appeared in ${count} issue(s)/PR(s)`
    })
  }

  return candidates
}
