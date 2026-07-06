// Single source of truth for every integration the Integrations page and
// Sidebar can display. Adding a new integration means adding one entry here —
// see docs/integrations.md step 7 and .claude/skills/add-integration/SKILL.md.

export type IntegrationCategory =
  | 'finance'
  | 'health-fitness'
  | 'communication-productivity'
  | 'media-entertainment'
  | 'knowledge-notes'
  | 'government-legal'
  | 'travel'

export type IntegrationMethod = 'live' | 'export' | 'cred'

export interface IntegrationMeta {
  id: string
  name: string
  category: IntegrationCategory
  method: IntegrationMethod
  description: string
  scopes: string[]
  logo: string
  color: string
  /** False for roadmap integrations with no connect flow yet (e.g. Slack). */
  connected: boolean
}

export const INTEGRATION_CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  finance: 'Finance',
  'health-fitness': 'Health & Fitness',
  'communication-productivity': 'Communication & Productivity',
  'media-entertainment': 'Media & Entertainment',
  'knowledge-notes': 'Knowledge & Notes',
  'government-legal': 'Government & Legal',
  travel: 'Travel'
}

// Category display order on the Integrations page.
export const INTEGRATION_CATEGORY_ORDER: IntegrationCategory[] = [
  'finance',
  'health-fitness',
  'communication-productivity',
  'knowledge-notes',
  'media-entertainment',
  'government-legal',
  'travel'
]

