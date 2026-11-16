import { getEvmNetworkConfigs } from '@/config/networks'
import { createChainRegistry, parseChainId, type ChainRegistry } from '@/core/chains/registry'

const BUILTIN_EVM_CHAIN_IDS: ReadonlySet<string> = new Set(
  (['mainnet', 'testnet'] as const).flatMap(network =>
    getEvmNetworkConfigs(network).map(config => config.chainId)
  )
)

export function createStoredEvmAssetValidationRegistry(
  chains: ChainRegistry,
  values: readonly unknown[]
): ChainRegistry {
  const archivedIds = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const chainId = (value as Record<string, unknown>).chainId
    if (typeof chainId !== 'string') continue
    const parsed = parseChainId(chainId)
    if (chains.get(parsed.id) || BUILTIN_EVM_CHAIN_IDS.has(chainId)) continue
    if (
      parsed.namespace !== 'eip155' ||
      !/^[1-9][0-9]*$/.test(parsed.reference) ||
      !Number.isSafeInteger(Number(parsed.reference))
    ) {
      continue
    }
    archivedIds.add(parsed.id)
  }
  if (archivedIds.size === 0) return chains
  const template = chains.list().find(chain => chain.family === 'evm')
  if (!template) throw new Error('Stored EVM Token catalog has no EVM validation chain')
  // Virtual entries validate dormant metadata only; they never enter the active runtime registry.
  return createChainRegistry([
    ...chains.list(),
    ...[...archivedIds].map(id => ({
      id,
      family: template.family,
      network: { kind: 'custom' as const, name: 'stored' },
      displayName: 'Stored EVM network',
      featureFlag: template.featureFlag,
      capabilities: template.capabilities
    }))
  ])
}
