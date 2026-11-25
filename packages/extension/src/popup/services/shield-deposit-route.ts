import type { SwapToken } from '@/core/services/intents-api'
import type { Network } from '@/types/wallet'
import type { AccountNetworkView } from './account-networks-client'
import type { ShieldProvider } from './asset-domains'
import {
  availableDepositTokens,
  defaultDepositRefundAddress,
  depositRefundAddressError,
  depositSourceAssetId,
  depositSourceNetworks,
  depositTokenChainId
} from './shield-deposit-options'

export type ShieldDepositSource = 'public' | 'private' | 'external'

export function shieldDepositSource(value: string | null): ShieldDepositSource {
  return value === 'private' || value === 'external' ? value : 'public'
}

export function resolveShieldReceiveProvider(input: {
  readonly nativeZec: boolean
  readonly canReceiveNativeZec: boolean
  readonly nearSupportsAsset: boolean
  readonly preferred: ShieldProvider | null
}) {
  const available = {
    'near-confidential': input.nearSupportsAsset,
    'zcash-shield': input.nativeZec && input.canReceiveNativeZec
  }
  const selected =
    input.preferred && available[input.preferred]
      ? input.preferred
      : available['zcash-shield']
        ? 'zcash-shield'
        : available['near-confidential']
          ? 'near-confidential'
          : null
  return { available, selected }
}

export function listExternalShieldReceiveAssets(
  network: Network,
  tokens: readonly SwapToken[],
  accountNetworks: readonly AccountNetworkView[]
) {
  if (network !== 'mainnet') return []
  const chains = depositSourceNetworks().filter(
    chain => !depositRefundAddressError(defaultDepositRefundAddress(chain, accountNetworks), chain)
  )
  const byChain = new Map<string, (typeof chains)[number]>(chains.map(chain => [chain.id, chain]))
  return availableDepositTokens(tokens, chains).flatMap(token => {
    const chain = byChain.get(depositTokenChainId(token) ?? '')
    if (!chain) return []
    const assetId = depositSourceAssetId(token, chain)
    return assetId ? [{ assetId, token, chain }] : []
  })
}
