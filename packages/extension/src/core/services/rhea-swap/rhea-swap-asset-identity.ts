import {
  getKnownEvmNetworkIdentities,
  getNearNetworkConfig,
  getRetiredEvmNetworkIdentities
} from '@/config/networks'
import { getEvmNativeProtocolAssetId } from '@/config/asset-market-assets'
import {
  createAssetId,
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  parseAssetId,
  parseChainId
} from '@/core/chains/registry'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import { resolveIntentsEvmChainId } from '@/core/services/intents-evm-assets'
import type { AssetId } from '@/core/chains/domain'
import type { Network } from '@/types'

const chainsByNetwork = {
  mainnet: createInitialProductChainRegistry('mainnet'),
  testnet: createInitialProductChainRegistry('testnet')
} as const
const byProtocolId = new Map(
  (['mainnet', 'testnet'] as const).map(network => {
    const assets = createAssetRegistry(
      chainsByNetwork[network],
      getBundledInitialProductAssetDefinitions(network)
    )
    return [
      network,
      new Map([
        ...getAssetProtocolSourceMappings(network, assets).map(
          mapping => [mapping.protocolAssetId, mapping.assetId] as const
        ),
        ...(network === 'mainnet'
          ? getRetiredEvmNetworkIdentities(network).flatMap(identity => {
              const protocolAssetId = getEvmNativeProtocolAssetId(identity.chainId)
              return protocolAssetId
                ? [
                    [
                      protocolAssetId,
                      `${identity.chainId}/slip44:${identity.slip44Reference}`
                    ] as const
                  ]
                : []
            })
          : [])
      ])
    ] as const
  })
)
const EVM_BRIDGED_TOKEN = /^nep141:([a-z0-9]+)-(0x[0-9a-fA-F]{40})\.(?:omft|omdep)\.near$/

export function resolveRheaSwapCanonicalAssetId(
  protocolAssetId: string,
  network: Network = 'mainnet'
): AssetId | null {
  // Wallet asset IDs have a chain/asset separator. Protocol IDs must not pay
  // for a thrown parser error for every row in a provider's token catalog.
  if (protocolAssetId.includes('/')) {
    try {
      const parsed = parseAssetId(protocolAssetId)
      return chainsByNetwork[network].get(parsed.chainId) ||
        getRetiredEvmNetworkIdentities(network).some(
          identity => identity.chainId === parsed.chainId
        )
        ? parsed.id
        : null
    } catch {
      // Continue with the provider's protocol ID mappings.
    }
  }
  const mapped = byProtocolId.get(network)?.get(protocolAssetId)
  if (mapped) return parseAssetId(mapped).id
  const token = EVM_BRIDGED_TOKEN.exec(protocolAssetId)
  if (network === 'mainnet' && token) {
    const chainId = resolveIntentsEvmChainId(token[1], getKnownEvmNetworkIdentities(network))
    if (chainId) return createAssetId(parseChainId(chainId).id, 'erc20', token[2].toLowerCase())
  }
  if (protocolAssetId.startsWith('nep141:')) {
    const contractId = protocolAssetId.slice('nep141:'.length)
    if (/\.(?:omft|omdep)\.near$/.test(contractId)) return null
    try {
      return createAssetId(
        parseChainId(getNearNetworkConfig(network).chainId).id,
        'nep141',
        contractId.replace(/_/g, '%5F')
      )
    } catch {
      return null
    }
  }
  return null
}
