import { resolveKeyDomain } from '@/core/accounts/application'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveSolanaRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import {
  ChromeSessionSolanaPendingTransferStore,
  createConfiguredSolanaRpcClient,
  SolanaTransferOrchestrator
} from '@/infrastructure/chains/solana'
import { SolanaMultichainSigningClient } from '@/infrastructure/keyring/multichain/solana-signing-client'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import type { StorageV2ReadRepository } from '@/ports/repositories'
import { credentialSession } from './credential-session'
import { solanaLedgerSigningBridge } from './ledger-signing-bridge'
import { SOLANA_TRANSACTION_MONITOR_ALARM } from './solana-transaction-monitor'
import { reportBackgroundSendBroadcast } from './analytics/send-broadcast'
import {
  isSelectedTransferScope,
  requireSelectedTransferNetwork
} from './transfer-account-network-selection'
import {
  BackgroundSolanaTransferController,
  type ActiveSolanaTransferContext
} from './solana-transfer-controller'

type SolanaTransferStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export async function loadActiveSolanaTransferContext(
  repository: SolanaTransferStorageRepository,
  chainId: string
): Promise<ActiveSolanaTransferContext | null> {
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
  if (chainAccounts.length !== 1)
    throw new Error('Active Account has ambiguous Solana ChainAccounts')
  const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
  return Object.freeze({
    chainAccount: chainAccounts[0],
    accountIndex: accounts[0].accountIndex,
    keyDomainSource: keyDomain.source
  })
}

export function createBackgroundSolanaTransferController(
  protocolAssets: readonly AssetDefinitionInput[] = [],
  endpointSettings?: ChainEndpointSettings
): BackgroundSolanaTransferController {
  const network = resolveSolanaRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const storageRepository = new IndexedDbStorageV2Repository()
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK)
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK),
    ...protocolAssets
  ])
  const orchestrator = new SolanaTransferOrchestrator({
    repository: new IndexedDbTransactionRepository(),
    pendingStore: new ChromeSessionSolanaPendingTransferStore(),
    signer: new SolanaMultichainSigningClient({
      credentials: credentialSession,
      ledger: solanaLedgerSigningBridge
    }),
    rpc: createConfiguredSolanaRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl }),
    assets,
    canBroadcastSigned: scope => isSelectedTransferScope(storageRepository, scope, 'solana'),
    onPendingBroadcast: () =>
      chrome.alarms.create(SOLANA_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 }),
    onMonitoringRequired: (graph, recovered) => {
      if (recovered || graph.root.intent?.protocol?.provider === 'rhea-cross-chain-dex')
        reportBackgroundSendBroadcast(graph)
      return chrome.alarms.create(SOLANA_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
    }
  })
  return new BackgroundSolanaTransferController({
    orchestrator,
    loadActiveContext: async () =>
      requireSelectedTransferNetwork(
        await loadActiveSolanaTransferContext(storageRepository, network.chainId),
        'solana'
      )
  })
}

export { BackgroundSolanaTransferController } from './solana-transfer-controller'
export type {
  ActiveSolanaTransferContext,
  BackgroundSolanaTransferControllerOptions,
  BackgroundSolanaTransferReview
} from './solana-transfer-controller'
