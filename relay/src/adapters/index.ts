/** Adapter registry (Phase 10.9). Add an aggregator = add one entry here. */

import { CANOPY_ADAPTER } from './canopy.js'
import { TERRA_ADAPTER } from './terra.js'
import type { AggregatorAdapter } from './types.js'

export type { AggregatorAdapter, RelayEnv } from './types.js'

const ADAPTERS: Record<string, AggregatorAdapter> = {
  terra: TERRA_ADAPTER,
  canopy: CANOPY_ADAPTER
}

export function getAdapter(id: string): AggregatorAdapter | undefined {
  return ADAPTERS[id]
}