export const INTEGRATION_REGISTRY: Record<string, IntegrationMeta> = {
  google: {
    id: 'google',
    name: 'Google',
    category: 'communication-productivity',
    method: 'live',
    description: 'Calendar events, Gmail action items, and Google Drive file index.',
    scopes: ['calendar.readonly', 'gmail.readonly', 'drive.readonly'],
    color: 'from-red-500/20 to-yellow-500/20',
    logo: 'G',
    connected: true
  },
  github: {
    id: 'github',
    name: 'GitHub',
    category: 'communication-productivity',
    method: 'live',
    description: 'Issues assigned to you, open pull requests, and project board items.',
    scopes: ['repo', 'read:project', 'read:user'],
    color: 'from-gray-500/20 to-gray-700/20',
    logo: '⌥',
    connected: true
  },
  'apple-calendar': {
    id: 'apple-calendar',
    name: 'Apple Calendar',
    category: 'communication-productivity',
    method: 'live',
    description: 'Local-file read of macOS Calendar.app — next 14 days. No OAuth, no network.',
    scopes: ['local:ics'],
    color: 'from-zinc-400/20 to-zinc-600/20',
    logo: '',
    connected: true
  },
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian',
    category: 'knowledge-notes',
    method: 'live',
    description:
      'Two-way markdown bridge with a local vault — vault notes appear in your knowledge base, Compass notes appear in the vault. No cloud.',
    scopes: ['local:markdown'],
    color: 'from-purple-500/20 to-violet-600/20',
    logo: '◆',
    connected: true
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    category: 'knowledge-notes',
    method: 'live',
    description:
      'Imports pages you share with your Notion integration into the knowledge base as markdown.',
    scopes: ['pages:read'],
    color: 'from-slate-500/20 to-slate-700/20',
    logo: 'N',
    connected: true
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    category: 'communication-productivity',
    method: 'live',
    description: 'Shows the issues assigned to you alongside GitHub on the dashboard.',
    scopes: ['issues:read'],
    color: 'from-indigo-500/20 to-purple-500/20',
    logo: 'L',
    connected: true
  },
  todoist: {
    id: 'todoist',
    name: 'Todoist',
    category: 'communication-productivity',
    method: 'live',
    description: "Imports tasks due today or overdue into today's daily checklist.",
    scopes: ['tasks:read'],
    color: 'from-red-500/20 to-orange-500/20',
    logo: 'T',
    connected: true
  },
  things: {
    id: 'things',
    name: 'Things 3',
    category: 'communication-productivity',
    method: 'live',
    description:
      "Local read of your Things 3 to-dos — today's and overdue tasks into the daily checklist. No cloud.",
    scopes: ['local:sqlite'],
    color: 'from-sky-400/20 to-blue-500/20',
    logo: '✓',
    connected: true
  },
  simplefin: {
    id: 'simplefin',
    name: 'SimpleFIN',
    category: 'finance',
    method: 'live',
    description:
      'Recommended: bank + card sync (incl. Amex) via SimpleFIN Bridge. You sign up & hold the keys ($15/yr) — no business or developer keys needed.',
    scopes: ['accounts:read', 'transactions:read'],
    color: 'from-emerald-500/20 to-teal-500/20',
    logo: 'S',
    connected: true
  },
  plaid: {
    id: 'plaid',
    name: 'Plaid',
    category: 'finance',
    method: 'live',
    description:
      'Advanced: bank sync via your own Plaid developer keys. Most people should use SimpleFIN instead. Tokens encrypted on disk.',
    scopes: ['transactions:read', 'accounts:read'],
    color: 'from-blue-500/20 to-indigo-500/20',
    logo: '$',
    connected: true
  },
  oura: {
    id: 'oura',
    name: 'Oura',
    category: 'health-fitness',
    method: 'live',
    description: 'Sleep, readiness, and activity scores from your Oura Ring.',
    scopes: ['personal', 'daily'],
    color: 'from-slate-600/20 to-indigo-600/20',
    logo: 'O',
    connected: true
  },
  terra: {
    id: 'terra',
    name: 'Terra',
    category: 'health-fitness',
    method: 'live',
    description: '500+ wearables (Fitbit, Garmin, Whoop, Apple Health…) through one connection.',
    scopes: ['daily', 'sleep', 'activity'],
    color: 'from-emerald-600/20 to-teal-600/20',
    logo: 'T',
    connected: true
  },
  metriport: {
    id: 'metriport',
    name: 'Metriport (Medical)',
    category: 'health-fitness',
    method: 'live',
    description:
      'Your clinical records (diagnoses, meds, labs, immunizations) from health networks.',
    scopes: ['medical:read'],
    color: 'from-rose-500/20 to-red-600/20',
    logo: '✚',
    connected: true
  },
  canopy: {
    id: 'canopy',
    name: 'Canopy (Insurance)',
    category: 'finance',
    method: 'live',
    description: 'Your P&C insurance policies (auto, home, umbrella…) via Canopy Connect.',
    scopes: ['policies', 'coverages'],
    color: 'from-emerald-600/20 to-lime-600/20',
    logo: 'C',
    connected: true
  },
  argyle: {
    id: 'argyle',
    name: 'Argyle (Payroll)',
    category: 'finance',
    method: 'live',
    description: 'Real paystubs — powers the cash-flow forecast with true income, not guesses.',
    scopes: ['paystubs', 'employment'],
    color: 'from-amber-500/20 to-orange-600/20',
    logo: 'A',
    connected: true
  },
  snaptrade: {
    id: 'snaptrade',
    name: 'SnapTrade (Brokerage)',
    category: 'finance',
    method: 'live',
    description: 'Live brokerage holdings (Robinhood, Schwab, Fidelity…) feed your net worth.',
    scopes: ['accounts:read', 'positions:read'],
    color: 'from-blue-500/20 to-cyan-500/20',
    logo: '§',
    connected: true
  },
  arcadia: {
    id: 'arcadia',
    name: 'Arcadia (Utilities)',
    category: 'finance',
    method: 'live',
    description: 'Utility bills from 125+ providers — the utilities line in your rental P&L.',
    scopes: ['statements:read'],
    color: 'from-lime-500/20 to-green-600/20',
    logo: '⚡',
    connected: true
  },
  nylas: {
    id: 'nylas',
    name: 'Nylas (Contacts)',
    category: 'communication-productivity',
    method: 'live',
    description:
      'Contacts from 250+ providers (Outlook, iCloud, Exchange…) into your address book.',
    scopes: ['contacts.read'],
    color: 'from-sky-500/20 to-indigo-500/20',
    logo: 'ny',
    connected: true
  },
  knot: {
    id: 'knot',
    name: 'Knot (Purchases)',
    category: 'finance',
    method: 'live',
    description:
      'SKU-level order history from merchants (Amazon, Walmart, DoorDash…) into your timeline.',
    scopes: ['transactions.read'],
    color: 'from-amber-500/20 to-orange-600/20',
    logo: 'kn',
    connected: true
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    category: 'communication-productivity',
    method: 'live',
    description: 'Action items from DMs and channels.',
    scopes: ['messages:read'],
    color: 'from-green-500/20 to-teal-500/20',
    logo: '#',
    connected: false
  }
}

export function getIntegrationMeta(id: string): IntegrationMeta | undefined {
  return INTEGRATION_REGISTRY[id]
}

export function groupByCategory(
  items: IntegrationMeta[]
): { category: IntegrationCategory; items: IntegrationMeta[] }[] {
  return INTEGRATION_CATEGORY_ORDER.map((category) => ({
    category,
    items: items.filter((item) => item.category === category)
  })).filter((group) => group.items.length > 0)
}
