import type { ChainDefinition } from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import type { Network } from '@/types'
import {
  availableDepositTokens,
  depositSourceNetworks,
  depositTokenChainId
} from './shield-deposit-options'

export function nearConfidentialVaultSupport(directoryTokens: readonly SwapToken[] | null) {
  if (!directoryTokens) return { networks: [], tokens: null }

  const publicNetworks = depositSourceNetworks()
  const tokens = availableDepositTokens(directoryTokens, publicNetworks)
  const supportedChainIds = new Set(tokens.map(depositTokenChainId))
  return {
    networks: publicNetworks.filter(chain => supportedChainIds.has(chain.id)),
    tokens
  }
}

export function shieldVaultChainIcons(networks: readonly ChainDefinition[]) {
  return networks.map(chain => ({
    key: chain.id,
    label: chain.displayName,
    iconChain: resolveChainIconAlias(chain.family, chain.displayName, chain.id)
  }))
}

const IRONWOOD_ACTIVATION_HEIGHT: Readonly<Record<Network, number>> = {
  mainnet: 3_428_143,
  testnet: 4_134_000
}

export function isIronwoodActiveAtHeight(network: Network, height: number): boolean {
  return Number.isSafeInteger(height) && height >= IRONWOOD_ACTIVATION_HEIGHT[network]
}
