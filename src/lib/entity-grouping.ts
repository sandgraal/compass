/**
 * Category-grouped, sortable rendering for the Merchants/Places tracked
 * lists. Generic over a small `sortMetrics` shape the caller supplies (spend
 * for merchants, visit count for places) rather than hardcoding merchant
 * fields — both pages map their own `TrackedMerchant`/`TrackedPlace` rows
 * into this shape before calling groupAndSort.
 */

export type SortKey = 'name' | 'primaryMetric' | 'recent' | 'count'

export interface GroupableEntity {
  id: number
  name: string
  category: string | null
  sortMetrics: {
    /** Spend for merchants, visit count for places — the category-total ranking signal. */
    primaryMetric: number
    lastActivity: number | null
    count: number
  }
}

export interface EntityGroup<T> {
  category: string
  items: T[]
}

const UNCATEGORIZED = 'Uncategorized'

function sortItems<T extends GroupableEntity>(items: T[], sortBy: SortKey): T[] {
  const sorted = [...items]
  switch (sortBy) {
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name))
      break
    case 'primaryMetric':
      sorted.sort((a, b) => b.sortMetrics.primaryMetric - a.sortMetrics.primaryMetric)
      break
    case 'recent':
      sorted.sort((a, b) => (b.sortMetrics.lastActivity ?? 0) - (a.sortMetrics.lastActivity ?? 0))
      break
    case 'count':
      sorted.sort((a, b) => b.sortMetrics.count - a.sortMetrics.count)
      break
  }
  return sorted
}

/**
 * Groups by `category` (blank/missing → "Uncategorized", always sorted last),
 * other groups ordered by their total `primaryMetric` descending, items
 * within each group ordered by the caller's chosen sort key.
 */
export function groupAndSort<T extends GroupableEntity>(
  items: T[],
  sortBy: SortKey
): EntityGroup<T>[] {
  const byCategory = new Map<string, T[]>()
  for (const item of items) {
    const cat = item.category?.trim() || UNCATEGORIZED
    const list = byCategory.get(cat) ?? []
    list.push(item)
    byCategory.set(cat, list)
  }
  const groups: EntityGroup<T>[] = [...byCategory.entries()].map(([category, groupItems]) => ({
    category,
    items: sortItems(groupItems, sortBy)
  }))
  groups.sort((a, b) => {
    if (a.category === UNCATEGORIZED) return 1
    if (b.category === UNCATEGORIZED) return -1
    const totalA = a.items.reduce((s, i) => s + i.sortMetrics.primaryMetric, 0)
    const totalB = b.items.reduce((s, i) => s + i.sortMetrics.primaryMetric, 0)
    return totalB - totalA
  })
  return groups
}
