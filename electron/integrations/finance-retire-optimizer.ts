/**
 * optimizer — "what's the smallest change that reaches a target success rate?"
 * (Phase 11.4 — ported from retire-early-hub `utils/optimizer.js`). Searches three
 * user-controlled levers (CR expenses, freelance years, retirement age) with a
 * seeded, success-only Monte Carlo so results are reproducible and fast.
 */
import { type RetireInputs, computePlan, sanitizeInputs } from './finance-retire-engine'
import { makeRng, runMonteCarlo } from './finance-retire-math'

const SEED = 20290101

/** Success probability (%) for an input set — deterministic via the seeded RNG. */
export function evaluateSuccess(
  inputs: Record<string, unknown>,
  { simulations = 600 }: { simulations?: number } = {}
): number {
  const plan = computePlan(inputs)
  const i = plan.inputs
  const inflationMean = (1 + i.crInflationRate) * (1 + i.fxDriftPct) - 1
  const years = Math.max(1, i.planToAge - i.retirementAge)
  const mc = runMonteCarlo({
    startBalance: plan.startBalance,
    annualExpenses: i.annualExpenses,
    meanReturn: i.postRetireReturn,
    stdDev: i.stdDev,
    inflationMean,
    inflationStd: 0.02,
    years,
    simulations,
    ssStartAge: i.ssStartAge,
    ssMonthly: i.ssMonthly,
    ssColaRate: i.ssColaRate,
    currentAge: i.retirementAge,
    additionalIncome: i.freelanceMonthly,
    freelanceYears: i.freelanceYears,
    taxDrag: plan.taxDrag,
    rng: makeRng(SEED),
    pathsNeeded: false
  })
  return Number.parseFloat(mc.successRate)
}

// Delaying retirement also adds accumulation years.
const delayRetire = (inp: RetireInputs, years: number): RetireInputs => ({
  ...inp,
  retirementAge: inp.retirementAge + years,
  yearsToRetirement: inp.yearsToRetirement + years
})

export type OptimizerLever = {
  key: 'expenses' | 'freelance' | 'retireAge'
  label: string
  unit: string
  sensitivity: number
  required:
    | { kind: 'expenses'; cutMonthly: number; newMonthly: number }
    | { kind: 'freelance'; addYears: number; newYears: number }
    | { kind: 'retireAge'; addYears: number; newAge: number }
    | null
}

export type OptimizeResult = {
  baseSuccess: number
  target: number
  levers: OptimizerLever[]
}

/**
 * For each lever, find the minimal change to reach `target` and its marginal
 * sensitivity.
 */
export function optimizePlan(
  baseInputs: Record<string, unknown>,
  target = 90,
  opts: { simulations?: number } = {}
): OptimizeResult {
  const base = sanitizeInputs(baseInputs)
  const baseSuccess = evaluateSuccess(base, opts)
  const hit = (s: number): boolean => s >= target

  // Expenses — minimal monthly cut (search in $100/mo steps).
  const expenses = ((): OptimizerLever => {
    const baseAnnual = base.annualExpenses
    let required: OptimizerLever['required'] = null
    for (let cutMo = 100; cutMo <= 5000; cutMo += 100) {
      const v = baseAnnual - cutMo * 12
      if (v <= 0) break
      if (hit(evaluateSuccess({ ...base, annualExpenses: v }, opts))) {
        required = { kind: 'expenses', cutMonthly: cutMo, newMonthly: Math.round(v / 12) }
        break
      }
    }
    // Probe a $300/mo cut and normalize per-$100/mo (a $100 probe is too small).
    const sens =
      (evaluateSuccess({ ...base, annualExpenses: baseAnnual - 300 * 12 }, opts) - baseSuccess) / 3
    return {
      key: 'expenses',
      label: 'Cut CR spending',
      unit: 'per $100/mo cut',
      sensitivity: sens,
      required
    }
  })()

  // Freelance — more years of part-time income.
  const freelance = ((): OptimizerLever => {
    const baseYears = base.freelanceYears
    let required: OptimizerLever['required'] = null
    for (let add = 1; add <= 20; add++) {
      if (hit(evaluateSuccess({ ...base, freelanceYears: baseYears + add }, opts))) {
        required = { kind: 'freelance', addYears: add, newYears: baseYears + add }
        break
      }
    }
    const sens =
      (evaluateSuccess({ ...base, freelanceYears: baseYears + 2 }, opts) - baseSuccess) / 2
    return {
      key: 'freelance',
      label: 'Work freelance longer',
      unit: 'per +1 year',
      sensitivity: sens,
      required
    }
  })()

  // Retirement age — delay (adds accumulation, shortens drawdown).
  const retireAge = ((): OptimizerLever => {
    const baseAge = base.retirementAge
    let required: OptimizerLever['required'] = null
    for (let add = 1; add <= 14; add++) {
      if (hit(evaluateSuccess(delayRetire(base, add), opts))) {
        required = { kind: 'retireAge', addYears: add, newAge: baseAge + add }
        break
      }
    }
    const sens = (evaluateSuccess(delayRetire(base, 2), opts) - baseSuccess) / 2
    return {
      key: 'retireAge',
      label: 'Delay retirement',
      unit: 'per +1 year',
      sensitivity: sens,
      required
    }
  })()

  return { baseSuccess, target, levers: [expenses, freelance, retireAge] }
}
