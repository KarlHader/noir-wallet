import { getConfidentialFundingNetworkConfig } from '@/config/intents'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import type { EvmNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { buildAccountKey } from '@/core/wallet/account-scope'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveManagedIntentsAssets } from '@/core/services/intents-managed-assets'
import { loadActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { credentialSession } from './credential-session'
import { accountContextTransition } from './account-context-transition'
import { ConfidentialFundingApi } from './confidential-funding-api'
import {
  CONFIDENTIAL_FUNDING_MONITOR_ALARM,
  ConfidentialFundingCoordinator
} from './confidential-funding-coordinator'
import { ConfidentialFundingSigner } from './confidential-funding-signer'
import { ChromeConfidentialFundingStore } from './confidential-funding-store'

export function createBackgroundConfidentialFundingCoordinator(
  evmNetworks: readonly EvmNetworkConfig[],
  customEvmNetworks: readonly EvmNetworkConfig[],
  userEvmAssets: readonly AssetDefinitionInput[],
  protocolAssets: readonly AssetDefinitionInput[],
  protocolTokens: readonly SwapToken[],
  endpointSettings: ChainEndpointSettings,
  refreshPortfolio: () => Promise<void>,
  store: ChromeConfidentialFundingStore = new ChromeConfidentialFundingStore()
): ConfidentialFundingCoordinator | null {
  const config = getConfidentialFundingNetworkConfig(DEFAULT_NETWORK)
  if (!config) return null
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, customEvmNetworks)
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, customEvmNetworks),
    ...userEvmAssets,
    ...protocolAssets
  ])
  const storage = new IndexedDbStorageV2Repository()
  const signerClient = new EvmMultichainSigningClient({ credentials: credentialSession })
  const near = resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const mappings = new Map(
    [
      ...getAssetProtocolSourceMappings(DEFAULT_NETWORK, assets),
      ...resolveManagedIntentsAssets(protocolTokens, DEFAULT_NETWORK, evmNetworks).map(asset => ({
        assetId: asset.assetId,
        protocolAssetId: asset.protocolAssetId
      }))
    ].map(mapping => [mapping.assetId, Object.freeze(mapping)])
  )
  return new ConfidentialFundingCoordinator({
    network: DEFAULT_NETWORK,
    api: new ConfidentialFundingApi(config, near.rpcUrl, __RHEA_SWAP_ACCESS_TOKEN__),
    store,
    signer: new ConfidentialFundingSigner(
      signerClient,
      chainId => loadActiveEvmPortfolioContext(storage, chainId),
      operation => accountContextTransition.runActiveOperation(operation)
    ),
    repository: new IndexedDbTransactionRepository(),
    assets,
    evmNetworks,
    assetMappings: Object.freeze([...mappings.values()]),
    scheduleMonitoring: () =>
      chrome.alarms.create(CONFIDENTIAL_FUNDING_MONITOR_ALARM, { delayInMinutes: 0.1 }),
    onActivityChanged: async scope => {
      await chrome.runtime.sendMessage({
        type: 'TRANSACTION_UPDATED',
        accountKey: buildAccountKey(scope.network, scope.keyDomainId, scope.accountId)
      })
    },
    refreshPortfolio
  })
}

export {
  CONFIDENTIAL_FUNDING_MONITOR_ALARM,
  type PrepareConfidentialFundingInput
} from './confidential-funding-coordinator'
