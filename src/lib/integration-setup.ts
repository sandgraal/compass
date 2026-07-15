// Declarative "how to connect" guidance for every connectable integration.
//
// This is the companion to `integration-registry.ts`: the registry says WHAT
// exists (name, category, logo — the sidebar/grid shape), this says HOW to
// connect it (auth mechanism, prerequisites, numbered steps, cost, BYO
// support). Keeping them split mirrors the data-rights.ts / data-rights-status.ts
// split and lets the Integrations page render a consistent setup panel for
// every card from data instead of hand-coded per-service JSX.
//
// Only `connected: true` registry entries get an entry here — roadmap stubs
// (Slack) render in the "Coming Soon" section with no connect flow. The parity
// test (integration-setup.test.ts) enforces registry <-> setup coverage.

/** The connect mechanism a card uses. Drives which form/affordance renders. */
export type AuthKind =
  | 'oauth-dev-keys' // Google — user registers their own OAuth app (GitHub uses paste-token/PAT)
  | 'paste-token' // GitHub PAT, Linear, Todoist, Notion, Oura — paste an API key
  | 'dev-creds-modal' // Plaid (client_id+secret+env → Link), SnapTrade (BYO → portal)
  | 'setup-token' // SimpleFIN — paste a one-time setup token
  | 'local-file' // Apple Calendar, Things 3 — no config, just OS permission
  | 'local-path' // Obsidian — a local vault folder
  | 'relay-widget' // Terra, Canopy, Argyle, Arcadia, Metriport, Nylas, Knot
  | 'google-linked' // Email Receipts — no auth of its own; reuses the Google connection

/** A single credential input rendered by the generic setup panel. */
export interface SetupField {
  key: string
  label: string
  placeholder?: string
  type: 'text' | 'password' | 'textarea'
  help?: string
}

/** One numbered setup step, optionally carrying an inline external link. */
export interface SetupStep {
  text: string
  href?: string
  hrefLabel?: string
}

export interface IntegrationSetup {
  id: string
  authKind: AuthKind
  /** True for the 7 relay-fronted aggregators — needs a reachable relay. */
  requiresRelay: boolean
  /** True where the user can supply their own upstream keys (bypass the relay). */
  byoSupported: boolean
  /** Short cost / commitment note, e.g. "$15/yr — you hold the keys". */
  cost?: string
  /** Hard requirements the user must already have satisfied. */
  prerequisites: string[]
  /** Bullets of what to gather before starting. */
  whatYoullNeed: string[]
  /** Ordered setup instructions. */
  steps: SetupStep[]
  docUrl?: string
  signupUrl?: string
  /** Credential inputs for the generic panel. Empty when a bespoke body slot
   * (Plaid/SimpleFIN/Google/SnapTrade/Obsidian) owns the form instead. */
  fields: SetupField[]
  /** Override the primary button label ("Connect" by default). */
  connectLabel?: string
  /**
   * For relay-fronted aggregators where a working non-relay path already
   * exists in Compass today — surfaced ahead of a relay connect attempt
   * since the managed relay isn't deployed. Omit when no real alternative
   * exists (Metriport, Canopy).
   */
  alternative?: {
    /** Set only when the alternative is itself a connectable
     * INTEGRATION_REGISTRY entry (Oura, Google, Email Receipts) — renders
     * as a link. Omit for passive/always-on fallbacks (income inference,
     * manual expense tagging). */
    integrationId?: string
    note: string
  }
}

/**
 * The 7 relay-fronted aggregator ids (mirrors `AggregatorId` in
 * electron/integrations/relay-client.ts). Exported so the parity test and the
 * relay-settings UI share one list instead of duplicating the literals.
 */
export const RELAY_AGGREGATOR_IDS = [
  'terra',
  'canopy',
  'argyle',
  'arcadia',
  'metriport',
  'nylas',
  'knot'
] as const

