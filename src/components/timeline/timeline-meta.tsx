/**
 * Shared Timeline presentation vocabulary (Timeline 2.0, PR 4): source icons +
 * labels, kind labels, date/time formatters, the filter Chip, and the record
 * row card. Extracted from the old single-file Timeline page so the hero,
 * browse list, drawer, and (PR 5) heatmap all speak the same visual language.
 */

import {
  Activity,
  ArrowLeftRight,
  Banknote,
  Book,
  BookOpen,
  CalendarDays,
  CheckSquare,
  Clapperboard,
  CreditCard,
  Facebook,
  FileText,
  Film,
  Footprints,
  Github,
  Globe,
  Home,
  Landmark,
  Linkedin,
  ListTodo,
  Mail,
  MessageSquare,
  Mic,
  Music,
  Package,
  Phone,
  Plane,
  Receipt,
  Stethoscope,
  Target,
  Wallet,
  Youtube,
  Zap
} from 'lucide-react'
import { type MemoryTier, memoryTier, payloadFacts, sourceColor } from '../../lib/timeline-facts'
import { cn } from '../../lib/utils'

const SOURCE_META: Record<string, { label: string; icon: JSX.Element }> = {
  netflix: { label: 'Netflix', icon: <Film size={13} /> },
  spotify: { label: 'Spotify', icon: <Music size={13} /> },
  amazon: { label: 'Amazon', icon: <Package size={13} /> },
  paypal: { label: 'PayPal', icon: <Wallet size={13} /> },
  venmo: { label: 'Venmo', icon: <ArrowLeftRight size={13} /> },
  'credit-report': { label: 'Credit', icon: <CreditCard size={13} /> },
  'tax-document': { label: 'Tax', icon: <Receipt size={13} /> },
  'social-security': { label: 'Social Security', icon: <Landmark size={13} /> },
  document: { label: 'Document', icon: <FileText size={13} /> },
  linkedin: { label: 'LinkedIn', icon: <Linkedin size={13} /> },
  goodreads: { label: 'Goodreads', icon: <BookOpen size={13} /> },
  'apple-health': { label: 'Apple Health', icon: <Activity size={13} /> },
  email: { label: 'Email', icon: <Mail size={13} /> },
  youtube: { label: 'YouTube', icon: <Youtube size={13} /> },
  browser: { label: 'Browser', icon: <Globe size={13} /> },
  imessage: { label: 'Messages', icon: <MessageSquare size={13} /> },
  facebook: { label: 'Facebook', icon: <Facebook size={13} /> },
  google: { label: 'Google', icon: <Footprints size={13} /> },
  'google-play': { label: 'Play Store', icon: <Package size={13} /> },
  'google-pay': { label: 'Google Pay', icon: <Wallet size={13} /> },
  'google-fit': { label: 'Google Fit', icon: <Activity size={13} /> },
  'google-voice': { label: 'Google Voice', icon: <Phone size={13} /> },
  gcal: { label: 'Calendar', icon: <CalendarDays size={13} /> },
  'prime-video': { label: 'Prime Video', icon: <Clapperboard size={13} /> },
  kindle: { label: 'Kindle', icon: <Book size={13} /> },
  'amazon-music': { label: 'Amazon Music', icon: <Music size={13} /> },
  alexa: { label: 'Alexa', icon: <Mic size={13} /> },
  // Live-projected sources (storehouse projectors + the spine expansion)
  finance: { label: 'Finance', icon: <Wallet size={13} /> },
  gmail: { label: 'Gmail', icon: <Mail size={13} /> },
  github: { label: 'GitHub', icon: <Github size={13} /> },
  linear: { label: 'Linear', icon: <CheckSquare size={13} /> },
  oura: { label: 'Oura', icon: <Activity size={13} /> },
  habit: { label: 'Habit', icon: <CheckSquare size={13} /> },
  task: { label: 'Task', icon: <ListTodo size={13} /> },
  medical: { label: 'Medical', icon: <Stethoscope size={13} /> },
  travel: { label: 'Travel', icon: <Plane size={13} /> },
  paystub: { label: 'Paycheck', icon: <Banknote size={13} /> },
  utility: { label: 'Utilities', icon: <Zap size={13} /> },
  goal: { label: 'Goal', icon: <Target size={13} /> },
  'rental-comp': { label: 'Rental Comp', icon: <Home size={13} /> },
  generic: { label: 'Imported', icon: <FileText size={13} /> }
}

export function sourceMeta(s: string): { label: string; icon: JSX.Element } {
  return SOURCE_META[s] ?? { label: s, icon: <FileText size={13} /> }
}

// Pure helpers live in the plain-.ts lib (JSX-free so they unit-test in the
// node env); re-exported here so components import from one place.
export { type MemoryTier, memoryTier, payloadFacts, sourceColor }

