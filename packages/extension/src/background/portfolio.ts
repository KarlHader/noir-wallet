import type { EvmNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  resolveNearRuntimeNetworkConfig,
  resolveSolanaRuntimeNetworkConfig
} from '@/core/chains/solana-near-runtime-config'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  createAssetRegistry,
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions,
  parseChainId,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import { createConfiguredEvmRpcClient, EvmPortfolioCoordinator } from '@/infrastructure/chains/evm'
import {
  createFastNearAccountTokenClient,
  createConfiguredNearRpcClient,
  readNearPortfolioSource
} from '@/infrastructure/chains/near'
import {
  createConfiguredSolanaRpcClient,
  readSolanaPortfolioSource
} from '@/infrastructure/chains/solana'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm/evm-account'
import {
  SingleChainPortfolioCoordinator,
  UnifiedPortfolioCoordinator
} from '@/infrastructure/portfolio'
import {
  IndexedDbPortfolioCacheRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'
import { formatLogError } from '@/lib/log-format'
import { logger } from '@/lib/logger'
import { useAccountDataStore } from '@/store/account-data-store'
import { useWalletStore } from '@/store/wallet-store'
import { createBackgroundBitcoinPortfolioCoordinator } from './bitcoin-transfer'
import { credentialSession } from './credential-session'
import { isStoredAccountNetworkEnabled } from '@/lib/wallet-metadata-storage'

export function createBackgroundPortfolioCoordinator(
  evmNetworks: readonly EvmNetworkConfig[],
  customEvmNetworks: readonly EvmNetworkConfig[] = [],
  userEvmAssets: readonly AssetDefinitionInput[] = [],
  protocolAssets: readonly AssetDefinitionInput[] = [],
  endpointSettings?: ChainEndpointSettings
): UnifiedPortfolioCoordinator {
  const storageRepository = new IndexedDbStorageV2Repository()
  const cacheRepository = new IndexedDbPortfolioCacheRepository()
  const chains = createBuildAddressGatedChainRegistry(
    createInitialProductChainRegistry(DEFAULT_NETWORK, customEvmNetworks)
  )
  const assets = createAssetRegistry(
    chains,
    filterAssetDefinitionsForChains(
      [
        ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, customEvmNetworks),
        ...userEvmAssets,
        ...protocolAssets
      ],
      chains
    )
  )
  const peaSigner = new EvmMultichainSigningClient({ credentials: credentialSession })
  const isNetworkEnabled = (
    scope: { readonly keyDomainId: string; readonly accountId: string },
    family: Parameters<typeof isStoredAccountNetworkEnabled>[3],
    chainId: string
  ) =>
    isStoredAccountNetworkEnabled(
      scope.keyDomainId,
      scope.accountId,
      DEFAULT_NETWORK,
      family,
      chainId
    )
  const evmPortfolios = evmNetworks.flatMap(evmNetwork => {
    const chainId = parseChainId(evmNetwork.chainId).id
    if (!chains.get(chainId)) return []
    return [
      Object.freeze({
        chainId,
        portfolio: new EvmPortfolioCoordinator({
          storageRepository,
          cacheRepository,
          chainId,
          chains,
          assets,
          rpc: createConfiguredEvmRpcClient(DEFAULT_NETWORK, evmNetwork),
          resolvePrivateExecutionAddress: async context => {
            if (!credentialSession.hasUnlockSession()) return null
            const binding = parseEvmAccountBinding(context.chainAccount, chainId)
            return (
              await peaSigner.deriveGlobalPea(
                context.chainAccount.scope.keyDomainId,
                binding.addressIndex
              )
            ).address
          }
        })
      })
    ]
  })
  const bitcoinPortfolio = chains.list().some(chain => chain.family === 'bitcoin')
    ? createBackgroundBitcoinPortfolioCoordinator()
    : undefined
  const solanaNetwork = resolveSolanaRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const solanaRpc = createConfiguredSolanaRpcClient({
    chainId: solanaNetwork.chainId,
    rpcUrl: solanaNetwork.rpcUrl
  })
  const solanaPortfolio = chains.get(parseChainId(solanaNetwork.chainId).id)
    ? new SingleChainPortfolioCoordinator({
        storageRepository,
        cacheRepository,
        chains,
        assets,
        chainId: solanaNetwork.chainId,
        family: 'solana',
        isNetworkEnabled,
        readSource: input => readSolanaPortfolioSource({ ...input, rpc: solanaRpc })
      })
    : undefined
  const nearNetwork = resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const nearRpc = createConfiguredNearRpcClient({
    chainId: nearNetwork.chainId,
    rpcUrl: nearNetwork.rpcUrl
  })
  const nearTokenInventory = createFastNearAccountTokenClient({ chainId: nearNetwork.chainId })
  const nearPortfolio = chains.get(parseChainId(nearNetwork.chainId).id)
    ? new SingleChainPortfolioCoordinator({
        storageRepository,
        cacheRepository,
        chains,
        assets,
        chainId: nearNetwork.chainId,
        family: 'near',
        isNetworkEnabled,
        readSource: input =>
          readNearPortfolioSource({ ...input, rpc: nearRpc, tokenInventory: nearTokenInventory })
      })
    : undefined

  return new UnifiedPortfolioCoordinator({
    storageRepository,
    chains,
    assets,
    isNetworkEnabled,
    evmPortfolios,
    bitcoinPortfolio,
    solanaPortfolio,
    nearPortfolio,
    onBackgroundBitcoinRefreshError: error => {
      const { currentWalletId, currentAccountId } = useWalletStore.getState()
      logger.warn(
        `Bitcoin portfolio refresh failed: ${formatLogError(error)}`,
        currentWalletId ?? undefined,
        currentAccountId ?? undefined
      )
    },
    onBackgroundBitcoinRefreshSettled: source => {
      if (!source) return
      void chrome.runtime
        .sendMessage({
          type: 'PORTFOLIO_UPDATED',
          walletId: source.chainAccount.scope.keyDomainId,
          accountId: source.chainAccount.scope.accountId
        })
        .catch(() => {})
    },
    readZcashState: scope => {
      const wallet = useWalletStore.getState()
      if (
        wallet.currentWalletId !== scope.keyDomainId ||
        wallet.currentAccountId !== scope.accountId ||
        wallet.currentNetwork !== DEFAULT_NETWORK
      ) {
        return { balance: null, status: 'loading', updatedAt: 0 }
      }
      const accountData = useAccountDataStore.getState()
      const balance = accountData.getBalance(DEFAULT_NETWORK, scope.keyDomainId, scope.accountId)
      const sync = accountData.getWalletSyncState(DEFAULT_NETWORK, scope.keyDomainId)
      const updatedAt = sync.lastSyncTime ?? 0
      if (sync.syncReason === 'network_error') {
        return { balance, status: 'error', errorCode: 'network-unavailable', updatedAt }
      }
      if (sync.syncReason === 'sync_stall') {
        return { balance, status: 'error', errorCode: 'unknown', updatedAt }
      }
      if (sync.isSyncing || sync.lastSyncTime === null || balance === null) {
        return { balance, status: 'loading', updatedAt }
      }
      return { balance, status: 'ready', updatedAt }
    }
  })
}
