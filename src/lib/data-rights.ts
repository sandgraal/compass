/**
 * Data-Rights Concierge catalog (Phase 10 — "The Acquisition Engine", RIGHTS).
 *
 * The OTHER half of acquisition: knowing where + how to *request* the data you
 * have a right to, then bringing it home. Every entry maps to a Compass Drop Zone
 * recognizer, so the loop closes — request → download → drop on the Timeline.
 * LIVE entries skip the request/drop loop entirely — they point at the
 * Integrations connect flow instead.
 *
 * Pure data (no secrets, no network). URLs are stable entry points; the exact
 * in-portal path lives in `how` so a moved deep-link doesn't strand the user.
 */

export type DataRightsDomain =
  | 'Financial'
  | 'Government'
  | 'Health'
  | 'Travel'
  | 'Social & Communications'
  | 'Lifestyle & Shopping'

export const DATA_RIGHTS_DOMAINS: DataRightsDomain[] = [
  'Financial',
  'Government',
  'Health',
  'Travel',
  'Social & Communications',
  'Lifestyle & Shopping'
]

/** How this source's data reaches Compass. */
export type DataRightsMethod = 'live' | 'export' | 'rights'

export interface DataRightsSource {
  id: string
  name: string
  domain: DataRightsDomain
  /** How the data reaches Compass: an ongoing connection, a self-service
   *  export you download yourself, or a rights-mandated disclosure request. */
  method: DataRightsMethod
  /** What you get back. */
  what: string
  /** The steps to request it (kept path-light so it survives portal redesigns). */
  how: string
  /** Delivery format. */
  format: string
  /** How Compass ingests it once you have the file. Unused for `method: 'live'`. */
  intoCompass: string
  /** Stable entry-point URL, when there's a public one (omitted for on-device data). */
  url?: string
  /**
   * CRED adapter id, when Compass can fetch this source via the Portal
   * Automation Sandbox (assisted login). Surfaces an "Automate this pull" action.
   */
  adapterId?: string
  /** For `method: 'live'` — the INTEGRATION_REGISTRY key that drives the
   *  Connect button + connected-state badge. */
  integrationId?: string
  /** Informational cross-link to an overlapping INTEGRATION_REGISTRY entry —
   *  purely a "you could also get this live via…" pointer, never affects
   *  status derivation (unlike `integrationId`, which only applies to
   *  `method: 'live'` sources). */
  relatedIntegrationId?: string
  /** For `method: 'export' | 'rights'` — the `records.source` value(s) that
   *  count as "imported" once present. Most map 1:1 with the recognizer id;
   *  a few sources unwrap into more than one recognizer. */
  recordsSourceId?: string | string[]
  /** The "why get this" line — tied to a specific existing Compass feature,
   *  not generic data-ownership language. Shown on every card. */
  payoff: string
  /** Optional in-app route the payoff line deep-links to. */
  payoffLink?: string
}

