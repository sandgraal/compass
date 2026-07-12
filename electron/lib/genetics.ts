/**
 * Genetics raw-data import (Phase 10 — "The Acquisition Engine", §4b).
 *
 * The EXPORT/FILE path for 23andMe and AncestryDNA's "Download Raw Data" — a
 * plain-text file of comment lines (`#...`) followed by a tab-separated SNP
 * table. This module is deliberately NOT a `Recognizer` for the Drop Zone
 * (`electron/lib/recognizers.ts`) — genetics never projects onto the
 * `records`/Timeline spine. It only computes a coarse, non-identifying
 * SUMMARY (SNP count, chromosomes covered, reference build) for display in
 * the Vault; the raw genotype text itself is handled by the IPC layer
 * (`electron/ipc/vault.ts`), which stores it as one encrypted blob and never
 * parses it further. See docs/data-access-policy.md for the sealed-category
 * rationale.
 *
 * FORMAT CAVEAT: based on the documented/well-known 23andMe and AncestryDNA
 * raw-data layouts; unvalidated against a fresh real export.
 */

export type GenotypeProvider = '23andme' | 'ancestrydna'

const HEADER_23ANDME = ['rsid', 'chromosome', 'position', 'genotype']
const HEADER_ANCESTRYDNA = ['rsid', 'chromosome', 'position', 'allele1', 'allele2']

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i])
}

/**
 * The column header row — for 23andMe this is itself prefixed with `# ` (a
 * quirk of the real export), so unlike ordinary comment lines it can't just
 * be skipped; it has to be checked against the known column sets first.
 */
function providerForLine(trimmed: string): GenotypeProvider | null {
  const cols = trimmed
    .replace(/^#\s*/, '')
    .toLowerCase()
    .split('\t')
    .map((c) => c.trim())
  if (sameColumns(cols, HEADER_23ANDME)) return '23andme'
  if (sameColumns(cols, HEADER_ANCESTRYDNA)) return 'ancestrydna'
  return null
}

/** The first line recognized as a 23andMe/AncestryDNA column header, scanning both comment and plain lines. */
function findHeader(text: string): GenotypeProvider | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const provider = providerForLine(trimmed)
    if (provider) return provider
  }
  return null
}

/** Sniff whether `text` is a 23andMe or AncestryDNA raw-genotype export, or neither. */
export function detectGenotypeProvider(text: string): GenotypeProvider | null {
  return findHeader(text)
}

export interface GenotypeSummary {
  provider: GenotypeProvider
  snpCount: number
  chromosomes: string[]
  buildAssembly: string | null
}

/** Best-effort reference-build extraction from the comment header (e.g. "Build 37", "GRCh38"). */
function extractBuildAssembly(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('#')) continue
    const grch = trimmed.match(/GRCh\d+/i)
    if (grch) return grch[0]
    const build = trimmed.match(/build\s+(\d+)/i)
    if (build) return `Build ${build[1]}`
  }
  return null
}

/**
 * Summarize a genotype file's SHAPE only — never the SNP-level genotype
 * calls themselves. Skips comment lines and the header row.
 */
export function parseGenotypeSummary(text: string, provider: GenotypeProvider): GenotypeSummary {
  const chromosomes = new Set<string>()
  let snpCount = 0

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (providerForLine(trimmed)) continue // the column header row, not data
    const cols = trimmed.split('\t')
    const chromosome = cols[1]?.trim()
    if (!chromosome) continue
    chromosomes.add(chromosome)
    snpCount++
  }

  return {
    provider,
    snpCount,
    chromosomes: [...chromosomes].sort(),
    buildAssembly: extractBuildAssembly(text)
  }
}