// Friendly labels for record kinds (the `type` column); unknown kinds fall back
// to a title-cased version of the raw value ("credit-report" → "Credit Report").
const TYPE_LABEL: Record<string, string> = {
  watch: 'Watched',
  listen: 'Listened',
  order: 'Orders',
  payment: 'Payments',
  purchase: 'Purchases',
  post: 'Posts',
  comment: 'Comments',
  messages: 'Messages',
  reaction: 'Reactions',
  group: 'Groups',
  event: 'Events',
  marketplace: 'Marketplace',
  saved: 'Saved',
  search: 'Searches',
  page: 'Pages',
  'off-facebook': 'Off-Facebook',
  security: 'Security',
  location: 'Location',
  activity: 'Activity',
  maps: 'Maps',
  app: 'Apps',
  assistant: 'Assistant',
  visit: 'Visits',
  fitness: 'Fitness',
  text: 'Texts',
  call: 'Calls',
  voicemail: 'Voicemail',
  book: 'Books',
  connection: 'Connections',
  job: 'Jobs',
  certification: 'Certifications',
  endorsement: 'Endorsements',
  invitation: 'Invitations',
  follow: 'Follows',
  learning: 'Learning',
  'job-application': 'Job Applications',
  recommendation: 'Recommendations',
  email: 'Email',
  browse: 'Browsing',
  document: 'Documents',
  'credit-report': 'Credit Report',
  'credit-tradeline': 'Tradelines',
  'credit-inquiry': 'Inquiries',
  'credit-score': 'Credit Score',
  read: 'Read',
  like: 'Liked',
  save: 'Saved to Library',
  ask: 'Asked Alexa',
  // Spine-expansion kinds
  'habit-check': 'Habit Checks',
  task: 'Tasks',
  condition: 'Conditions',
  medication: 'Medications',
  lab: 'Labs',
  immunization: 'Immunizations',
  allergy: 'Allergies',
  encounter: 'Encounters',
  procedure: 'Procedures',
  trip: 'Trips',
  paycheck: 'Paychecks',
  bill: 'Bills',
  'financial-goal': 'Goals',
  comp: 'Rental Comps',
  fact: 'Facts',
  wellness: 'Wellness',
  hrv: 'HRV',
  'resting-hr': 'Resting HR',
  'respiratory-rate': 'Respiratory Rate',
  'blood-glucose': 'Blood Glucose',
  vo2max: 'VO₂max',
  'active-energy': 'Active Energy',
  txn: 'Transactions',
  issue: 'Issues',
  pr: 'Pull Requests'
}

export function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function fmtDay(ms: number | null): string {
  if (ms == null) return 'Undated'
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

export function fmtTime(ms: number | null): string {
  if (ms == null) return ''
  const d = new Date(ms)
  // Hide the time for date-only records (parsed as local midnight).
  if (d.getHours() === 0 && d.getMinutes() === 0) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** "2019–2026" (or a single year) for the dated-records span — UTC to match the overview. */
export function fmtSpan(earliest: number | null, latest: number | null): string {
  if (earliest == null || latest == null) return ''
  const a = new Date(earliest).getUTCFullYear()
  const b = new Date(latest).getUTCFullYear()
  return a === b ? `${a}` : `${a}–${b}`
}

export function Chip({
  active,
  onClick,
  children,
  title
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors capitalize',
        active
          ? 'border-primary/50 bg-primary/15 text-primary'
          : 'border-border text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

/**
 * One record card — clickable everywhere so the detail drawer is one tap away.
 * Carries a per-source color (icon + left accent rail) so the wall of gray
 * becomes scannable, and an optional `tier` so the hero can make big memories
 * literally bigger (browse/day lists pass nothing → uniform 'mid' weight).
 */
export function RecordRow({
  record,
  onOpen,
  trailing,
  tier = 'mid'
}: {
  record: TimelineRecord
  onOpen: (record: TimelineRecord) => void
  trailing?: React.ReactNode
  tier?: MemoryTier
}): JSX.Element {
  const meta = sourceMeta(record.source)
  const color = sourceColor(record.source)
  const high = tier === 'high'
  const low = tier === 'low'
  return (
    <button
      type="button"
      onClick={() => onOpen(record)}
      style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
      className={cn(
        'w-full text-left flex items-center gap-3 rounded-xl border bg-card transition-colors group',
        high ? 'px-4 py-3 border-primary/30' : low ? 'px-4 py-1.5' : 'px-4 py-2.5 border-border',
        !high && 'border-border',
        'hover:border-primary/40'
      )}
    >
      <span
        className={cn('shrink-0', color ? '' : 'text-muted-foreground', high && '[&_svg]:size-4')}
        style={color ? { color } : undefined}
        title={meta.label}
      >
        {meta.icon}
      </span>
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            'truncate transition-colors group-hover:text-primary',
            high ? 'text-base font-medium text-foreground' : 'text-sm text-foreground',
            low && 'text-muted-foreground'
          )}
        >
          {record.title}
        </p>
        {record.body && !low && (
          <p className="text-xs text-muted-foreground truncate">{record.body}</p>
        )}
      </div>
      {trailing ?? (
        <span className="text-xs text-muted-foreground/70 shrink-0 tabular-nums">
          {fmtTime(record.occurredAt)}
        </span>
      )}
    </button>
  )
}
