import { resolveKeyDomain } from '@/core/accounts/application'
import { resolveQuantusRuntimeNetworkConfig } from '@/core/chains/quantus'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import {
  ChromeSessionQuantusPendingTransferStore,
  ChromeSessionQuantusSignedOnlyStore,
  createConfiguredQuantusRpcClient,
  QuantusTransferOrchestrator
} from '@/infrastructure/chains/quantus'
import { QuantusMultichainSigningClient } from '@/infrastructure/keyring/multichain/quantus-signing-client'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import type { StorageV2ReadRepository } from '@/ports/repositories'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { appendDiagnosticLog } from '@/lib/diagnostic-log-store'
import { credentialSession } from './credential-session'
import { QUANTUS_TRANSACTION_MONITOR_ALARM } from './quantus-transaction-monitor'
import { reportBackgroundSendBroadcast } from './analytics/send-broadcast'
import {
  BackgroundQuantusTransferController,
  type ActiveQuantusTransferContext
} from './quantus-transfer-controller'

type QuantusTransferStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export async function loadActiveQuantusTransferContext(
  repository: QuantusTransferStorageRepository,
  chainId: string
): Promise<ActiveQuantusTransferContext | null> {
  const pointer = await repository.getActivePointer()
  if (!pointer) return null
  const snapshot = await repository.getSnapshot(pointer.generationId)
  if (!snapshot) throw new Error('Active Storage V2 generation is missing')
  if (
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.generationId !== pointer.generationId ||
    snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
  ) {
    throw new Error('Active Storage V2 generation does not match its pointer')
  }
  const active = snapshot.manifest.activeAccount
  if (!active) return null
  const accounts = snapshot.accounts.filter(
    account => account.keyDomainId === active.keyDomainId && account.id === active.accountId
  )
  if (accounts.length !== 1) throw new Error('Active Account metadata is missing or ambiguous')
  const chainAccounts = snapshot.chainAccounts.filter(
    chainAccount =>
      chainAccount.scope.keyDomainId === active.keyDomainId &&
      chainAccount.scope.accountId === active.accountId &&
      chainAccount.scope.chainId === chainId
  )
  if (chainAccounts.length === 0) return null
  if (chainAccounts.length !== 1) {
    throw new Error('Active Account has ambiguous Quantus ChainAccounts')
  }
  const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
  return Object.freeze({
    chainAccount: chainAccounts[0],
    accountIndex: accounts[0].accountIndex,
    keyDomainSource: keyDomain.source
  })
}

export function createBackgroundQuantusTransferController(
  protocolAssets: readonly AssetDefinitionInput[] = [],
  endpointSettings?: ChainEndpointSettings
): BackgroundQuantusTransferController {
  const network = resolveQuantusRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const storageRepository = new IndexedDbStorageV2Repository()
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK)
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK),
    ...protocolAssets
  ])
  const rpc = createConfiguredQuantusRpcClient({
    chainId: network.chainId,
    rpcUrl: network.rpcUrl
  })
  const orchestrator = new QuantusTransferOrchestrator({
    repository: new IndexedDbTransactionRepository(),
    pendingStore: new ChromeSessionQuantusPendingTransferStore(),
    signedOnlyStore: new ChromeSessionQuantusSignedOnlyStore(),
    signer: new QuantusMultichainSigningClient({ credentials: credentialSession }),
    rpc,
    assets,
    onPendingBroadcast: () =>
      chrome.alarms.create(QUANTUS_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 }),
    onBroadcastAttempt: (result, rpcCode) => {
      void appendDiagnosticLog({
        source: 'background',
        level: result === 'accepted' || result === 'pool-match' ? 'info' : 'warn',
        message: `Quantus broadcast ${result}${rpcCode ? ` (${rpcCode})` : ''}`,
        timestamp: Date.now(),
        sequence: 0
      }).catch(() => {})
    },
    onMonitoringRequired: (graph, recovered) => {
      if (recovered) reportBackgroundSendBroadcast(graph)
      return chrome.alarms.create(QUANTUS_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
    }
  })
  return new BackgroundQuantusTransferController({
    orchestrator,
    loadActiveContext: () => loadActiveQuantusTransferContext(storageRepository, network.chainId)
  })
}

export { BackgroundQuantusTransferController } from './quantus-transfer-controller'
export type {
  ActiveQuantusTransferContext,
  BackgroundQuantusTransferControllerOptions,
  BackgroundQuantusTransferReview
} from './quantus-transfer-controller'
export { BackgroundQuantusTransactionMonitor } from './quantus-transaction-monitor'
export type { BackgroundQuantusTransactionMonitorController } from './quantus-transaction-monitor'
