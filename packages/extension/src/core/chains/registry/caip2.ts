import type { ChainId, ChainNamespace, ChainReference } from '@/core/chains/domain'

const CAIP2_PATTERN = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/

export interface ParsedChainId {
  readonly id: ChainId
  readonly namespace: ChainNamespace
  readonly reference: ChainReference
}

export function parseChainId(value: string): ParsedChainId {
  const match = CAIP2_PATTERN.exec(value)
  if (!match) {
    throw new Error(`Invalid CAIP-2 chain ID: ${value}`)
  }

  return {
    id: value as ChainId,
    namespace: match[1] as ChainNamespace,
    reference: match[2] as ChainReference
  }
}
