import { format } from 'date-fns'
import { KNOWLEDGE_DIR } from '../paths'
import { updateKnowledgeFile } from './writer'

interface CalendarEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  location?: string
  htmlLink?: string
}

interface GmailMessage {
  id: string
  threadId: string
  subject: string
  from: string
  snippet?: string
  date?: string
}

interface DriveFile {
  id: string
  name: string
  mimeType?: string
  webViewLink?: string
  modifiedTime?: string
}

interface GitHubIssue {
  id: number
  title: string
  html_url: string
  state: string
  repository?: { full_name: string }
  labels?: Array<{ name: string }>
  pull_request?: object
}

export async function updateCalendarKnowledge(events: CalendarEvent[]): Promise<void> {
  if (!events.length) return

  const lines = [
    '# Upcoming Calendar Events',
    '',
    `> Auto-updated by Compass — ${new Date().toLocaleString()}`,
    ''
  ]

  const sorted = [...events].sort((a, b) => {
    const aTime = a.start?.dateTime || a.start?.date || ''
    const bTime = b.start?.dateTime || b.start?.date || ''
    return aTime.localeCompare(bTime)
  })

  for (const ev of sorted) {
    const startRaw = ev.start?.dateTime || ev.start?.date
    const start = startRaw ? new Date(startRaw) : null
    const dateStr = start ? format(start, 'EEE, MMM d') : 'Date unknown'
    const timeStr = ev.start?.dateTime ? format(new Date(ev.start.dateTime), 'h:mm a') : 'All day'
    lines.push(`## ${dateStr} — ${ev.summary || '(No title)'}`)
    lines.push(`- **Time:** ${timeStr}`)
    if (ev.location) lines.push(`- **Location:** ${ev.location}`)
    if (ev.htmlLink) lines.push(`- **Link:** [View in Calendar](${ev.htmlLink})`)
    lines.push('')
  }

  updateKnowledgeFile(KNOWLEDGE_DIR, 'calendar/upcoming.md', lines.join('\n'))
}

export async function updateGmailKnowledge(messages: GmailMessage[]): Promise<void> {
  if (!messages.length) return

  const lines = [
    '# Email Action Items',
    '',
    `> Auto-updated by Compass — ${new Date().toLocaleString()}`,
    `> ${messages.length} unread messages needing attention.`,
    ''
  ]

  for (const msg of messages) {
    const subject = msg.subject.slice(0, 70)
    const from = msg.from
      .replace(/<[^>]+>/, '')
      .trim()
      .slice(0, 40)
    const snippet = (msg.snippet || '').slice(0, 100)
    lines.push(`## ${subject}`)
    lines.push(`- **From:** ${from}`)
    if (snippet) lines.push(`- **Preview:** ${snippet}`)
    lines.push('')
  }

  updateKnowledgeFile(KNOWLEDGE_DIR, 'inbox/action-items.md', lines.join('\n'))
}

export async function updateDriveKnowledge(files: DriveFile[]): Promise<void> {
  if (!files.length) return

  const lines = [
    '# Google Drive Index',
    '',
    `> Auto-updated by Compass — ${new Date().toLocaleString()}`,
    '',
    '## Recent Files',
    '',
    '| Name | Type | Last Modified |',
    '|---|---|---|'
  ]

  for (const f of files.slice(0, 30)) {
    const name = f.name.replace(/\|/g, '\\|')
    const type = (f.mimeType || '').split('.').pop() || 'file'
    const modified = f.modifiedTime ? format(new Date(f.modifiedTime), 'MMM d, yyyy') : '-'
    const link = f.webViewLink ? `[${name}](${f.webViewLink})` : name
    lines.push(`| ${link} | ${type} | ${modified} |`)
  }

  updateKnowledgeFile(KNOWLEDGE_DIR, 'drive/index.md', `${lines.join('\n')}\n`)
}

export async function updateGitHubKnowledge(issues: GitHubIssue[]): Promise<void> {
  const lines = [
    '# GitHub Summary',
    '',
    `> Auto-updated by Compass — ${new Date().toLocaleString()}`,
    ''
  ]

  const openIssues = issues.filter((i) => !i.pull_request && i.state === 'open')
  const openPRs = issues.filter((i) => !!i.pull_request && i.state === 'open')

  lines.push('## Open Issues Assigned to Me', '')
  if (openIssues.length) {
    for (const issue of openIssues) {
      const repo = issue.repository?.full_name || issue.html_url.split('/').slice(3, 5).join('/')
      const labels = issue.labels?.map((l) => `\`${l.name}\``).join(' ') || ''
      lines.push(`- [${issue.title}](${issue.html_url}) — \`${repo}\` ${labels}`)
    }
  } else {
    lines.push('_No open issues assigned._')
  }

  lines.push('', '## Open Pull Requests', '')
  if (openPRs.length) {
    for (const pr of openPRs) {
      const repo = pr.repository?.full_name || pr.html_url.split('/').slice(3, 5).join('/')
      lines.push(`- [${pr.title}](${pr.html_url}) — \`${repo}\``)
    }
  } else {
    lines.push('_No open pull requests._')
  }

  updateKnowledgeFile(KNOWLEDGE_DIR, 'work/github-summary.md', `${lines.join('\n')}\n`)
}