export const DATA_RIGHTS_SOURCES: DataRightsSource[] = [
  // ── Financial ───────────────────────────────────────────────────────────────
  {
    id: 'credit-report',
    name: 'Credit reports',
    domain: 'Financial',
    method: 'rights',
    what: 'Your full credit file from Equifax, Experian & TransUnion',
    how: 'The official, FCRA-mandated free source — request each bureau (now free weekly)',
    format: 'PDF',
    intoCompass: 'Drop the PDF — indexed as a Credit report',
    url: 'https://www.annualcreditreport.com',
    recordsSourceId: 'credit-report',
    payoff: 'Tracks your credit score and bureau history over time.',
    payoffLink: '/finance'
  },
  {
    id: 'amazon',
    name: 'Amazon order history',
    domain: 'Financial',
    method: 'export',
    what: 'Everything you have ever ordered',
    how: 'Account → Data & Privacy → Request Your Data → "Your Orders"',
    format: 'CSV',
    intoCompass: 'Drop the Retail.OrderHistory CSV',
    url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html',
    recordsSourceId: 'amazon',
    relatedIntegrationId: 'knot',
    payoff:
      'Every order becomes searchable Timeline history — see spending patterns your bank statement can’t show.'
  },
  {
    id: 'paypal',
    name: 'PayPal',
    domain: 'Financial',
    method: 'export',
    what: 'Your payment & transfer history',
    how: 'Activity → Statements → Download → Transactions (CSV)',
    format: 'CSV',
    intoCompass: 'Drop the CSV',
    url: 'https://www.paypal.com/reports/statements',
    recordsSourceId: 'paypal',
    payoff: 'Feeds People — senders and recipients you’ve paid become part of your directory.',
    payoffLink: '/people'
  },
  {
    id: 'venmo',
    name: 'Venmo',
    domain: 'Financial',
    method: 'export',
    what: 'Your P2P payment history',
    how: 'Statement → download the CSV for a date range',
    format: 'CSV',
    intoCompass: 'Drop the statement CSV',
    url: 'https://account.venmo.com/statement',
    recordsSourceId: 'venmo',
    payoff: 'Same as PayPal — P2P contacts flow straight into your People directory.',
    payoffLink: '/people'
  },
  {
    id: 'coinbase',
    name: 'Coinbase',
    domain: 'Financial',
    method: 'export',
    what: 'Your full crypto transaction history',
    how: 'Coinbase → Profile → Statements → Generate report → Transaction history (CSV)',
    format: 'CSV',
    intoCompass: 'Drop the transaction-history CSV',
    url: 'https://accounts.coinbase.com/statements',
    recordsSourceId: 'coinbase',
    payoff:
      'Every buy, sell, and convert joins the searchable Timeline — your crypto activity, owned.',
    payoffLink: '/timeline'
  },
  {
    id: 'kraken',
    name: 'Kraken',
    domain: 'Financial',
    method: 'export',
    what: 'Your ledger of trades, deposits & withdrawals',
    how: 'Kraken → History → Export → Ledgers (CSV)',
    format: 'CSV',
    intoCompass: 'Drop the ledgers CSV',
    url: 'https://www.kraken.com/u/history/export',
    recordsSourceId: 'kraken',
    payoff: 'Your Kraken ledger joins the Timeline alongside every other account.',
    payoffLink: '/timeline'
  },
  {
    id: 'plaid-investments',
    name: 'Investment holdings (Plaid)',
    domain: 'Financial',
    method: 'live',
    integrationId: 'plaid',
    what: 'Live positions from your brokerage & retirement accounts',
    how: 'Connect Plaid on the Integrations page — holdings sync alongside transactions',
    format: 'Live sync',
    intoCompass: 'Auto-synced — no file to drop',
    payoff: 'Replaces manual CSV uploads with an auto-updating Net Worth holdings card.',
    payoffLink: '/finance'
  },
  {
    id: 'retirement-holdings',
    name: 'Retirement / 401(k) account statement',
    domain: 'Financial',
    method: 'export',
    what: 'Your 401(k), IRA, or 403(b) positions — funds, share counts, balances',
    how: "Your plan provider's participant portal (Fidelity NetBenefits, Vanguard, Empower…) → Statements or Download → positions/holdings CSV",
    format: 'CSV',
    intoCompass: 'Finance → Net Worth → Import positions CSV',
    recordsSourceId: 'brokerage-holdings',
    payoff:
      'Retirement balances join Net Worth as an auto-tracked holdings snapshot instead of being tracked by hand.',
    payoffLink: '/finance'
  },
  {
    id: 'utility-bills',
    name: 'Utility bill export',
    domain: 'Financial',
    method: 'export',
    what: 'Your electric/gas/water statements — provider, amount, service period',
    how: "Your utility's online account → Billing / Statements → download recent bills (PDF or CSV, varies by provider)",
    format: 'CSV',
    intoCompass:
      'Finance → Property → Import CSV (Utility bills section) — a manual stand-in while the Arcadia relay isn’t deployed',
    recordsSourceId: 'utility',
    relatedIntegrationId: 'arcadia',
    payoff:
      'Fills the utilities line in your Schedule E rental P&L without a live Arcadia connection.',
    payoffLink: '/finance'
  },

  // ── Government ───────────────────────────────────────────────────────────────
  {
    id: 'irs',
    name: 'IRS tax records',
    domain: 'Government',
    method: 'rights',
    what: 'Tax-return, wage & income, and account transcripts',
    how: 'Sign in → Get Transcript Online → choose the year & transcript type',
    format: 'PDF',
    intoCompass: 'Drop the PDF — indexed as a Tax document',
    url: 'https://www.irs.gov/individuals/get-transcript',
    recordsSourceId: 'tax-document',
    payoff: 'Backs up your Tax Summary with the government’s own record of what was filed.',
    payoffLink: '/finance'
  },
  {
    id: 'ssa',
    name: 'Social Security',
    domain: 'Government',
    method: 'rights',
    what: 'Your earnings record + future benefit estimate',
    how: 'Open a "my Social Security" account → download your Statement',
    format: 'PDF',
    intoCompass: 'Drop the PDF',
    url: 'https://www.ssa.gov/myaccount/',
    adapterId: 'ssa',
    recordsSourceId: 'social-security',
    payoff:
      'Grounds your Retirement projection’s Social Security claiming-age math in your real earnings record.',
    payoffLink: '/retirement'
  },
  {
    id: 'property-records',
    name: 'Property & assessor records',
    domain: 'Government',
    method: 'rights',
    what: 'Deed, parcel & assessed-value records for property you own',
    // County-specific — no single national portal, so the path is a search
    // rather than a stable URL (a few other entries do the same).
    how: "Search '<your county> assessor property search' → look up your parcel → download",
    format: 'PDF',
    intoCompass: 'Drop the PDF — indexed as a document',
    payoff: 'Keeps your property paperwork alongside the Property P&L.',
    payoffLink: '/finance'
  },

  // ── Health ──────────────────────────────────────────────────────────────────
  {
    id: 'apple-health',
    name: 'Apple Health',
    domain: 'Health',
    method: 'export',
    what: 'Steps, workouts, sleep, heart rate, weight…',
    how: 'iPhone Health app → profile photo → Export All Health Data',
    format: 'XML (in a .zip)',
    intoCompass: 'Unzip and drop export.xml',
    recordsSourceId: 'apple-health',
    relatedIntegrationId: 'terra',
    payoff: 'Auto-fills habit streaks — workout and sleep check-ins track themselves.',
    payoffLink: '/monthly'
  },
  {
    id: 'medical-records',
    name: 'Medical records',
    domain: 'Health',
    method: 'rights',
    what: 'Visits, labs, medications, immunizations',
    how: "Your provider's patient portal (MyChart, etc.) — or Medicare's Blue Button",
    format: 'PDF',
    intoCompass: 'Drop the PDF',
    url: 'https://www.medicare.gov/account/login',
    recordsSourceId: 'document',
    relatedIntegrationId: 'metriport',
    payoff: 'Keeps a searchable copy of your care history outside any one provider’s portal.',
    payoffLink: '/timeline'
  },
  {
    id: 'fitbit',
    name: 'Fitbit',
    domain: 'Health',
    method: 'export',
    what: 'Steps, calories, distance & sleep history',
    how: 'fitbit.com → Settings → Data Export (or via Google Takeout → Fitbit)',
    format: 'JSON (in a .zip)',
    intoCompass: 'Unzip and drop the steps / sleep JSON files',
    url: 'https://www.fitbit.com/settings/data/export',
    recordsSourceId: 'fitbit',
    relatedIntegrationId: 'terra',
    payoff: 'Your daily activity & sleep join the Timeline alongside Apple Health.',
    payoffLink: '/timeline'
  },
  {
    id: 'garmin',
    name: 'Garmin',
    domain: 'Health',
    method: 'export',
    what: 'Your workout & activity history',
    how: 'Garmin Connect → Account → Export Your Data',
    format: 'JSON (in a .zip)',
    intoCompass: 'Unzip and drop the activities JSON',
    url: 'https://www.garmin.com/account/datamanagement/exportdata/',
    recordsSourceId: 'garmin',
    relatedIntegrationId: 'terra',
    payoff: 'Every workout lands on the Timeline — your training history, owned.',
    payoffLink: '/timeline'
  },

  // ── Travel ──────────────────────────────────────────────────────────────────
  {
    id: 'cbp-i94',
    name: 'US travel history (CBP I-94)',
    domain: 'Travel',
    method: 'rights',
    what: 'Your record of US entries & exits (nonimmigrant admissions)',
    how: 'i94.cbp.dhs.gov → View Travel History → look up traveler → print or save',
    format: 'PDF / print',
    // No auto-importer yet — the export format isn't validated and it feeds a
    // tax-sensitive calc, so for now it's a reference + manual-entry prompt.
    // (A validated arrival/departure → travel-segment importer is planned.)
    intoCompass: 'Log the trips on Finance → Residency (auto-import planned)',
    url: 'https://i94.cbp.dhs.gov/',
    payoff: 'Your US days for the Substantial Presence Test — track them on the residency tab.',
    payoffLink: '/finance'
  },
  {
    id: 'ttp-record',
    name: 'TSA PreCheck / Global Entry (Trusted Traveler)',
    domain: 'Travel',
    method: 'rights',
    what: 'Your Trusted Traveler membership record — PASSID, expiration, enrolled programs',
    how: 'Log in to the Trusted Traveler Programs (TTP) site → Dashboard → view/print your membership card',
    format: 'PDF / print',
    intoCompass: 'Drop the PDF — indexed as a document',
    url: 'https://ttp.dhs.gov/',
    recordsSourceId: 'document',
    payoff:
      'Keeps your Trusted Traveler status and renewal date searchable alongside your other travel documents.',
    payoffLink: '/timeline'
  },
  {
    id: 'loyalty-programs',
    name: 'Airline & hotel loyalty program data',
    domain: 'Travel',
    method: 'export',
    what: 'Your mileage/points balance and flight or stay history',
    how: "Search '<airline/hotel> loyalty program request my data' — most programs have a privacy download or an activity-history export under Account settings",
    format: 'CSV or PDF (varies by program)',
    intoCompass:
      'Drop the export — PDFs are indexed as a document; CSVs fall to the generic dated-import if no dedicated parser matches',
    recordsSourceId: ['document', 'generic'],
    payoff:
      'Flight and stay history joins the Timeline, filling out your travel record beyond bank-charge line items.',
    payoffLink: '/timeline'
  },
  // (Airbnb booking history lands in a later wave, also feeding travel segments.)

  // ── Social & Communications ──────────────────────────────────────────────────
  {
    id: 'google',
    name: 'Google Takeout',
    domain: 'Social & Communications',
    method: 'export',
    what: 'Gmail, YouTube history, location, photos, Calendar…',
    how: 'Select the products you want → export → download the archive',
    format: '.zip',
    intoCompass: 'Drop the whole .zip — it unwraps Gmail .mbox, YouTube history & more',
    url: 'https://takeout.google.com',
    // 'browser' is Google Chrome history within a Takeout archive — the same
    // records.source the standalone Chrome-history recognizer uses, so it's
    // shared with the 'on-device' card below. Snapshot-only sources
    // (google-subscriptions, google-bookmarks) are excluded — they land in
    // snapshot_facts, not records, so records:facets never lists them.
    recordsSourceId: [
      'google',
      'browser',
      'google-play',
      'google-pay',
      'gcal',
      'google-fit',
      'google-voice',
      'youtube',
      'email'
    ],
    relatedIntegrationId: 'nylas',
    payoff:
      'The single biggest Timeline fill — years of Gmail, search, and watch history become searchable in one drop.',
    payoffLink: '/timeline'
  },
  {
    id: 'apple',
    name: 'Apple data & privacy',
    domain: 'Social & Communications',
    method: 'rights',
    what: 'Your Apple account data across services',
    how: 'Data and Privacy → Request a copy of your data',
    format: '.zip',
    intoCompass: 'Drop the relevant CSV/JSON exports',
    url: 'https://privacy.apple.com',
    // No dedicated recognizer exists yet — Apple's export CSVs/JSON fall
    // through to whichever generic recognizer matches their shape, so there's
    // no single `records.source` value to key "imported" off of honestly.
    payoff: 'Rounds out your digital footprint alongside Google and Meta.',
    payoffLink: '/timeline'
  },
  {
    id: 'meta',
    name: 'Facebook & Instagram',
    domain: 'Social & Communications',
    method: 'export',
    what: 'Posts, messages, your activity',
    how: 'Accounts Center → Your information and permissions → Download your information',
    format: '.zip / JSON',
    intoCompass: 'Drop the JSON exports',
    url: 'https://accountscenter.facebook.com/info_and_permissions',
    recordsSourceId: 'facebook',
    payoff:
      'Friends and message threads become people in your directory, with first/last-seen dates.',
    payoffLink: '/people'
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    domain: 'Social & Communications',
    method: 'export',
    what: 'Your connections & profile data',
    how: 'Settings → Data Privacy → Get a copy of your data',
    format: 'CSV',
    intoCompass: 'Drop Connections.csv',
    url: 'https://www.linkedin.com/mypreferences/d/download-my-data',
    recordsSourceId: 'linkedin',
    payoff: 'Your professional network becomes searchable People entries.',
    payoffLink: '/people'
  },
  {
    id: 'on-device',
    name: 'iMessage & browser history',
    domain: 'Social & Communications',
    method: 'export',
    what: 'Messaging activity + everywhere you have browsed',
    how: 'Already on your Mac — copy ~/Library/Messages/chat.db, or your browser History DB',
    format: 'SQLite',
    intoCompass: 'Drop the copy (the live DB is locked — copy it first)',
    recordsSourceId: ['imessage', 'browser'],
    payoff:
      'Message counts and browsing history join the same searchable Timeline as everything else.',
    payoffLink: '/timeline'
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    domain: 'Social & Communications',
    method: 'export',
    what: 'Your chat activity (counts + who, not message text)',
    how: 'Open a chat → ⋮ / contact name → Export Chat → Without Media',
    format: '.txt',
    intoCompass: 'Drop the exported .txt',
    recordsSourceId: 'whatsapp',
    payoff: 'Chat partners join your People directory; daily activity lands on the Timeline.',
    payoffLink: '/people'
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    domain: 'Social & Communications',
    method: 'export',
    what: 'Your full posting history',
    how: 'Settings → Your account → Download an archive of your data',
    format: '.js (in a .zip)',
    intoCompass: 'Unzip and drop tweets.js',
    url: 'https://x.com/settings/download_your_data',
    recordsSourceId: 'x',
    payoff: 'Every tweet becomes searchable Timeline history — your posts, owned.',
    payoffLink: '/timeline'
  },

  // ── Lifestyle & Shopping ──────────────────────────────────────────────────────
  {
    id: 'netflix',
    name: 'Netflix',
    domain: 'Lifestyle & Shopping',
    method: 'export',
    what: 'Your viewing history',
    how: 'Account → Get my info (or per-profile Viewing activity → download)',
    format: 'CSV',
    intoCompass: 'Drop the viewing-history CSV',
    url: 'https://www.netflix.com/account/getmyinfo',
    recordsSourceId: 'netflix',
    payoff: 'Adds to "On This Day" — see what you were watching this week in years past.',
    payoffLink: '/timeline'
  },
  {
    id: 'spotify',
    name: 'Spotify',
    domain: 'Lifestyle & Shopping',
    method: 'export',
    what: 'Your streaming history',
    how: 'Account → Privacy → request your data (ask for Extended history for the full record)',
    format: 'JSON',
    intoCompass: 'Drop the StreamingHistory JSON',
    url: 'https://www.spotify.com/account/privacy/',
    recordsSourceId: 'spotify',
    payoff: 'Same "On This Day" payoff — years of listening history, searchable.',
    payoffLink: '/timeline'
  },
  {
    id: 'goodreads',
    name: 'Goodreads',
    domain: 'Lifestyle & Shopping',
    method: 'export',
    what: 'Your full library + ratings & read dates',
    how: 'My Books → Import and export → Export Library',
    format: 'CSV',
    intoCompass: 'Drop the library-export CSV',
    url: 'https://www.goodreads.com/review/import',
    recordsSourceId: 'goodreads',
    payoff: 'Your reading history joins the Timeline, searchable by title or date read.',
    payoffLink: '/timeline'
  },
  {
    id: 'uber',
    name: 'Uber',
    domain: 'Lifestyle & Shopping',
    method: 'export',
    what: 'Your trip history',
    how: 'Account → Privacy → Download Your Data → request the archive',
    format: 'CSV',
    intoCompass: 'Drop the trips CSV',
    url: 'https://myprivacy.uber.com/privacy/exploreyourdata/download',
    recordsSourceId: 'uber',
    payoff: 'Every ride joins the Timeline; dropoff addresses become Places you’ve been.',
    payoffLink: '/places'
  },
  {
    id: 'lyft',
    name: 'Lyft',
    domain: 'Lifestyle & Shopping',
    method: 'export',
    what: 'Your ride history',
    how: 'Settings → Privacy → request your data (ride history CSV)',
    format: 'CSV',
    intoCompass: 'Drop the ride-history CSV',
    url: 'https://account.lyft.com/privacy',
    recordsSourceId: 'lyft',
    payoff: 'Same as Uber — rides on the Timeline, dropoffs in your Places directory.',
    payoffLink: '/places'
  },
  {
    id: 'doordash',
    name: 'DoorDash',
    domain: 'Lifestyle & Shopping',
    method: 'export',
    what: 'Your food-delivery order history',
    how: 'Profile → Order History → Export Order Data, or Account Settings → Manage Account → Request Archive for the full privacy export',
    format: 'CSV',
    intoCompass: 'Drop the orders CSV',
    url: 'https://help.doordash.com/en-us/consumers/article/i-want-to-delete-my-personal-information-data-from-doordash',
    recordsSourceId: 'doordash',
    relatedIntegrationId: 'knot',
    payoff: 'Every order joins the Timeline; restaurants roll into your Merchants directory.',
    payoffLink: '/timeline'
  },
  {
    id: 'instacart',
    name: 'Instacart',
    domain: 'Lifestyle & Shopping',
    method: 'export',
    what: 'Your grocery-delivery order history',
    how: 'Account settings → request a copy of your personal information (or email customerprivacy@instacart.com)',
    format: 'CSV',
    intoCompass: 'Drop the orders CSV',
    url: 'https://www.instacart.com/help/section/507104353/2101960736',
    recordsSourceId: 'instacart',
    relatedIntegrationId: 'knot',
    payoff: 'Same as DoorDash — grocery runs join the Timeline and Merchants.',
    payoffLink: '/timeline'
  }
]
