import { resolveKeyDomain } from '@/core/accounts/application'
import { nearPublicKeyFromImplicitAccountId } from '@/core/chains/near'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import {
  ChromeSessionNearPendingTransferStore,
  createConfiguredNearRpcClient,
  NearTransferOrchestrator
} from '@/infrastructure/chains/near'
import { NearMultichainSigningClient } from '@/infrastructure/keyring/multichain/near-signing-client'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import type { StorageV2ReadRepository } from '@/ports/repositories'

import { credentialSession } from './credential-session'
import { nearLedgerSigningBridge } from './ledger-signing-bridge'
import { NEAR_TRANSACTION_MONITOR_ALARM } from './near-transaction-monitor'
import { reportBackgroundSendBroadcast } from './analytics/send-broadcast'
import {
  isSelectedTransferScope,
  requireSelectedTransferNetwork
} from './transfer-account-network-selection'
import {
  BackgroundNearTransferController,
  type ActiveNearTransferContext
} from './near-transfer-controller'

type NearTransferStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export async function loadActiveNearTransferContext(
  repository: NearTransferStorageRepository,
  chainId: string
): Promise<ActiveNearTransferContext | null> {
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
  if (chainAccounts.length !== 1) throw new Error('Active Account has ambiguous NEAR ChainAccounts')
  const implicitAddress = snapshot.addresses.find(
    address =>
      address.chainAccountId === chainAccounts[0].id &&
      address.scheme === 'near' &&
      /^[0-9a-f]{64}$/.test(address.value)
  )?.value
  if (!implicitAddress) throw new Error('Active NEAR Account has no derived implicit address')
  const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
  return Object.freeze({
    chainAccount: chainAccounts[0],
    accountIndex: accounts[0].accountIndex,
    keyDomainSource: keyDomain.source,
    publicKey: nearPublicKeyFromImplicitAccountId(implicitAddress)
  })
}

export function createBackgroundNearTransferController(
  protocolAssets: readonly AssetDefinitionInput[] = [],
  endpointSettings?: ChainEndpointSettings
): BackgroundNearTransferController {
  const network = resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const storageRepository = new IndexedDbStorageV2Repository()
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK)
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK),
    ...protocolAssets
  ])
  const orchestrator = new NearTransferOrchestrator({
    repository: new IndexedDbTransactionRepository(),
    pendingStore: new ChromeSessionNearPendingTransferStore(),
    signer: new NearMultichainSigningClient({
      credentials: credentialSession,
      ledger: nearLedgerSigningBridge
    }),
    rpc: createConfiguredNearRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl }),
    assets,
    canBroadcastSigned: scope => isSelectedTransferScope(storageRepository, scope, 'near'),
    onPendingBroadcast: () =>
      chrome.alarms.create(NEAR_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 }),
    onMonitoringRequired: (graph, recovered) => {
      if (recovered || graph.root.intent?.protocol?.provider === 'rhea-cross-chain-dex')
        reportBackgroundSendBroadcast(graph)
      return chrome.alarms.create(NEAR_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
    }
  })
  return new BackgroundNearTransferController({
    orchestrator,
    loadActiveContext: async () =>
      requireSelectedTransferNetwork(
        await loadActiveNearTransferContext(storageRepository, network.chainId),
        'near'
      )
  })
}

export { BackgroundNearTransferController } from './near-transfer-controller'
export type {
  ActiveNearTransferContext,
  BackgroundNearTransferControllerOptions,
  BackgroundNearTransferReview
} from './near-transfer-controller'
