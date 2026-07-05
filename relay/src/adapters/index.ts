/** Adapter registry (Phase 10.9). Add an aggregator = add one entry here. */

import { TERRA_ADAPTER } from './terra.js'
import type { AggregatorAdapter } from './types.js'

export type { AggregatorAdapter, RelayEnv } from './types.js'

const ADAPTERS: Record<string, AggregatorAdapter> = {
  terra: TERRA_ADAPTER
}

export function getAdapter(id: string): AggregatorAdapter | undefined {
  return ADAPTERS[id]
}
