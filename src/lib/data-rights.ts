/**
 * Data-Rights Concierge catalog (Phase 10 — "The Acquisition Engine", RIGHTS).
 *
 * The OTHER half of acquisition: knowing where + how to *request* the data you
 * have a right to, then bringing it home. Every entry maps to a Compass Drop Zone
 * recognizer, so the loop closes — request → download → drop on the Timeline.
 *
 * Pure data (no secrets, no network). URLs are stable entry points; the exact
 * in-portal path lives in `how` so a moved deep-link doesn't strand the user.
 */

export type DataRightsDomain = 'Financial' | 'Government' | 'Health' | 'Digital'

export interface DataRightsSource {
  id: string
  name: string
  domain: DataRightsDomain
  /** What you get back. */
  what: string
  /** The steps to request it (kept path-light so it survives portal redesigns). */
  how: string
  /** Delivery format. */
  format: string
  /** How Compass ingests it once you have the file. */
  intoCompass: string
  /** Stable entry-point URL, when there's a public one (omitted for on-device data). */
  url?: string
}

export const DATA_RIGHTS_SOURCES: DataRightsSource[] = [
  // ── Financial ───────────────────────────────────────────────────────────────
  {
    id: 'credit-report',
    name: 'Credit reports',
    domain: 'Financial',
    what: 'Your full credit file from Equifax, Experian & TransUnion',
    how: 'The official, FCRA-mandated free source — request each bureau (now free weekly)',
    format: 'PDF',
    intoCompass: 'Drop the PDF — indexed as a Credit report',
    url: 'https://www.annualcreditreport.com'
  },
  {
    id: 'amazon',
    name: 'Amazon order history',
    domain: 'Financial',
    what: 'Everything you have ever ordered',
    how: 'Account → Data & Privacy → Request Your Data → "Your Orders"',
    format: 'CSV',
    intoCompass: 'Drop the Retail.OrderHistory CSV',
    url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html'
  },
  {
    id: 'paypal',
    name: 'PayPal',
    domain: 'Financial',
    what: 'Your payment & transfer history',
    how: 'Activity → Statements → Download → Transactions (CSV)',
    format: 'CSV',
    intoCompass: 'Drop the CSV',
    url: 'https://www.paypal.com/reports/statements'
  },
  {
    id: 'venmo',
    name: 'Venmo',
    domain: 'Financial',
    what: 'Your P2P payment history',
    how: 'Statement → download the CSV for a date range',
    format: 'CSV',
    intoCompass: 'Drop the statement CSV',
    url: 'https://account.venmo.com/statement'
  },

  // ── Government ───────────────────────────────────────────────────────────────
  {
    id: 'irs',
    name: 'IRS tax records',
    domain: 'Government',
    what: 'Tax-return, wage & income, and account transcripts',
    how: 'Sign in → Get Transcript Online → choose the year & transcript type',
    format: 'PDF',
    intoCompass: 'Drop the PDF — indexed as a Tax document',
    url: 'https://www.irs.gov/individuals/get-transcript'
  },
  {
    id: 'ssa',
    name: 'Social Security',
    domain: 'Government',
    what: 'Your earnings record + future benefit estimate',
    how: 'Open a "my Social Security" account → download your Statement',
    format: 'PDF',
    intoCompass: 'Drop the PDF',
    url: 'https://www.ssa.gov/myaccount/'
  },

  // ── Health ──────────────────────────────────────────────────────────────────
  {
    id: 'apple-health',
    name: 'Apple Health',
    domain: 'Health',
    what: 'Steps, workouts, sleep, heart rate, weight…',
    how: 'iPhone Health app → profile photo → Export All Health Data',
    format: 'XML (in a .zip)',
    intoCompass: 'Unzip and drop export.xml'
  },
  {
    id: 'medical-records',
    name: 'Medical records',
    domain: 'Health',
    what: 'Visits, labs, medications, immunizations',
    how: "Your provider's patient portal (MyChart, etc.) — or Medicare's Blue Button",
    format: 'PDF',
    intoCompass: 'Drop the PDF',
    url: 'https://www.medicare.gov/account/login'
  },

  // ── Digital footprint ────────────────────────────────────────────────────────
  {
    id: 'google',
    name: 'Google Takeout',
    domain: 'Digital',
    what: 'Gmail, YouTube history, location, photos, Calendar…',
    how: 'Select the products you want → export → download the archive',
    format: '.zip',
    intoCompass: 'Drop the whole .zip — it unwraps Gmail .mbox, YouTube history & more',
    url: 'https://takeout.google.com'
  },
  {
    id: 'apple',
    name: 'Apple data & privacy',
    domain: 'Digital',
    what: 'Your Apple account data across services',
    how: 'Data and Privacy → Request a copy of your data',
    format: '.zip',
    intoCompass: 'Drop the relevant CSV/JSON exports',
    url: 'https://privacy.apple.com'
  },
  {
    id: 'meta',
    name: 'Facebook & Instagram',
    domain: 'Digital',
    what: 'Posts, messages, your activity',
    how: 'Accounts Center → Your information and permissions → Download your information',
    format: '.zip / JSON',
    intoCompass: 'Drop the JSON exports',
    url: 'https://accountscenter.facebook.com/info_and_permissions'
  },
  {
    id: 'netflix',
    name: 'Netflix',
    domain: 'Digital',
    what: 'Your viewing history',
    how: 'Account → Get my info (or per-profile Viewing activity → download)',
    format: 'CSV',
    intoCompass: 'Drop the viewing-history CSV',
    url: 'https://www.netflix.com/account/getmyinfo'
  },
  {
    id: 'spotify',
    name: 'Spotify',
    domain: 'Digital',
    what: 'Your streaming history',
    how: 'Account → Privacy → request your data (ask for Extended history for the full record)',
    format: 'JSON',
    intoCompass: 'Drop the StreamingHistory JSON',
    url: 'https://www.spotify.com/account/privacy/'
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    domain: 'Digital',
    what: 'Your connections & profile data',
    how: 'Settings → Data Privacy → Get a copy of your data',
    format: 'CSV',
    intoCompass: 'Drop Connections.csv',
    url: 'https://www.linkedin.com/mypreferences/d/download-my-data'
  },
  {
    id: 'goodreads',
    name: 'Goodreads',
    domain: 'Digital',
    what: 'Your full library + ratings & read dates',
    how: 'My Books → Import and export → Export Library',
    format: 'CSV',
    intoCompass: 'Drop the library-export CSV',
    url: 'https://www.goodreads.com/review/import'
  },
  {
    id: 'on-device',
    name: 'iMessage & browser history',
    domain: 'Digital',
    what: 'Messaging activity + everywhere you have browsed',
    how: 'Already on your Mac — copy ~/Library/Messages/chat.db, or your browser History DB',
    format: 'SQLite',
    intoCompass: 'Drop the copy (the live DB is locked — copy it first)'
  }
]
