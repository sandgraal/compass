/**
 * Habit-streak math — pure helpers so the UI just renders.
 *
 * Streak semantics:
 *   - `currentStreak`: count of consecutive completed days ending at
 *     today (if today is completed) or yesterday (if today isn't yet
 *     entered). Today being unchecked while yesterday is complete is
 *     not yet a broken streak — the user might still tick it.
 *   - `longestStreak`: best run of consecutive completed days the
 *     habit has ever recorded.
 *
 * Input: a `{ 'YYYY-MM-DD': boolean }` map (the shape `habits:get-entries`
 * already returns). Anything not in the map is treated as "not completed".
 * Future dates are ignored.
 */

export type DateMap = Record<string, boolean>

/** Normalise a Date (or ISO string) to a `YYYY-MM-DD` local-date key. */
function toDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Shift a Date by `deltaDays` calendar days using year/month/day components
 * so DST transitions (±1 h) don't accidentally skip or repeat a day.
 */
function shiftDay(d: Date, deltaDays: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaDays)
}

export interface HabitStreak {
  current: number
  longest: number
}

/**
 * Compute current + longest streaks for a habit entries map. `today` can
 * be overridden for tests — defaults to "right now".
 */
export function computeHabitStreak(entries: DateMap, today: Date = new Date()): HabitStreak {
  // ── current streak ────────────────────────────────────────────────────────
  // Walk backwards from today. If today is unchecked but yesterday IS
  // checked, start counting from yesterday so the streak doesn't "break"
  // until end-of-day-yesterday has actually passed without a check-in.
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (!entries[toDateKey(cursor)]) {
    const yesterday = shiftDay(cursor, -1)
    if (entries[toDateKey(yesterday)]) {
      cursor = yesterday
    } else {
      // Today and yesterday both unchecked → no active streak.
      return { current: 0, longest: computeLongest(entries) }
    }
  }
  let current = 0
  // Safety bound: a habit can't have a streak longer than the number of
  // days since the unix epoch. The break condition below handles the
  // real exit; this is just to avoid an infinite loop on bad data.
  for (let i = 0; i < 100_000; i++) {
    if (!entries[toDateKey(cursor)]) break
    current++
    cursor = shiftDay(cursor, -1)
  }

  return { current, longest: Math.max(current, computeLongest(entries)) }
}

/**
 * Longest-ever run of consecutive `true` days, looking at the full
 * entries map regardless of today. Robust to arbitrary date keys.
 */
function computeLongest(entries: DateMap): number {
  const completedKeys = Object.entries(entries)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
  if (completedKeys.length === 0) return 0

  let longest = 1
  let run = 1
  for (let i = 1; i < completedKeys.length; i++) {
    // Parse components so DST transitions don't shift the calendar date.
    // Note: JS Date month is 0-indexed, but ISO keys are 1-indexed — hence `pm - 1`.
    const [py, pm, pd] = completedKeys[i - 1].split('-').map(Number)
    const expectedNext = new Date(py, pm - 1, pd + 1)
    if (toDateKey(expectedNext) === completedKeys[i]) {
      run++
      if (run > longest) longest = run
    } else {
      run = 1
    }
  }
  return longest
}

// Exported for unit tests.
export const _internal = { toDateKey, shiftDay }
