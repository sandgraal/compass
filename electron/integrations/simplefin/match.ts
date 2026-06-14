/**
 * Conservative account matching for SimpleFIN connect (Phase 4.7 — #1).
 *
 * When the sync sees a SimpleFIN account it hasn't linked before, we try to
 * ADOPT an existing unlinked account (manual / CSV-era) instead of creating a
 * duplicate. Because this runs against someone's real financial accounts, the
 * bar is deliberately high — wrongly merging two accounts is worse than leaving
 * a duplicate the user can merge later (the #4 tool). So we only match on:
 *
 *   - the same institution, AND
 *   - the same last-4, AND
 *   - exactly one existing account qualifying.
 *
 * Anything fuzzier (no parseable last-4, name-only similarity, 0 or >1
 * candidates) falls through to "create new".
 */

export type MatchCandidate = {
  id: number
  name: string
  institution: string | null
  mask: string | null
}

export type IncomingAccount = {
  name: string
  orgName: string
  mask?: string | null
}

/**
 * The last 4 digits found in a string — works for a bare mask ('1234') or a
 * name with an embedded number ('Platinum Card (·2001)' → '2001'). Returns null
 * when there aren't at least 4 digits to key on.
 */
export function last4(s: string | null | undefined): string | null {
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

const normInstitution = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()

/**
 * Return the id of the single existing unlinked account that matches the
 * incoming SimpleFIN account by institution + last-4, or null when there is no
 * unambiguous match (no parseable last-4, or 0 / >1 qualifying candidates).
 */
export function findAccountMatch(
  incoming: IncomingAccount,
  candidates: MatchCandidate[]
): number | null {
  const wantInstitution = normInstitution(incoming.orgName)
  const wantLast4 = last4(incoming.mask) ?? last4(incoming.name)
  if (!wantInstitution || !wantLast4) return null

  const hits = candidates.filter(
    (c) =>
      normInstitution(c.institution) === wantInstitution &&
      (last4(c.mask) ?? last4(c.name)) === wantLast4
  )
  return hits.length === 1 ? hits[0].id : null
}
