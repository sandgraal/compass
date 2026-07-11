# Data-access policy — "everything sees everything"

*Adopted 2026-07 (the "tear down the silos" arc). This is the single normative
statement every boundary comment in the codebase points at. If a comment and
this document disagree, this document wins — fix the comment.*

## The policy

> **Every domain flows onto the `records` spine and is readable in full detail
> by every surface** — the Timeline, ⌘K global search, People/Places/insights,
> the in-app Ask Compass assistant, and the Compass MCP server — **with exactly
> three exceptions:**
>
> 1. **Raw GPS coordinates never enter `records` or any AI surface.**
>    `location_points` is its own table, off the spine; only the derived,
>    coarse `travel_segments` (country + date window) project. The AI search
>    paths have no per-source denylist, so *keeping coordinates out of the
>    table IS the wall.*
> 2. **The vault `credentials` category and all token vaults stay sealed
>    everywhere.** Passwords, API keys, Plaid/SimpleFIN access tokens, and
>    LLM keys are *access keys, not life data* — indexing or exposing them is
>    leak risk with zero feature value. ⌘K searches credential entries by
>    their `service` label only; the assistant's vault tools refuse the
>    category at the tool boundary; the MCP can't reach the vault at all.
> 3. **Vault bodies are never written to any on-disk index.** Encryption at
>    rest stays. The open document categories (`financial`, `identity`,
>    `medical`, `legal`, `foreign-accounts`) are decrypted **per query, in
>    memory, in the Electron main process only**. Consequence: the MCP server
>    (a separate process with no OS-Keychain access) **cannot** read the
>    vault — vault documents are in-app-assistant-only. This asymmetry is
>    structural, not a preference.

Everything else that once looked like a wall is gone **on purpose**: raw
transactions, full medical records, contacts, paystubs, utility bills, habits,
tasks, travel segments, financial goals, rental comps, and snapshot facts are
all full-detail readable, in-app and by AI.

## What this means for cloud exposure

Ask Compass (agent mode) and any MCP client (Claude Desktop/Code/Cowork) can
pull full-detail tool results into an LLM conversation. With a BYO key that
data reaches Anthropic/OpenAI on user-initiated turns. **This is a documented,
deliberate decision by the app's sole user** — not an accident to be "fixed"
by re-walling domains. The propose→approve write funnel (Claude Inbox) is
unchanged: AI reads everything, writes nothing without human approval.

## What's still true (not walls — different properties)

- **Encryption at rest**: `.vault/*.enc` stays AES-256-GCM, key in the OS
  Keychain via `safeStorage`. Opening data to *search* did not put plaintext
  on disk.
- **Portable exports** (`electron/ipc/export.ts`) still exclude the vault —
  an export is a plaintext artifact that leaves the app's custody.
- **Stripped-at-ingest data is gone, not hidden**: credit-report SSN/DOB,
  paystub per-tax lines, and raw Metriport clinical values were never stored.
  Re-import would be required to recover them; nothing in the app can.
- **On-this-day sensitivity guard** (`electron/lib/timeline-memories.ts`):
  medical records and grief/loss language never *auto-resurface* in memories.
  That's resurfacing etiquette, not access — those records stay fully
  browsable and searchable everywhere.
- **Timeline noise tiers** (`electron/lib/source-tiers.ts`): habit checks and
  tasks are collapsed-by-default on the Timeline (firehose tier). Display
  curation, not access.
- **People are not derived from bank memos** (`electron/lib/entities.ts`) —
  a signal-quality call (memos fail `isLikelyPerson` constantly), not privacy.

## Where the policy is enforced

| Exception | Enforcement | Locked in by |
|---|---|---|
| GPS off the spine | `insertLocationPoints` routes to `location_points`; no projector reads it | `electron/ipc/records.test.ts` |
| Credentials sealed in ⌘K | title-field allowlist only for `credentials` in `electron/ipc/search.ts` | `electron/ipc/search.test.ts` |
| Credentials sealed in the assistant | category refused at the tool boundary; `VaultReader` allowlist (defense in depth) in `electron/ipc/assistant.ts` | `electron/integrations/assistant-tools.test.ts` |
| Vault unreachable from MCP | structural — separate process, read-only `compass.db`, no Keychain | `mcp/compass-mcp/index.ts` header |
| No vault plaintext on disk | decrypt-per-query in `searchVault` / `VaultReader`; no FTS over vault | `electron/ipc/search.ts` comments + tests |

## History

The pre-2026-07 model ("vault never exposed; finance/health/income/medical
aggregates-only to AI; hard silos for medical/location/habits/paystubs/etc.")
is described in git history and superseded by this policy. The Phase 10.7
"records exception" is no longer an exception — full-detail is the norm.