export const INTEGRATION_SETUP: Record<string, IntegrationSetup> = {
  google: {
    id: 'google',
    authKind: 'oauth-dev-keys',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free — your own Google Cloud project',
    prerequisites: ['A Google account', 'A Google Cloud project (free)'],
    whatYoullNeed: ['An OAuth Client ID', 'An OAuth Client Secret'],
    steps: [
      {
        text: 'Create (or reuse) a project at Google Cloud Console.',
        href: 'https://console.cloud.google.com',
        hrefLabel: 'console.cloud.google.com'
      },
      {
        text: 'Under APIs & Services → OAuth consent screen, choose External, add the app name ("Compass") and your email, and save.'
      },
      {
        text: 'Under APIs & Services → Credentials → Create Credentials → OAuth client ID, choose Web application (not Desktop — the HTTP redirect requires it).'
      },
      {
        text: 'Add the redirect URI shown on the card as an Authorized redirect URI.'
      },
      {
        text: 'Enable the Google Calendar API, Gmail API, and Google Drive API under APIs & Services → Library.'
      },
      {
        text: 'While in test mode, add your Google account under OAuth consent screen → Test users.'
      },
      {
        text: 'Click Connect and paste your Client ID + Client Secret — Compass encrypts them via the OS Keychain, no .env editing.'
      }
    ],
    docUrl: 'https://console.cloud.google.com/apis/credentials',
    fields: []
  },
  'email-receipts': {
    id: 'email-receipts',
    authKind: 'google-linked',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free — reuses your Google connection',
    prerequisites: ['Google connected (with Gmail read access)'],
    whatYoullNeed: ['Nothing — it reads receipt emails from the Gmail you already connected'],
    steps: [
      {
        text: 'Connect Google first — it needs Gmail read access. If you connected before Gmail was included, reconnect to grant it.'
      },
      {
        text: 'Click Connect here — Compass scans recent order/receipt emails and adds them to your Timeline + Merchants. They are never inserted as finance transactions, so they can’t double-count your bank/card spend.'
      }
    ],
    fields: []
  },
  github: {
    id: 'github',
    authKind: 'paste-token',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free',
    prerequisites: ['A GitHub account'],
    whatYoullNeed: ['A Personal Access Token with repo, read:project, read:user scopes'],
    steps: [
      {
        text: 'Open the GitHub token page — the scopes (repo, read:project, read:user) are pre-selected.',
        href: 'https://github.com/settings/tokens/new?scopes=repo,read:project,read:user&description=Compass',
        hrefLabel: 'github.com/settings/tokens/new'
      },
      { text: 'Click Generate token at the bottom — optionally tighten the expiration.' },
      {
        text: 'Copy the token (starts with ghp_ or github_pat_) and paste it below. It is encrypted with the OS Keychain and never leaves your machine.'
      }
    ],
    signupUrl:
      'https://github.com/settings/tokens/new?scopes=repo,read:project,read:user&description=Compass',
    fields: [
      {
        key: 'token',
        label: 'GitHub Personal Access Token',
        placeholder: 'ghp_… or github_pat_…',
        type: 'password'
      }
    ]
  },
  'apple-calendar': {
    id: 'apple-calendar',
    authKind: 'local-file',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free — local, no network',
    prerequisites: [
      'macOS with Calendar.app',
      'Calendar access granted in System Settings › Privacy & Security › Calendars'
    ],
    whatYoullNeed: [],
    steps: [
      {
        text: 'Grant Compass access to your calendars in System Settings › Privacy & Security › Calendars.'
      },
      {
        text: 'Click Connect & sync — Compass reads the next 14 days locally. No OAuth, no network.'
      }
    ],
    fields: [],
    connectLabel: 'Connect & sync'
  },
  obsidian: {
    id: 'obsidian',
    authKind: 'local-path',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free — local, no cloud',
    prerequisites: ['A local Obsidian vault (or any folder of markdown notes)'],
    whatYoullNeed: ['The absolute path to your vault folder'],
    steps: [
      { text: 'Click Connect and enter the absolute path to your vault folder (~ is allowed).' },
      {
        text: 'Vault notes are imported under obsidian/ in your knowledge base; Compass notes are exported to a Compass/ folder in the vault. Each side is one-way — no conflicts.'
      }
    ],
    fields: []
  },
  notion: {
    id: 'notion',
    authKind: 'paste-token',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free',
    prerequisites: ['A Notion account'],
    whatYoullNeed: ['An internal-integration token', 'Pages shared with that integration'],
    steps: [
      {
        text: 'Create an internal integration and copy its token.',
        href: 'https://www.notion.so/my-integrations',
        hrefLabel: 'notion.so/my-integrations'
      },
      {
        text: 'Share the pages you want imported with that integration (page menu ▸ Connections). Only shared pages are visible to the API.'
      },
      { text: 'Paste the token below — Compass stores it encrypted on disk and only ever reads.' }
    ],
    signupUrl: 'https://www.notion.so/my-integrations',
    fields: [
      {
        key: 'token',
        label: 'Notion integration token',
        placeholder: 'ntn_… or secret_…',
        type: 'password'
      }
    ]
  },
  linear: {
    id: 'linear',
    authKind: 'paste-token',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free',
    prerequisites: ['A Linear account'],
    whatYoullNeed: ['A personal API key'],
    steps: [
      {
        text: 'Create a Personal API key in Linear → Settings → API.',
        href: 'https://linear.app/settings/api',
        hrefLabel: 'linear.app/settings/api'
      },
      {
        text: 'Paste it below — Compass stores it encrypted on disk and only ever reads the issues assigned to you.'
      }
    ],
    signupUrl: 'https://linear.app/settings/api',
    fields: [
      {
        key: 'token',
        label: 'Linear API key',
        placeholder: 'lin_api_…',
        type: 'password'
      }
    ]
  },
  todoist: {
    id: 'todoist',
    authKind: 'paste-token',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free',
    prerequisites: ['A Todoist account'],
    whatYoullNeed: ['An API token'],
    steps: [
      {
        text: 'Copy your API token from Todoist → Settings → Integrations → Developer.',
        href: 'https://todoist.com/app/settings/integrations/developer',
        hrefLabel: 'Todoist → Settings → Integrations → Developer'
      },
      {
        text: 'Paste it below — Compass imports tasks due today or overdue into today’s checklist.'
      }
    ],
    signupUrl: 'https://todoist.com/app/settings/integrations/developer',
    fields: [
      {
        key: 'token',
        label: 'Todoist API token',
        placeholder: '0123456789abcdef…',
        type: 'password'
      }
    ]
  },
  things: {
    id: 'things',
    authKind: 'local-file',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free — local, no cloud',
    prerequisites: ['Things 3 installed on this Mac'],
    whatYoullNeed: [],
    steps: [
      {
        text: 'Make sure Things 3 is installed and has been opened at least once on this Mac.'
      },
      {
        text: 'Click Connect & sync — Compass reads today’s and overdue to-dos from the local database. No cloud.'
      }
    ],
    fields: [],
    connectLabel: 'Connect & sync'
  },
  simplefin: {
    id: 'simplefin',
    authKind: 'setup-token',
    requiresRelay: false,
    byoSupported: false,
    cost: '$15/yr — you hold the keys',
    prerequisites: ['A SimpleFIN Bridge account ($15/yr)'],
    whatYoullNeed: ['A one-time setup token from SimpleFIN Bridge'],
    steps: [
      {
        text: 'Create an account at bridge.simplefin.org ($15/yr) and link your banks & cards.',
        href: 'https://bridge.simplefin.org',
        hrefLabel: 'bridge.simplefin.org'
      },
      { text: 'Generate a one-time setup token.' },
      {
        text: 'Paste it below — Compass claims it for a read-only access key stored encrypted on this Mac.'
      }
    ],
    signupUrl: 'https://bridge.simplefin.org',
    fields: [],
    connectLabel: 'Claim & sync'
  },
  plaid: {
    id: 'plaid',
    authKind: 'dev-creds-modal',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free dev keys — most people should use SimpleFIN instead',
    prerequisites: ['A Plaid developer account'],
    whatYoullNeed: ['Your Plaid Client ID', 'Your Plaid secret (per environment)'],
    steps: [
      {
        text: 'Get a free Client ID + Secret from the Plaid dashboard (Sandbox is instant; Production needs Plaid approval).',
        href: 'https://dashboard.plaid.com/developers/keys',
        hrefLabel: 'the Plaid dashboard'
      },
      { text: 'Click Connect, paste your Client ID + secret and pick the environment.' },
      { text: 'Pick your bank in the Plaid Link window that opens.' }
    ],
    docUrl: 'https://dashboard.plaid.com/developers/keys',
    fields: []
  },
  oura: {
    id: 'oura',
    authKind: 'paste-token',
    requiresRelay: false,
    byoSupported: false,
    cost: 'Free',
    prerequisites: ['An Oura account + Ring'],
    whatYoullNeed: ['A Personal Access Token'],
    steps: [
      {
        text: 'Create a Personal Access Token from your Oura account → Personal Access Tokens.',
        href: 'https://cloud.ouraring.com/personal-access-tokens',
        hrefLabel: 'your Oura account → Personal Access Tokens'
      },
      {
        text: 'Paste it below — Compass pulls sleep, readiness, and activity scores for the last 30 days.'
      }
    ],
    signupUrl: 'https://cloud.ouraring.com/personal-access-tokens',
    fields: [
      {
        key: 'token',
        label: 'Oura Personal Access Token',
        placeholder: '0123456789abcdef…',
        type: 'password'
      }
    ]
  },
  terra: {
    id: 'terra',
    authKind: 'relay-widget',
    requiresRelay: true,
    byoSupported: true,
    cost: 'Managed via the Compass relay, or bring your own Terra keys',
    prerequisites: [
      'A reachable Compass relay (managed or self-hosted), or your own Terra dev keys'
    ],
    whatYoullNeed: ['Nothing to paste for managed mode — the relay holds the key'],
    steps: [
      {
        text: 'Managed: Compass opens the Terra Connect widget through the relay — pick your wearable and authorize.'
      },
      {
        text: 'Advanced (BYO): paste your own Terra dev-id + x-api-key to call Terra directly, bypassing the relay.'
      }
    ],
    docUrl: 'https://tryterra.co',
    fields: [],
    connectLabel: 'Connect wearable',
    alternative: {
      integrationId: 'oura',
      note: 'Oura already syncs live today with no relay. Fitbit, Garmin, and Apple Health also import as file exports via Get Your Data (Health).'
    }
  },
  metriport: {
    id: 'metriport',
    authKind: 'relay-widget',
    requiresRelay: true,
    byoSupported: false,
    cost: 'Managed via the Compass relay',
    prerequisites: ['A reachable Compass relay (managed or self-hosted)'],
    whatYoullNeed: ['Nothing to paste — the relay holds the key'],
    steps: [
      {
        text: 'Compass onboards you through the relay and pulls your consolidated clinical records (diagnoses, meds, labs, immunizations).'
      },
      {
        text: 'This aggregator is relay-only — its key lives server-side, so a reachable relay is required.'
      }
    ],
    docUrl: 'https://metriport.com',
    fields: [],
    connectLabel: 'Connect records'
  },
  canopy: {
    id: 'canopy',
    authKind: 'relay-widget',
    requiresRelay: true,
    byoSupported: false,
    cost: 'Managed via the Compass relay',
    prerequisites: ['A reachable Compass relay (managed or self-hosted)'],
    whatYoullNeed: ['Nothing to paste — the relay holds the key'],
    steps: [
      {
        text: 'Compass opens the Canopy Connect flow through the relay — authorize your carrier and Compass imports your P&C policies.'
      },
      {
        text: 'This aggregator is relay-only — its key lives server-side, so a reachable relay is required.'
      }
    ],
    docUrl: 'https://usecanopy.com',
    fields: [],
    connectLabel: 'Connect policies'
  },
  argyle: {
    id: 'argyle',
    authKind: 'relay-widget',
    requiresRelay: true,
    byoSupported: false,
    cost: 'Managed via the Compass relay',
    prerequisites: ['A reachable Compass relay (managed or self-hosted)'],
    whatYoullNeed: ['Nothing to paste — the relay holds the key'],
    steps: [
      {
        text: 'Compass opens the Argyle Link flow through the relay — connect your payroll provider.'
      },
      {
        text: 'Real paystubs then power the cash-flow forecast with true income instead of inference. Relay-only — a reachable relay is required.'
      }
    ],
    docUrl: 'https://argyle.com',
    fields: [],
    connectLabel: 'Connect payroll',
    alternative: {
      note: "The cash-flow forecast already infers income from recurring bank deposits — no connection needed, though it's an estimate, not real paystubs."
    }
  },
  snaptrade: {
    id: 'snaptrade',
    authKind: 'dev-creds-modal',
    requiresRelay: false,
    byoSupported: true,
    cost: 'Free dev tier — BYO, signed locally (no relay)',
    prerequisites: ['A SnapTrade partner account (free dev tier)'],
    whatYoullNeed: ['Your SnapTrade clientId', 'Your SnapTrade consumerKey'],
    steps: [
      {
        text: 'Register for free partner keys at snaptrade.com/register.',
        href: 'https://snaptrade.com/register',
        hrefLabel: 'snaptrade.com/register'
      },
      {
        text: 'Click Connect and paste your clientId + consumerKey — Compass stores them encrypted and signs each request locally.'
      },
      { text: 'Authorize your brokerage in the SnapTrade Connection Portal that opens.' }
    ],
    signupUrl: 'https://snaptrade.com/register',
    fields: []
  },
  arcadia: {
    id: 'arcadia',
    authKind: 'relay-widget',
    requiresRelay: true,
    byoSupported: false,
    cost: 'Managed via the Compass relay',
    prerequisites: ['A reachable Compass relay (managed or self-hosted)'],
    whatYoullNeed: ['Nothing to paste — the relay holds the key'],
    steps: [
      {
        text: 'Compass opens the Arcadia Connect widget through the relay — authorize your utility provider.'
      },
      {
        text: 'Utility bills then feed the utilities line in your property P&L. Relay-only — a reachable relay is required.'
      }
    ],
    docUrl: 'https://arcadia.com',
    fields: [],
    connectLabel: 'Connect utilities',
    alternative: {
      note: 'You can already tag transactions as Schedule E operating expenses on the Transactions tab — utilities included — no connection needed. Get Your Data also has a utility-bill export fallback.'
    }
  },
  nylas: {
    id: 'nylas',
    authKind: 'relay-widget',
    requiresRelay: true,
    byoSupported: false,
    cost: 'Managed via the Compass relay',
    prerequisites: ['A reachable Compass relay (managed or self-hosted)'],
    whatYoullNeed: ['Nothing to paste — the relay holds the key'],
    steps: [
      {
        text: 'Compass opens Nylas Hosted Auth through the relay — sign in to your contacts provider (Outlook, iCloud, Exchange…).'
      },
      {
        text: 'Your contacts are imported into the owned address book. Relay-only — a reachable relay is required.'
      }
    ],
    docUrl: 'https://nylas.com',
    fields: [],
    connectLabel: 'Connect contacts',
    alternative: {
      integrationId: 'google',
      note: 'Google Contacts already syncs live via the Google integration, no relay — Nylas only adds non-Google providers (Outlook, iCloud, Exchange).'
    }
  },
  knot: {
    id: 'knot',
    authKind: 'relay-widget',
    requiresRelay: true,
    byoSupported: false,
    cost: 'Managed via the Compass relay',
    prerequisites: ['A reachable Compass relay (managed or self-hosted)'],
    whatYoullNeed: ['Nothing to paste — the relay holds the key'],
    steps: [
      {
        text: 'Compass opens the Knot merchant connect flow through the relay — sign in to a merchant (Amazon, Walmart, DoorDash…).'
      },
      {
        text: 'SKU-level order history is imported into your purchase timeline. Relay-only — a reachable relay is required.'
      }
    ],
    docUrl: 'https://knotapi.com',
    fields: [],
    connectLabel: 'Connect merchant',
    alternative: {
      integrationId: 'email-receipts',
      note: "The Amazon order-email recognizer (Email Receipts) already gives Amazon purchase history live, no relay. Knot's value-add is other merchants (Walmart, DoorDash, Instacart…)."
    }
  }
}

export function getIntegrationSetup(id: string): IntegrationSetup | undefined {
  return INTEGRATION_SETUP[id]
}
