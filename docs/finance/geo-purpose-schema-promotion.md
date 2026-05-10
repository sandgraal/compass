# ADR: Promote `geo` and `purpose` from notes-tag tokens to indexed columns

## Status

Proposed.

## Context

The Rocket Money import shipped (PR `feat/finance-rocket-money-import`) with
`geo` and `purpose` stored as pipe-delimited tokens inside the existing `notes`
text column:

```
notes: "rm:Groceries | geo:CR | purpose:household"
```

This was a deliberate "land it without a migration" choice and it works
correctly — `tagGeoAndPurpose()` is idempotent, queries via `parseNotesTags()`
do the parse on the read side, the new `finance:get-geo-summary` IPC handler
walks all rows in JS and tallies.

The tradeoffs are now visible:

- Every geo/purpose query reads + parses every row. Fine at 3,100 txns;
  measurably slow at 30,000.
- No SQL aggregation. The IPC handler does `SELECT * FROM finance_transactions`
  then JS-side groups. Can't push aggregation into SQLite, can't index, can't
  use Drizzle relational queries.
- Data integrity is by convention. Misformed `notes` is a silent miscategory.
- UI filters (e.g. "show only CR transactions") are awkward — would need
  `LIKE '%geo:CR%'` which doesn't use any index.

## Decision

Promote both fields to first-class columns on `financeTransactions`. The
`notes` column keeps user-facing free-form notes only (and the Rocket Money
`rm:CATEGORY` token, which serves a different purpose: input fallback, not
output query).

## Schema change

```ts
// electron/db/schema.ts (modify financeTransactions)
geo: text('geo').notNull().default('US'),       // 'CR' | 'US' | 'SPAIN' | 'COLOMBIA' | 'PANAMA' | 'OTHER'
purpose: text('purpose'),                       // 'capex' | 'operating' | 'household' | 'travel' | 'other' | null
```

Indexes:

```sql
CREATE INDEX idx_finance_transactions_geo ON finance_transactions(geo);
CREATE INDEX idx_finance_transactions_geo_purpose ON finance_transactions(geo, purpose);
CREATE INDEX idx_finance_transactions_geo_date ON finance_transactions(geo, date);
```

## Migration

`db/migrations/NNNN_promote_geo_purpose.sql`:

```sql
ALTER TABLE finance_transactions ADD COLUMN geo TEXT NOT NULL DEFAULT 'US';
ALTER TABLE finance_transactions ADD COLUMN purpose TEXT;

-- Backfill from notes tags
UPDATE finance_transactions
SET geo = SUBSTR(
  notes,
  INSTR(notes, 'geo:') + 4,
  CASE
    WHEN INSTR(SUBSTR(notes, INSTR(notes, 'geo:') + 4), ' ') > 0
      THEN INSTR(SUBSTR(notes, INSTR(notes, 'geo:') + 4), ' ') - 1
    WHEN INSTR(SUBSTR(notes, INSTR(notes, 'geo:') + 4), '|') > 0
      THEN INSTR(SUBSTR(notes, INSTR(notes, 'geo:') + 4), '|') - 1
    ELSE LENGTH(notes)
  END
)
WHERE notes LIKE '%geo:%';

-- Same shape for purpose (nullable, no default)
UPDATE finance_transactions
SET purpose = ...
WHERE notes LIKE '%purpose:%';

CREATE INDEX idx_finance_transactions_geo ON finance_transactions(geo);
CREATE INDEX idx_finance_transactions_geo_purpose ON finance_transactions(geo, purpose);
CREATE INDEX idx_finance_transactions_geo_date ON finance_transactions(geo, date);
```

The SUBSTR/INSTR dance is fragile — recommend doing the backfill as a
TypeScript script after the column add, using `parseNotesTags()`:

```ts
// scripts/backfill-geo-purpose-columns.ts
const rows = db.select().from(financeTransactions).all()
for (const r of rows) {
  const { geo, purpose } = parseNotesTags(r.notes)
  db.update(financeTransactions)
    .set({ geo: geo ?? 'US', purpose: purpose ?? null })
    .where(eq(financeTransactions.id, r.id))
    .run()
}
```

That keeps the migration SQL minimal (just column adds) and the parsing logic
in one place.

## Code changes

### `finance-geo.ts`

- Keep `classifyGeo` / `classifyPurpose` — still used at ingest time.
- Replace `tagGeoAndPurpose(txns)` (which mutates `notes`) with
  `tagGeoAndPurpose(txns)` returning `RawTxn` with `geo` + `purpose` set
  directly.
- Drop `upsertNotesTags` and the `notes`-parsing branch of `parseNotesTags`.
  Keep `parseNotesTags` only for the migration backfill script; mark deprecated
  with a JSDoc note pointing at the new shape.

### `finance.ts` ingest

- `RawTxn` gains `geo`, `purpose` fields.
- `ingestCsvFolder` writes them directly to the new columns instead of
  munging `notes`.

### `ipc/finance.ts`

- `finance:get-geo-summary` becomes a SQL aggregation:
  ```sql
  SELECT geo, SUM(-amount) AS total, COUNT(*) AS count
  FROM finance_transactions
  WHERE amount < 0 AND category NOT IN ('Transfers', 'Cash')
    AND date >= ?
  GROUP BY geo
  ORDER BY total DESC
  ```
  Same for the CR purpose breakdown. Drop the JS-side aggregation pass.

### `Finance.tsx`

- `CrSubsTab` is unaffected — it consumes the IPC's already-aggregated
  output. The change is invisible to the UI.
- Optional next-step UI: a Transactions tab geo filter (chip selector
  CR / US / etc.) — easy now that `geo` is indexed.

## Test coverage required

- `finance-geo.test.ts` updates: the tagger writes to `geo` / `purpose`
  fields, not `notes`.
- New migration test: backfill from notes correctly populates the columns
  for a fixture row set.
- `finance:get-geo-summary` returns the same shape as before for existing
  callers (UI doesn't break).

## Out of scope

- Migrating the `rm:CATEGORY` token out of `notes`. That token is still used
  by the categorizer's RM-fallback step and has no query-side need; it stays.
- Multi-tag support per txn (e.g. a CR txn that's both household AND business).
  The existing single-tag model is sufficient; revisit if a real case appears.

## Suggested driver

`migration-author` for the SQL + Drizzle migration; `integration-implementer`
for the codebase update; one shared PR.

Single small-medium PR (~250 LOC + the migration). Do this BEFORE
`net-worth.md` — net worth queries will benefit from the indexes.
