import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  findBuiltinEvmNetworkConfig,
  getEvmNetworkConfig,
  type EvmNetworkConfig
} from '@/config/networks'
import {
  createInitialProductChainRegistry,
  parseChainId,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import {
  ChromeSessionEvmPendingTransferStore,
  createConfiguredEvmRpcClient,
  EvmTransferOrchestrator,
  loadActiveEvmPortfolioContext,
  parseEvmAccountBinding
} from '@/infrastructure/chains/evm'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import { HardwareEvmSigningContextResolver } from '@/infrastructure/keyring/hardware-evm-signing-context'
import {
  IndexedDbCredentialRepository,
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { credentialSession } from './credential-session'
import { EVM_TRANSACTION_MONITOR_ALARM } from './evm-transaction-monitor'
import { NEAR_INTENTS_TRANSACTION_MONITOR_ALARM } from './near-intents-transaction-monitor'
import { BackgroundEvmTransferController } from './evm-transfer-controller'
import { BackgroundEvmTransferRouter } from './evm-transfer-router'
import { recordRheaSwapGraphBroadcast } from './rhea-swap'
import { reportBackgroundSendBroadcast } from './analytics/send-broadcast'
import { readEvmTokenAllowance } from '@/infrastructure/chains/evm/evm-token-allowance'
import { createBackgroundEvmTransferAssetRegistry } from './evm-transfer-assets'

export { BackgroundEvmTransferController } from './evm-transfer-controller'
export { BackgroundEvmTransferRouter } from './evm-transfer-router'
export type {
  BackgroundEvmExternalSigningRequest,
  BackgroundEvmTransferControllerOptions,
  BackgroundEvmTransferReview
} from './evm-transfer-controller'
export type {
  BackgroundEvmTransferRouteController,
  BackgroundEvmTransferRouterOptions
} from './evm-transfer-router'

export interface BackgroundEvmTransferRuntime {
  readonly router: BackgroundEvmTransferRouter | null
  readonly activeController: BackgroundEvmTransferController | null
}

export function createBackgroundEvmTransferOrchestrator(
  network: EvmNetworkConfig = getEvmNetworkConfig(DEFAULT_NETWORK),
  userEvmAssets: readonly AssetDefinitionInput[] = []
): EvmTransferOrchestrator {
  const assets = createBackgroundEvmTransferAssetRegistry(network, userEvmAssets)
  const scheduleMonitor = async () => {
    const existing = await chrome.alarms.get(EVM_TRANSACTION_MONITOR_ALARM)
    await Promise.all([
      existing
        ? Promise.resolve()
        : chrome.alarms.create(EVM_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 }),
      chrome.alarms.create(NEAR_INTENTS_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
    ])
  }
  return new EvmTransferOrchestrator({
    repository: new IndexedDbTransactionRepository(),
    pendingStore: new ChromeSessionEvmPendingTransferStore(),
    signer: new EvmMultichainSigningClient({ credentials: credentialSession }),
    rpc: createConfiguredEvmRpcClient(DEFAULT_NETWORK, network),
    assets,
    networkMode: DEFAULT_NETWORK,
    onPendingBroadcast: scheduleMonitor,
    onBroadcastAccepted: (graph, recovered) => {
      if (recovered) reportBackgroundSendBroadcast(graph)
      return recordRheaSwapGraphBroadcast(graph)
    },
    onMonitoringRequired: scheduleMonitor
  })
}

export function hasBackgroundEvmTransferCapability(
  network: EvmNetworkConfig = getEvmNetworkConfig(DEFAULT_NETWORK)
): boolean {
  const additional = findBuiltinEvmNetworkConfig(DEFAULT_NETWORK, network.chainId) ? [] : [network]
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, additional)
  const chain = chains.resolve(network.chainId)
  return (
    chain.capabilities.transaction.status === 'available' &&
    chain.capabilities.transaction.actions.includes('native-transfer') &&
    chain.capabilities.transaction.actions.includes('token-transfer')
  )
}

export function createBackgroundEvmTransferController(
  network: EvmNetworkConfig = getEvmNetworkConfig(DEFAULT_NETWORK),
  userEvmAssets: readonly AssetDefinitionInput[] = []
): BackgroundEvmTransferController {
  const storageRepository = new IndexedDbStorageV2Repository()
  const externalSigner = new HardwareEvmSigningContextResolver({
    storageRepository,
    credentialRepository: new IndexedDbCredentialRepository(),
    credentials: credentialSession,
    network: DEFAULT_NETWORK
  })
  const peaSigner = new EvmMultichainSigningClient({ credentials: credentialSession })
  const allowanceRpc = createConfiguredEvmRpcClient(DEFAULT_NETWORK, network)
  return new BackgroundEvmTransferController({
    orchestrator: createBackgroundEvmTransferOrchestrator(network, userEvmAssets),
    readTokenAllowance: (token, owner, spender) =>
      readEvmTokenAllowance(allowanceRpc, token, owner, spender),
    loadActiveContext: () => loadActiveEvmPortfolioContext(storageRepository, network.chainId),
    resolveExternalSigner: chainAccount => externalSigner.resolve(chainAccount),
    resolvePrivateExecutionAccount: async context => {
      const binding = parseEvmAccountBinding(
        context.chainAccount,
        context.chainAccount.scope.chainId
      )
      const pea = await peaSigner.deriveGlobalPea(
        context.chainAccount.scope.keyDomainId,
        binding.addressIndex
      )
      return Object.freeze({
        kind: 'pea' as const,
        address: pea.address,
        addressIndex: binding.addressIndex
      })
    }
  })
}

export function createBackgroundEvmTransferRuntime(
  networks: readonly EvmNetworkConfig[],
  activeNetwork: EvmNetworkConfig,
  userEvmAssets: readonly AssetDefinitionInput[] = []
): BackgroundEvmTransferRuntime {
  const capableNetworks = networks.filter(hasBackgroundEvmTransferCapability)
  const controllers = new Map(
    capableNetworks.map(
      network =>
        [
          parseChainId(network.chainId).id,
          createBackgroundEvmTransferController(network, userEvmAssets)
        ] as const
    )
  )
  if (controllers.size !== capableNetworks.length) {
    throw new Error('Duplicate EVM transfer network')
  }
  const activeController = controllers.get(parseChainId(activeNetwork.chainId).id) ?? null
  return Object.freeze({
    router:
      controllers.size === 0
        ? null
        : new BackgroundEvmTransferRouter({
            controllers,
            pendingStore: new ChromeSessionEvmPendingTransferStore(),
            transactions: new IndexedDbTransactionRepository()
          }),
    activeController
  })
}
