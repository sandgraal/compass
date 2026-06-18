# Compass — CRED Engine Design (the Portal Automation Sandbox)

> **Status: DESIGN — no code yet.** This is the design gate for **Phase 10.6**, primitive **D** of the
> Acquisition Engine. Nothing here ships until the open questions in §12 are answered and a
> `security-auditor` pass signs off on the first slice.
>
> **Prereq reading:** [`storehouse-roadmap.md`](storehouse-roadmap.md) §3.D + §5 · [`architecture.md`](architecture.md)
> (process boundary, vault) · [`integrations/plaid/link.ts`](../electron/integrations/plaid/link.ts) (the child-window precedent this extends).

---

## 1. Problem & scope

Most of "all your data" arrives through clean paths: **EXPORT** (Takeout, Amazon, Spotify…), **RIGHTS**
(credit reports, SSA, tax — request → download → ingest), and **LIVE** (SimpleFIN, Linear…). Those are
built. What remains is the long tail of sources that have **no export, no API, and no mail-it-to-me
right** — only a website you log into: brokerage and loan servicers, payroll portals, county
assessor/recorder records, USPS Informed Delivery, utility and insurance portals.

The **CRED engine** is the primitive for those: an isolated, opt-in automation surface that opens a portal,
lets data come out (download an export, or read a rendered page), and hands the artifact to the existing
**Drop Zone** ingest pipeline. It is the SimpleFIN decision generalized — *where no standard exists, you run
the aggregator, locally, for yourself.*

It is also **the riskiest primitive in the entire product.** It is built last, gated, and deliberately
under-powered relative to what "automate a login" could mean. This document exists so the security model is
settled *before* a line of automation code is written.

**In scope:** the sandbox runtime, the credential-handling model, the portal-adapter abstraction, the
artifact handoff, the IPC/renderer surface, the first-portal choice, and the phased build.

**Out of scope (this doc):** specific adapters for specific portals beyond the first proof-of-concept; the
10.7 leverage layer; anything that defeats a site's security controls (see §10).

---

## 2. Design principles (non-negotiable)

These restate [`storehouse-roadmap.md`](storehouse-roadmap.md) §5 and bind every slice:

1. **The renderer never touches credentials.** Same rule as Plaid/SimpleFIN: a secret lives only in
   `.vault/*.enc` and is used only in the main process. In CRED's **default mode it is stronger** — the
   credential is typed by the user into the real portal page inside the sandbox and is *never seen by
   Compass at all* (§5).
2. **Credentials never appear in logs, errors, IPC payloads, or the records store.** Records remain a
   content-light index; a fetched artifact is summarized exactly like a manual file drop.
3. **Per-source, explicit opt-in.** Nothing runs by default. No portal is automated until the user adds it.
   Runs happen only on an explicit user trigger (v1) or a schedule the user turned on (v2).
4. **Isolation.** Automation runs in a sandboxed `BrowserWindow` with `nodeIntegration: false`, no Compass
   preload, its own `session` partition, and a per-portal CSP — never in the app's renderer or main window.
5. **The artifact re-enters through the same validated ingest as a manual drop.** No bespoke trust path: a
   downloaded PDF/CSV/ZIP goes through `records:import-paths` → `ingestPath` → the recognizer registry, with
   the same size guard and content-light summarization.
6. **Honest posture.** Scraping is brittle and ToS-gray. The UI says so plainly, always prefers
   EXPORT/RIGHTS/LIVE when a source offers them, and treats CRED as the fallback of last resort. A short
   legal/ToS note ships with the wave.
7. **Leverage-vs-privacy invariant preserved.** The assistant/MCP see derived summaries only — never raw
   records, never the vault, never anything a portal returned.

---

## 3. Threat model

What the engine defends, and what it does **not**.

