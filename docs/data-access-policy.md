# Data-access policy — "everything sees everything"

*Adopted 2026-07 (the "tear down the silos" arc). This is the single normative
statement every boundary comment in the codebase points at. If a comment and
this document disagree, this document wins — fix the comment.*

## The policy

> **Every domain flows onto the `records` spine and is readable in full detail
> by every surface** — the Timeline, ⌘K global search, People/Places/insights,
> the in-app Ask Compass assistant, and the Compass MCP server — **with exactly
> four exceptions:**
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
>    their `service` label only; the assistant has no vault tool at all; the
>    MCP can't reach the vault, period.
> 3. **The vault `genetics` category stays sealed everywhere, like
>    `credentials`.** Raw 23andMe/AncestryDNA genotype data is uniquely
>    sensitive — immutable, family-implicating, and a GINA discrimination
>    risk. The category only ever holds an import summary (provider, SNP
>    count, reference build); the raw genotype text is a separate encrypted
>    blob (`electron/ipc/vault.ts` `vault:import-genetics-file`), never
>    parsed into structured data or rendered field-by-field.
> 4. **Life-record SECRET field values stay sealed everywhere.** The vault
>    split (2026-07) moved the old document categories (`financial`,
>    `identity`, `medical`, `legal`, `foreign-accounts`) into the plaintext
>    `life_records` table — their METADATA (institutions, document types,
>    parties, dates, notes) is now first-class data: searchable, on the
>    timeline, and readable by the assistant AND the MCP server
>    (`compass_life_records`). But each record's secret field values —
>    account/routing numbers, SSN/passport/license numbers, insurance
>    member/group IDs — live only in the encrypted
>    `.vault/record-secrets.enc` blob, keyed by row id
>    (`electron/ipc/life-records.ts`). They are not in the DB, not in any
>    index, not in exports, and not reachable by any AI surface; the renderer
>    fetches them one record at a time (`life:get-secrets`) behind
>    reveal/copy affordances. Structurally, the vault is now **secrets-only**
>    (credentials + genetics + record-secrets), and no process without
>    OS-Keychain access can read any of it.

Everything else that once looked like a wall is gone **on purpose**: raw
transactions, full medical records, contacts, paystubs, utility bills, habits,
tasks, travel segments, financial goals, rental comps, snapshot facts, and
life-record metadata are all full-detail readable, in-app and by AI.

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
  an export is a plaintext artifact that leaves the app's custody. Life-record
  METADATA is included (`life-records.csv`); the secret halves are not.
- **Device sync** (`electron/integrations/device-sync.ts`, Phase 4b) is the
  one path that egresses the full dataset, vault included — but ONLY
  passphrase-encrypted, only to the user-configured relay, and only on an
  explicit push. Unlike exports, it doesn't exclude the vault; encryption is
  the boundary here, not exclusion — the relay stores ciphertext it cannot
  read (`relay/src/sync.ts`).
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
| GPS off the spine | `insertLocationPoints` routes to `location_points`; no projector reads it | `electron/ipc/records-reclassify.test.ts` (asserts geolocation rows land in `location_points`, off `records`); `electron/lib/amazon-export.test.ts` |
| Credentials sealed in ⌘K | title-field allowlist only for `credentials` in `electron/ipc/search.ts` | `electron/ipc/search.test.ts` |
| No vault tool in the assistant | the assistant reads `life_records` from the DB (`search_life_records` / `get_life_record`); no tool can decrypt anything | `electron/integrations/assistant-tools.test.ts` |
| Genetics sealed everywhere | raw genotype text never enters the category's own entries — separate encrypted blob in `electron/ipc/vault.ts` | `electron/lib/genetics.test.ts` (summary never contains raw genotype calls) |
| Life-record secrets sealed | secret field values routed to `.vault/record-secrets.enc` at write time (`SECRET_FIELDS_BY_CATEGORY` in `electron/lib/life-records.ts`); the DB row never holds them, so search/timeline/assistant/MCP/exports structurally cannot leak them | `electron/lib/life-records.test.ts`, `electron/ipc/life-records.test.ts`, `electron/lib/storehouse-projectors.test.ts` |
| Vault unreachable from MCP | structural — separate process, read-only `compass.db`, no Keychain | `mcp/compass-mcp/index.ts` header |
| No vault plaintext on disk | decrypt-per-query in `searchVault` (credentials titles) and `life:get-secrets`; no FTS over any vault blob | `electron/ipc/search.ts` comments + tests |
| Migrated vault categories sealed from IPC | `assertKnownCategory` in `electron/ipc/vault.ts` rejects the five old category names (and `record-secrets`) | `electron/ipc/vault.test.ts` |

## History

The pre-2026-07 model ("vault never exposed; finance/health/income/medical
aggregates-only to AI; hard silos for medical/location/habits/paystubs/etc.")
is described in git history and superseded by this policy. The Phase 10.7
"records exception" is no longer an exception — full-detail is the norm.

The vault split (later 2026-07) replaced the old exception 4 ("vault documents
are in-app-assistant-only"): the five document categories moved out of the
vault into the plaintext `life_records` table, closing the in-app/MCP
asymmetry for their metadata. Only true secrets remain encrypted — see the
current exception 4. A user's pre-split category blobs are migrated once at
boot (`electron/integrations/vault-life-migration.ts`) and retired as
`<category>.migrated.enc` backups.
