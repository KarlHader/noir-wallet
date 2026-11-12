import type { ChainFamily } from '@/core/chains/registry/capabilities'
import { parseChainId } from '@/core/chains/registry'
import { isBitcoinChainId, isDashChainId } from '@/core/chains/registry/chain-ids'

/**
 * Maps a CAIP-2 chain ID to the Ledger chain family the signing guard
 * validates against. Unknown namespaces are rejected by returning `null`.
 */
export function ledgerSigningChainFamily(chainId: string): ChainFamily | null {
  const parsed = parseChainId(chainId)
  if (parsed.namespace === 'eip155') return 'evm'
  if (parsed.namespace === 'solana') return 'solana'
  if (parsed.namespace === 'near') return 'near'
  if (parsed.namespace === 'starknet') return 'starknet'
  if (isBitcoinChainId(parsed.id)) return 'bitcoin'
  if (isDashChainId(parsed.id)) return 'dash'
  return null
}