| Asset | Threat | Mitigation |
|---|---|---|
| Portal credentials | Exfiltration via renderer, logs, crash dumps, IPC | v1: never stored, never handled (user types into portal). v2 (opt-in): AES-256-GCM in `.vault/portal-credentials.enc`, main-process only, never returned across IPC (masked tail only). |
| The session (cookies) inside the sandbox | A malicious or compromised portal page reaching Compass internals | No Compass preload, `contextIsolation: true`, `nodeIntegration: false`, dedicated `session` partition, restrictive CSP, `setWindowOpenHandler('deny')`, `will-navigate` allow-list pinned to the portal origin. |
| The downloaded artifact | Path traversal / oversized / malicious file | `will-download` forces the save into a controlled temp dir with a sanitized name; `MAX_IMPORT_BYTES` guard; then the normal recognizer pipeline (which already treats input as untrusted). |
| The user | Being tricked into automating a phishing look-alike domain | Portal origin is pinned in the adapter (not user-typed); the window shows the real URL bar/origin; we never follow links out of the pinned origin. |
| Compass itself | Becoming a credential-stuffing / scraping tool aimed at third parties | Per-source opt-in, runs only against the logged-in user's *own* account, no bulk/headless credential testing, see §10. |

**Explicitly accepted / out of scope:** a fully compromised host OS (if malware has the user's machine, the
OS Keychain and everything else is already lost — same assumption as the rest of the vault); a portal that
changes its DOM and breaks an adapter (handled as a clean, surfaced failure, not a security event).

---

## 4. Architecture overview

```
 ┌─────────────────────────── Main process (Node) ───────────────────────────┐
 │                                                                            │
 │  electron/ipc/cred.ts            electron/integrations/cred/               │
 │  ┌──────────────────┐            ┌─────────────────────────────────────┐  │
 │  │ cred:list        │            │ runtime.ts   — opens + drives the    │  │
 │  │ cred:run(portal) │──drives──▶ │   sandboxed BrowserWindow            │  │
 │  │ cred:cancel      │            │ adapters/<portal>.ts — per-portal    │  │
 │  │ cred:save-cred   │ (v2 only)  │   steps: navigate → locate → export  │  │
 │  │ cred:status      │            │ vault.ts     — portal-credentials    │  │
 │  └──────────────────┘            │   (v2, reuses crypto-vault)          │  │
 │         ▲                        └──────────────┬──────────────────────┘  │
 │         │ IPC (no secrets)                      │ will-download           │
 └─────────┼───────────────────────────────────────┼─────────────────────────┘
           │                                        ▼
 ┌─────────┴──────────┐                  ┌────────────────────────┐
 │ Renderer (React)   │                  │ temp/ controlled dir   │
 │ "Get Your Data"    │                  │  the downloaded file   │
 │  → Automate this    │                 └───────────┬────────────┘
 │  source (opt-in)   │                              │ records:import-paths
 └────────────────────┘                              ▼
                                          ┌────────────────────────┐
   ┌──────────────────────────────┐       │ ingestPath → recognizer│
   │ Sandboxed BrowserWindow      │       │ registry → records     │
   │  (visible in assisted mode)  │       │ (same path as a drop)  │
   │  • portal's real login page  │       └────────────────────────┘
   │  • user does password + MFA  │
   │  • engine navigates + downloads
   └──────────────────────────────┘
```

**Data flow (assisted mode, v1):**
1. User opens **Get Your Data**, picks a source that supports automation, clicks **Automate this pull**.
2. `cred:run(portalId)` opens a **visible** sandboxed `BrowserWindow` at the portal's pinned login URL.
3. **The user logs in** — password, MFA, captcha, all of it — directly on the real page. Compass watches
   only for "we've reached the logged-in state" (an adapter-defined URL/selector signal).
4. The adapter navigates the post-login pages to the export/download control and triggers it.
5. `session.on('will-download')` captures the file into a controlled temp dir.
6. The file is handed to the existing ingest (`records:import-paths`) — identical to a manual drop.
7. The window closes; the ephemeral session is cleared. A toast/Morning-Brief line reports what landed.

No credential ever crossed IPC or touched disk.

