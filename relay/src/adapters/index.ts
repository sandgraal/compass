/** Adapter registry (Phase 10.9). Add an aggregator = add one entry here. */

import { ARCADIA_ADAPTER } from './arcadia.js'
import { ARGYLE_ADAPTER } from './argyle.js'
import { CANOPY_ADAPTER } from './canopy.js'
import { KNOT_ADAPTER } from './knot.js'
import { METRIPORT_ADAPTER } from './metriport.js'
import { NYLAS_ADAPTER } from './nylas.js'
import { TERRA_ADAPTER } from './terra.js'
import type { AggregatorAdapter } from './types.js'

export type { AggregatorAdapter, RelayEnv } from './types.js'

const ADAPTERS: Record<string, AggregatorAdapter> = {
  terra: TERRA_ADAPTER,
  canopy: CANOPY_ADAPTER,
  argyle: ARGYLE_ADAPTER,
  arcadia: ARCADIA_ADAPTER,
  metriport: METRIPORT_ADAPTER,
  nylas: NYLAS_ADAPTER,
  knot: KNOT_ADAPTER
}

export function getAdapter(id: string): AggregatorAdapter | undefined {
  return ADAPTERS[id]
}
