import { describe, expect, it } from 'vitest'
import { type GroupableEntity, groupAndSort } from './entity-grouping'

function e(over: Partial<GroupableEntity> & { id: number; name: string }): GroupableEntity {
  return {
    category: null,
    sortMetrics: { primaryMetric: 0, lastActivity: null, count: 0 },
    ...over
  }
}

describe('groupAndSort', () => {
  it('groups by category, bucketing blank/missing into Uncategorized', () => {
    const items = [
      e({ id: 1, name: 'Starbucks', category: 'Coffee' }),
      e({ id: 2, name: 'Amazon', category: '' }),
      e({ id: 3, name: 'Gym', category: null })
    ]
    const groups = groupAndSort(items, 'name')
    expect(groups.map((g) => g.category)).toEqual(['Coffee', 'Uncategorized'])
    expect(groups[1].items.map((i) => i.id)).toEqual([2, 3])
  })

  it('always sorts Uncategorized last, regardless of spend', () => {
    const items = [
      e({
        id: 1,
        name: 'A',
        category: null,
        sortMetrics: { primaryMetric: 1000, lastActivity: null, count: 0 }
      }),
      e({
        id: 2,
        name: 'B',
        category: 'Cafe',
        sortMetrics: { primaryMetric: 1, lastActivity: null, count: 0 }
      })
    ]
    const groups = groupAndSort(items, 'name')
    expect(groups.map((g) => g.category)).toEqual(['Cafe', 'Uncategorized'])
  })

  it('orders categories by total primaryMetric descending', () => {
    const items = [
      e({
        id: 1,
        name: 'A',
        category: 'Low',
        sortMetrics: { primaryMetric: 10, lastActivity: null, count: 0 }
      }),
      e({
        id: 2,
        name: 'B',
        category: 'High',
        sortMetrics: { primaryMetric: 500, lastActivity: null, count: 0 }
      })
    ]
    const groups = groupAndSort(items, 'name')
    expect(groups.map((g) => g.category)).toEqual(['High', 'Low'])
  })

  it('sorts items within a group by name', () => {
    const items = [
      e({ id: 1, name: 'Zebra', category: 'Cafe' }),
      e({ id: 2, name: 'Apple', category: 'Cafe' })
    ]
    const [group] = groupAndSort(items, 'name')
    expect(group.items.map((i) => i.name)).toEqual(['Apple', 'Zebra'])
  })

  it('sorts items within a group by primaryMetric descending', () => {
    const items = [
      e({
        id: 1,
        name: 'A',
        category: 'Cafe',
        sortMetrics: { primaryMetric: 5, lastActivity: null, count: 0 }
      }),
      e({
        id: 2,
        name: 'B',
        category: 'Cafe',
        sortMetrics: { primaryMetric: 50, lastActivity: null, count: 0 }
      })
    ]
    const [group] = groupAndSort(items, 'primaryMetric')
    expect(group.items.map((i) => i.id)).toEqual([2, 1])
  })

  it('sorts items within a group by most recent activity', () => {
    const items = [
      e({
        id: 1,
        name: 'A',
        category: 'Cafe',
        sortMetrics: { primaryMetric: 0, lastActivity: 100, count: 0 }
      }),
      e({
        id: 2,
        name: 'B',
        category: 'Cafe',
        sortMetrics: { primaryMetric: 0, lastActivity: 500, count: 0 }
      }),
      e({
        id: 3,
        name: 'C',
        category: 'Cafe',
        sortMetrics: { primaryMetric: 0, lastActivity: null, count: 0 }
      })
    ]
    const [group] = groupAndSort(items, 'recent')
    expect(group.items.map((i) => i.id)).toEqual([2, 1, 3])
  })

  it('sorts items within a group by count descending', () => {
    const items = [
      e({
        id: 1,
        name: 'A',
        category: 'Cafe',
        sortMetrics: { primaryMetric: 0, lastActivity: null, count: 2 }
      }),
      e({
        id: 2,
        name: 'B',
        category: 'Cafe',
        sortMetrics: { primaryMetric: 0, lastActivity: null, count: 9 }
      })
    ]
    const [group] = groupAndSort(items, 'count')
    expect(group.items.map((i) => i.id)).toEqual([2, 1])
  })
})