---

## 5. The two modes

The single most important design decision: **assisted-login is the default, and v1 stores nothing.**

### Mode A — Assisted (v1, the default, ships first)
The window is **visible**; the user authenticates themselves. Compass never sees or stores the password —
it only drives *post-authentication* navigation and the download. This delivers the core "go out and get
your data" value while reducing the credential-storage attack surface **to zero**. MFA/ID.me/captcha "just
work" because a human is at the keyboard. This is also the only mode that can handle the high-value
government portals (IRS, SSA) at all, since they mandate ID.me/Login.gov interactive MFA.

### Mode B — Stored-credential / unattended (v2, opt-in, gated, later)
For portals the user wants pulled **on a schedule without being present**, Compass can store the
credential in `.vault/portal-credentials.enc` and replay it. This is where the real risk lives, so it is a
*separate, later, explicitly-gated* slice — it does not ship with v1, and it carries its own
`security-auditor` pass. Session-cookie persistence (staying logged in between runs) is a credential
equivalent and is treated with the same care as a stored password.

> **Recommendation:** build and ship **Mode A only** for 10.6a. Decide on Mode B (§12 Q2) after the harness
> is proven and we have felt how brittle real portals are.

---

## 6. Components

### 6.1 The credential vault — `electron/integrations/cred/vault.ts` *(v2 only)*
Reuses the existing primitives verbatim — no new crypto:
```ts
// .vault/portal-credentials.enc  →  AES-256-GCM, master key in OS Keychain (safeStorage)
type PortalCreds = Record<string /*portalId*/, { username: string; password: string; savedAt: number }>
readEncryptedJson<PortalCreds>('portal-credentials', getOrCreateKey())
writeEncryptedJson('portal-credentials', creds, getOrCreateKey())
```
The renderer can **set** a credential (one-way, like `assistant:set-key`) and read back only a masked tail
via `cred:status`. It can never read a stored password back. `portal-credentials` is a reserved name that
passes `SAFE_VAULT_NAME` and is excluded from any export/backup that isn't itself encrypted. **Not built in
v1.**

### 6.2 The sandboxed automation window — `electron/integrations/cred/runtime.ts`
Extends the Plaid child-window pattern, hardened:
- `new BrowserWindow({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
  preload: undefined, partition: 'cred:<portalId>' } })` — a **dedicated, non-persistent session partition**
  by default (cookies die with the window unless v2 opts into persistence).
- `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` — no popups/new windows.
- `will-navigate` / `will-redirect` allow-list pinned to the portal's origin(s); anything else is blocked
  and surfaced as an error (defends against an open-redirect walking the session off-origin).
