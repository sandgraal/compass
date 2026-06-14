/**
 * Best-effort account-type classification for SimpleFIN accounts (Phase 4.7).
 *
 * SimpleFIN's base `/accounts` payload has no standardized account-type field —
 * just a display name + the institution (`org`). Without classification every
 * linked account defaults to a `checking` / `spending` asset, which means a
 * credit card (e.g. Amex) lands on the ASSET side of net-worth and the
 * cash-flow forecast instead of as a liability — wrong for the headline use
 * case ("pull in my bank + Amex data").
 *
 * This is a conservative keyword heuristic over the account name + institution.
 * It only reclassifies on clear signals and falls back to checking/spending
 * otherwise; it runs ONLY when an account is first linked, so a user's manual
 * re-classification in the Accounts UI is never overwritten on later syncs.
 */

export type SimplefinAccountClass = {
  type: 'checking' | 'savings' | 'credit' | 'investment'
  isDebt: boolean
  assetClass: 'spending' | 'savings' | 'retirement' | 'liability'
}

// Loans/mortgages — debt, but distinct enough to keep separate for readability.
const LOAN_RE = /\b(loan|mortgage|heloc|line of credit)\b/
// Credit/charge cards. Card networks + "card"/"credit"/"charge" are reliable in
// a product name (e.g. "Platinum Card", "Blue Cash", "Sapphire Credit Card").
// `amex`/`american express` is included because nearly every connected Amex
// account is a card; an Amex savings product would need a manual reclassify.
const CREDIT_RE = /\b(credit|card|charge|visa|mastercard|amex|american express)\b/
const INVEST_RE = /\b(401\s?k|ira|roth|brokerage|invest|retirement|529|hsa)\b/
const SAVINGS_RE = /\b(saving|savings|money market|certificate|high.?yield)\b/

/**
 * Classify a SimpleFIN account from its display name + institution. Order
 * matters: debt signals win over asset signals (a "Savings Secured Credit
 * Card" is a card, not a savings account).
 */
export function classifySimplefinAccount(name: string, orgName: string): SimplefinAccountClass {
  const hay = `${name} ${orgName}`.toLowerCase()
  if (LOAN_RE.test(hay) || CREDIT_RE.test(hay)) {
    return { type: 'credit', isDebt: true, assetClass: 'liability' }
  }
  if (INVEST_RE.test(hay)) {
    return { type: 'investment', isDebt: false, assetClass: 'retirement' }
  }
  if (SAVINGS_RE.test(hay)) {
    return { type: 'savings', isDebt: false, assetClass: 'savings' }
  }
  return { type: 'checking', isDebt: false, assetClass: 'spending' }
}
