# Data Rights & Acquisition

**Route:** `/data-rights` · **Sidebar:** Data Rights

Most apps ingest only what happens to have a friendly API — a *recent window* of your data. The Acquisition
Engine (Phase 10) goes further: **go out and get everything you have a legal right to** — your *whole
history* — and fold it into one owned, queryable life [Timeline](Storehouse-and-Timeline). Strategy +
source catalog: [`docs/storehouse-roadmap.md`](https://github.com/sandgraal/compass/blob/main/docs/storehouse-roadmap.md).

## The four ingestion modes

| Mode | What it is | Best for | Status |
|---|---|---|---|
| **LIVE** | OAuth / API / bridge sync | ongoing streams | ✅ Google, GitHub, SimpleFIN, Plaid, Linear, Todoist |
| **EXPORT** | a bulk archive *you* download (GDPR/CCPA "download my data") | your *entire history* | ✅ via the Drop Zone (~44 recognizers) |
| **RIGHTS** | a disclosure you're legally owed → request → track → ingest | sources with no self-serve button | ✅ Data-Rights Concierge (16 sources) |
| **CRED** | Compass logs into a portal *as you* and pulls/scrapes | sources with none of the above | 🟡 sandbox + SSA (assisted-login, **gated off by default**) |

> **CRED is the SimpleFIN decision generalized** — where no export or standard exists, *you* run the
> aggregator, locally, with credentials that never leave your machine. Compass prefers EXPORT / RIGHTS /
> LIVE and treats CRED as the fallback of last resort.

## The Data-Rights Concierge (`/data-rights`)

A guided **request → track → ingest** workflow that knows each mechanism (AnnualCreditReport.com, IRS
Individual Online Account, SSA, Apple/Google/Meta takeouts, on-device iMessage/browser history, and more —
16 sources today, `src/lib/data-rights.ts`). It records "requested on D, expect ~N days," reminds you to
ingest the result (reusing the Morning Brief scheduler), and hands the downloaded archive to the Drop Zone.
This is the literal "go *out* and *get* your data" half of the vision.

## Assisted-login portal pull (CRED, *beta*)

For sources with no export at all, the **Portal Automation Sandbox** (`electron/integrations/cred/`) opens
an isolated window and — in **Mode A, assisted login with no stored credentials** — surfaces the real login
page so *you* complete MFA, then captures the export and routes it through the same validated ingest as a
manual file drop. Today it ships one adapter (**SSA**) and is **gated off by default** behind the
`COMPASS_ENABLE_CRED` flag. Full threat model + the assisted-vs-stored design:
[`docs/cred-engine-design.md`](https://github.com/sandgraal/compass/blob/main/docs/cred-engine-design.md).

## Guardrails (non-negotiable)

- **Local-first preserved** — every source lands on disk; CSP is extended **per source**, no wildcards;
  prefer main-process-only calls.
- **Credentials** — a `portal-credentials` vault category; credentials never cross IPC, never appear in
  logs (the SimpleFIN/Plaid rule).
- **Leverage vs. privacy** — the assistant/MCP see summaries; the Timeline is the one user-opted-in
  detail exception (vault + raw finance stay aggregates-only).
- **Export excludes the vault** — the [Universal Export Center](Backup-and-Restore) is plaintext-portable
  but deliberately vault-free; encrypted [backup](Backup-and-Restore) is the only path that includes secrets.

## Related

- [Storehouse & Timeline](Storehouse-and-Timeline) — where acquired data lands.
- [Security & Privacy](Security-and-Privacy) · [Integrations](Integrations) (the LIVE connectors).