- Per-portal CSP applied via `session.webRequest.onHeadersReceived` (header-based, since these are real
  HTTP responses — unlike Plaid's `data:` URL meta-tag case).
- `session.on('will-download')` → forces `item.setSavePath(<temp>/<sanitized>)`, enforces `MAX_IMPORT_BYTES`,
  resolves a promise with the final path.
- A hard **timeout** and a user-visible **Cancel** that destroys the window and clears the session.

### 6.3 The portal adapter — `electron/integrations/cred/adapters/<portalId>.ts`
A small, declarative description of one portal. The adapter never reads credential fields and never types a
password (the user does, in Mode A). It declares:
```ts
interface PortalAdapter {
  id: string                       // 'ssa' | 'usps' | …
  name: string
  loginUrl: string                 // pinned origin — the only place we navigate to
  origins: string[]               // allow-list for will-navigate
  /** Signal that the user has reached the authenticated area (URL test or selector). */
  isLoggedIn(webContents): Promise<boolean>
  /** From logged-in state, drive to the export and trigger it. Returns when a download starts
   *  (download mode) or returns extracted text (scrape mode — flagged brittle/ToS-gray). */
  fetch(webContents): Promise<{ kind: 'download' } | { kind: 'scrape'; text: string }>
}
```
Adapters are pure navigation logic (`executeJavaScript` to click an "Export" button, wait for a selector).
**Scrape mode** (reading the rendered DOM when no download exists) is supported but explicitly marked the
brittle, ToS-grayest path and is preferred only when no file download is available.

### 6.4 The artifact handoff
A `download`-mode result is a file path → passed straight into the **existing** `ingestPath` used by
`records:import-paths`. A `scrape`-mode result is written to a temp file with the right extension, then the
same path. **Zero new ingest logic** — the recognizer registry already handles untrusted CSV/PDF/JSON/ZIP
and already stores content-light summaries. (If a portal yields a PDF type we don't yet recognize, the
generic-document recognizer indexes it; a dedicated recognizer is a normal follow-up slice.)

### 6.5 IPC surface — `electron/ipc/cred.ts` (the standard 3-file pattern)
| Handler | Purpose | Secret crosses IPC? |
|---|---|---|
| `cred:list` | available adapters + per-portal state (configured / last-run) | no |
| `cred:run` | open the sandbox + run the pull for one portal | no |
| `cred:cancel` | destroy the window, clear the session | no |
| `cred:status` | per-portal status incl. masked-tail of a stored cred (v2) | no (masked only) |
| `cred:save-cred` *(v2)* | one-way write to `portal-credentials.enc` | in only, never out |

Inputs validated (portalId ∈ known adapters); all automation main-process-only so **no renderer CSP
widening**.

### 6.6 Renderer surface
Extend the existing **Get Your Data** page (`src/pages/DataRights.tsx`, shipped #219): a source that has an
adapter gains an **"Automate this pull"** affordance next to its manual instructions, with a plain-language
note that a window will open for the user to log in, and that this is the brittle last-resort path. No new
top-level page.

---

## 7. First portal — selection rubric + candidates

The first adapter proves the harness end-to-end. Rubric:
1. The login yields a **file download** Compass **already ingests** (so we test the *whole* loop, not just
   the window).
2. **Standard, stable** login surface.
3. It's the user's **own** account, high personal value.
4. Robust enough that a DOM tweak won't break the demo weekly.

| Candidate | Pro | Con |
|---|---|---|
| **SSA — *my Social Security*** | We just shipped the SSA PDF recognizer (#220); downloads a statement PDF → full loop closes. High value. | Login.gov/ID.me MFA → assisted-mode mandatory (which *validates* Mode A). |
| **IRS — Individual Online Account** | Transcripts we already parse (tax recognizer, #218). | ID.me; transcript download flow is multi-step. |
| **USPS Informed Delivery** | Simple login, daily value, mail-piece data. | Output is images/email, not a clean export we parse yet → needs a new recognizer too. |
| A brokerage / loan servicer | Direct net-worth value, feeds Phase 4.5 forecast. | Highly variable DOM; pick a specific one at build time. |

> **Recommendation:** **SSA *my Social Security*** as the first adapter — it closes a loop we *just* built
> end-to-end (#220 → ingest), it's unambiguously the user's own high-value record, and its mandatory
> interactive MFA is the perfect forcing function for proving **Mode A (assisted, no stored creds)** is the
> right default. Confirm at build time (§12 Q1); verify the actual download flow then, since gov portals
> change.

---

## 8. Phased build plan

Each slice is independently shippable, gated, and ≥70%-covered where it has logic.

- **10.6a — Harness + first adapter (Mode A only).** `runtime.ts` (sandbox window + download capture +
  navigation allow-list + timeout/cancel), the `PortalAdapter` interface, **one** adapter (SSA per §7), the
  3 read/run IPC handlers, the **Get Your Data** "Automate this pull" affordance, the artifact→`ingestPath`
  handoff. **No credential storage.** `security-auditor` pass required to merge. Unit-test the runtime with
  a local fixture server (a tiny in-process HTTP server serving a fake "login → export.csv" so the whole
  loop is testable without a real portal or network).
- **10.6b — Second & third adapters.** Prove the abstraction generalizes (e.g. a brokerage + USPS),
  including one **scrape-mode** adapter to exercise that path. Add recognizers for any new artifact types.
- **10.6c — Stored-credential mode (Mode B, opt-in).** `vault.ts` (`portal-credentials`), `cred:save-cred`,
  masked-tail status, unattended run support. **Separate `security-auditor` pass.** Honest UI copy about the
  added risk.
- **10.6d — Scheduling.** Reuse the Morning-Brief/notification scheduler so opted-in portals pull on a
  cadence; results surface in the brief. (Mode B portals only.)
- **10.6e — ToS/legal note + docs.** The short honest posture statement ships in-app; `architecture.md` +
  `implementation_plan.md` updated.

---

## 9. ToS / legal / robustness posture

Stated plainly, in the product and here:
- Automating a login to retrieve **your own data** is the user acting as their own aggregator. Compass never
  retrieves anyone else's data and never acts against an account that isn't the signed-in user's own.
- Some portals' terms restrict automated access. Compass **prefers EXPORT/RIGHTS/LIVE** wherever a source
  offers them and surfaces CRED as the **last resort**, with a visible note that it may break and may be
  discouraged by a site's terms. The user opts in per source with that context.
- Scraping is **brittle by nature**. Adapters fail *cleanly and visibly* (a clear "this portal changed,
  the automation couldn't complete" message) — never silently, never with a half-ingested artifact.

---

## 10. What we explicitly will NOT do

Hard boundaries that keep CRED an aggregator-for-yourself, not an attack tool:
- **No defeating security controls.** No captcha-solving services, no MFA bypass, no anti-bot evasion. If a
  portal blocks automation, we stop and say so.
- **No credential autofill into arbitrary pages.** Stored creds (v2) are replayed only into the *pinned*
  origin of the adapter that owns them — never typed into a page the user navigated to freely.
- **No bulk / multi-account / credential-testing behavior.** One user, their own accounts, on their trigger.
- **No exfiltration.** Nothing a portal returns leaves the machine; the assistant/MCP never see it.
- **No silent scheduled runs in v1.** Scheduling is Mode B + explicit opt-in only.

---

## 11. Testing strategy

- **Runtime, hermetically:** spin a tiny in-process HTTP server (Node `http`) that serves a fake portal
  (`/login` → sets a cookie → `/account` with an "Export" button → serves `export.csv`). The test drives the
  real `runtime.ts` against `http://127.0.0.1:<port>` and asserts the file is captured to the temp dir and
  ingested into `records`. No real network, no real portal, fully deterministic.
- **Adapter logic:** unit-test `isLoggedIn`/`fetch` selectors against saved HTML fixtures.
- **Vault (v2):** reuse the `crypto-vault` test approach — round-trip, tamper-rejection, masked-tail only.
- **IPC:** input validation (unknown portalId rejected), no secret in any response payload, real-DB ingest
  of the captured artifact + re-run dedupe (content-hash).
- **Negative paths:** off-origin navigation blocked; oversized download rejected; timeout/cancel destroys
  the window and clears the session; a DOM-changed adapter fails cleanly.

---

## 12. Open questions — decide before 10.6a

1. **First portal.** Confirm **SSA *my Social Security*** (recommended, §7), or pick another. This sets the
   first adapter and what "done" looks like for 10.6a.
2. **Mode B at all?** Ship **assisted-only (no stored creds), Mode A** for the foreseeable future
   (recommended), or commit now to also building stored-credential unattended pulls (Mode B / 10.6c)? This
   is the single biggest risk decision.
3. **Session persistence.** Allow a portal to **stay logged in** between runs (persistent encrypted
   partition — convenient but a credential equivalent), or always start cold (safer; re-auth every run)?
4. **Scrape mode appetite.** Include DOM-scraping adapters (for portals with no download), or
   **download-only** until we've lived with the harness?

Default if unanswered: **Mode A, download-only, cold session, SSA first** — the safest viable engine.
