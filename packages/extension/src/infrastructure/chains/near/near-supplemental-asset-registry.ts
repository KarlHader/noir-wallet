import {
  createAssetRegistry,
  type AssetDefinitionInput,
  type AssetRegistry,
  type ChainRegistry
} from '@/core/chains/registry'
import { encodeNearContractReference } from '@/core/chains/near/near-portfolio-assets'

export interface NearSupplementalAssetRegistry extends AssetRegistry {
  includeDiscovered(definitions: readonly AssetDefinitionInput[]): void
}

function definitionAssetId(definition: AssetDefinitionInput): string {
  return `${definition.chainId}/${definition.namespace}:${encodeNearContractReference(definition.reference)}`
}

export function createNearSupplementalAssetRegistry(
  base: AssetRegistry,
  chains: ChainRegistry
): NearSupplementalAssetRegistry {
  let discoveredDefinitions: AssetDefinitionInput[] = []
  let discovered = createAssetRegistry(chains, [])
  return {
    list: chainId => base.list(chainId),
    listQuarantined: chainId =>
      Object.freeze([...base.listQuarantined(chainId), ...discovered.listQuarantined(chainId)]),
    get: assetId => base.get(assetId) ?? discovered.get(assetId),
    resolve: assetId => {
      const entry = base.get(assetId) ?? discovered.get(assetId)
      return entry ?? base.resolve(assetId)
    },
    inspect: assetId => base.inspect(assetId) ?? discovered.inspect(assetId),
    includeDiscovered(definitions) {
      const seen = new Set<string>()
      const additions = definitions.filter(definition => {
        const assetId = definitionAssetId(definition)
        if (
          seen.has(assetId) ||
          base.inspect(assetId) !== undefined ||
          discovered.inspect(assetId) !== undefined
        ) {
          return false
        }
        seen.add(assetId)
        return true
      })
      if (additions.length === 0) return
      discoveredDefinitions = [...discoveredDefinitions, ...additions]
      discovered = createAssetRegistry(chains, discoveredDefinitions)
    }
  }
}
