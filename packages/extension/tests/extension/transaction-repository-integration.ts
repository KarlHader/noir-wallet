import { parseAccountId } from '@/core/accounts/domain'
import { buildAccountKey } from '@/core/wallet/account-scope'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  parseTransactionEventId,
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionGraph,
  type TransactionLifecycleStatus
} from '@/core/transactions/domain'
import {
  deleteIndexedDbPortfolioCache,
  deleteIndexedDbTransactionPersistence,
  deleteStorageV2Persistence,
  IndexedDbPortfolioCacheRepository,
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import {
  parseStorageV2GenerationId,
  parseStorageV2Snapshot,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import type { ApplyTransactionSegmentEventInput } from '@/ports/repositories'
import { deleteTransactions, mutateTransactions } from '@/lib/indexed-db'

const zcashChainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const ethereumChainId = 'eip155:1'
const bitcoinChainId = 'bip122:000000000019d6689c085ae165831e93'

function scope(accountId = 'account:1') {
  return {
    keyDomainId: parseKeyDomainId('key-domain:1'),
    accountId: parseAccountId(accountId)
  }
}

function graph(
  transactionId: string,
  accountId = 'account:1',
  chainId = zcashChainId,
  kind = 'transfer',
  transactionHash = `hash:${transactionId}`,
  status: 'signed' | 'broadcast' = 'signed'
): TransactionGraph {
  const segmentId = `segment:${transactionId}`
  return parseTransactionGraph({
    root: {
      id: transactionId,
      scope: scope(accountId),
      kind,
      status,
      segmentIds: [segmentId],
      createdAt: 1_000,
      updatedAt: 1_000,
      revision: 0
    },
    segments: [
      {
        id: segmentId,
        transactionId,
        role: 'origin',
        target: { kind: 'onchain', chainId },
        status,
        requiredForFinality: true,
        dependsOn: [],
        evidence: { transactionHash },
        createdAt: 1_000,
        updatedAt: 1_000,
        revision: 0
      }
    ]
  })
}

function mutation(
  transactionId: string,
  eventId: string,
  status: TransactionLifecycleStatus,
  observedAt: number
): ApplyTransactionSegmentEventInput {
  return {
    scope: scope(),
    transactionId: parseTransactionId(transactionId),
    segmentId: parseTransactionSegmentId(`segment:${transactionId}`),
    event: {
      id: parseTransactionEventId(eventId),
      status,
      cause: 'progress',
      observedAt,
      evidence: { transactionHash: `hash:${transactionId}` }
    },
    expectedRootRevision: 0,
    expectedSegmentRevision: 0
  }
}

function repository(databaseName: string): IndexedDbTransactionRepository {
  return new IndexedDbTransactionRepository({ databaseName })
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onerror = () => reject(request.error ?? new Error('Test database deletion failed'))
    request.onblocked = () => reject(new Error('Test database deletion blocked'))
    request.onsuccess = () => resolve()
  })
}

async function initialize(databaseName: string) {
  await deleteDatabase(databaseName)
  const first = repository(databaseName)
  const created = await first.create(graph('transaction:main'))
  const duplicate = await first.create(graph('transaction:main'))
  const conflict = await first.create(
    graph('transaction:main', 'account:1', zcashChainId, 'receive')
  )
  await first.create(graph('transaction:eth', 'account:1', ethereumChainId))
  await first.create(graph('transaction:other', 'account:2', ethereumChainId))
  const broadcastInput = mutation('transaction:main', 'event:broadcast', 'broadcast', 1_100)
  const broadcast = await first.applySegmentEvent(broadcastInput)
  const duplicateEvent = await first.applySegmentEvent(broadcastInput)
  const conflictingEvent = await first.applySegmentEvent({
    ...broadcastInput,
    event: { ...broadcastInput.event, status: 'confirming', observedAt: 1_200 }
  })
  const stale = await first.applySegmentEvent({
    ...mutation('transaction:main', 'event:stale', 'broadcast', 1_050),
    expectedRootRevision: 1,
    expectedSegmentRevision: 1
  })

  const raceId = 'transaction:race'
  await first.create(graph(raceId))
  const race = await Promise.all([
    repository(databaseName).applySegmentEvent(
      mutation(raceId, 'event:race:a', 'broadcast', 1_100)
    ),
    repository(databaseName).applySegmentEvent(
      mutation(raceId, 'event:race:b', 'confirming', 1_200)
    )
  ])

  return {
    createStatuses: [created.status, duplicate.status, conflict.status],
    eventStatuses: [broadcast.status, duplicateEvent.status, conflictingEvent.status, stale.status],
    raceStatuses: race.map(result => result.status).sort()
  }
}

async function inspect(databaseName: string) {
  const current = repository(databaseName)
  const all = await current.list({ scope: scope() })
  const ethereum = await current.list({ scope: scope(), chainId: ethereumChainId })
  const broadcast = await current.list({ scope: scope(), statuses: ['broadcast'] })
  return {
    all: all.map(item => item.root.id).sort(),
    ethereum: ethereum.map(item => item.root.id),
    broadcastMainIncluded: broadcast.some(item => item.root.id === 'transaction:main'),
    mainStatus: (await current.get(scope(), parseTransactionId('transaction:main')))?.root.status,
    crossAccountVisible: Boolean(
      await current.get(scope('account:2'), parseTransactionId('transaction:main'))
    ),
    hasBroadcastEvent: await current.hasAppliedEvent(
      scope(),
      parseTransactionId('transaction:main'),
      parseTransactionEventId('event:broadcast')
    )
  }
}

async function deleteAccount(databaseName: string) {
  const current = repository(databaseName)
  const deleted = await current.deleteByAccountScope(scope())
  return {
    deleted,
    accountOne: (await current.list({ scope: scope() })).length,
    accountTwo: (await current.list({ scope: scope('account:2') })).length
  }
}

async function initializeProductionEvmMonitor(transactionHash: string) {
  await Promise.all([deleteIndexedDbTransactionPersistence(), deleteStorageV2Persistence()])
  const storageRepository = new IndexedDbStorageV2Repository()
  const generationId = parseStorageV2GenerationId('metadata:evm-monitor:production-e2e')
  const sourceFingerprint = parseStorageV2SourceFingerprint('d'.repeat(64))
  const monitorChainAccount = {
    id: 'chain-account:evm-monitor:production-e2e',
    scope: {
      keyDomainId: 'key-domain:1',
      accountId: 'account:1',
      chainId: ethereumChainId
    },
    derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
    identity: {
      kind: 'account-identifier' as const,
      value: '0x1111111111111111111111111111111111111111'
    },
    createdAt: 1_000
  }
  const snapshot = parseStorageV2Snapshot({
    manifest: {
      schemaVersion: 2,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: monitorChainAccount.scope.keyDomainId,
      activeAccount: {
        keyDomainId: monitorChainAccount.scope.keyDomainId,
        accountId: monitorChainAccount.scope.accountId
      },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 1, addresses: 1 },
      createdAt: 1_000,
      verifiedAt: 1_001
    },
    keyDomains: [
      {
        id: monitorChainAccount.scope.keyDomainId,
        credentialRef: 'credential-set:evm-monitor:production-e2e',
        source: { kind: 'software', mnemonicWordCount: 12 },
        displayName: 'Wallet 1',
        createdAt: 1_000
      }
    ],
    accounts: [
      {
        id: monitorChainAccount.scope.accountId,
        keyDomainId: monitorChainAccount.scope.keyDomainId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1_000
      }
    ],
    chainAccounts: [monitorChainAccount],
    addresses: [
      {
        id: 'address:evm-monitor:production-e2e',
        chainAccountId: monitorChainAccount.id,
        value: monitorChainAccount.identity.value,
        scheme: 'evm',
        purpose: 'identity',
        derivation: monitorChainAccount.derivation,
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    ]
  })
  await storageRepository.stage(snapshot)
  await storageRepository.commit(
    {
      schemaVersion: 2,
      generationId,
      sourceFingerprint,
      committedAt: 1_002
    },
    null
  )
  return (
    await new IndexedDbTransactionRepository().create(
      graph(
        'transaction:evm:background',
        'account:1',
        ethereumChainId,
        'transfer',
        transactionHash,
        'broadcast'
      )
    )
  ).status
}

async function resetProductionEvmMonitor() {
  await Promise.all([deleteIndexedDbTransactionPersistence(), deleteStorageV2Persistence()])
}

async function inspectProductionEvmMonitor() {
  const graph = await new IndexedDbTransactionRepository().get(
    scope(),
    parseTransactionId('transaction:evm:background')
  )
  return graph
    ? {
        rootStatus: graph.root.status,
        segmentStatus: graph.segments[0]?.status,
        blockHash: graph.segments[0]?.evidence?.blockHash,
        blockHeight: graph.segments[0]?.evidence?.blockHeight
      }
    : null
}

const portfolioChainAccount = {
  id: 'chain-account:portfolio:evm',
  scope: {
    keyDomainId: 'key-domain:portfolio',
    accountId: 'account:portfolio',
    chainId: ethereumChainId
  },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
  identity: {
    kind: 'account-identifier' as const,
    value: '0x1111111111111111111111111111111111111111'
  },
  createdAt: 1_000
}

function portfolioSource(totalRaw: string, status: 'ready' | 'error' = 'ready') {
  return {
    chainAccount: portfolioChainAccount,
    status,
    balances: [
      {
        assetId: 'eip155:1/slip44:60',
        totalRaw,
        spendableRaw: totalRaw,
        availableRaw: totalRaw,
        pendingRaw: '0',
        updatedAt: 2_000
      }
    ],
    ...(status === 'error' ? { errorCode: 'rate-limited' as const } : {})
  }
}

async function initializePortfolioCache(databaseName: string) {
  await deleteDatabase(databaseName)
  const repository = new IndexedDbPortfolioCacheRepository({ databaseName })
  const generationId = parseStorageV2GenerationId('metadata:portfolio:generation:1')
  await repository.put({ generationId, cachedAt: 2_000, source: portfolioSource('1') })
  await repository.put({ generationId, cachedAt: 2_100, source: portfolioSource('2', 'error') })
  return repository.get(generationId, portfolioChainAccount.id)
}

async function inspectPortfolioCache(databaseName: string) {
  const repository = new IndexedDbPortfolioCacheRepository({ databaseName })
  const generationId = parseStorageV2GenerationId('metadata:portfolio:generation:1')
  const scope = {
    keyDomainId: parseKeyDomainId(portfolioChainAccount.scope.keyDomainId),
    accountId: parseAccountId(portfolioChainAccount.scope.accountId)
  }
  const records = await repository.list(generationId, scope)
  const deleted = await repository.deleteByAccountScope(scope)
  return {
    records: records.map(record => ({
      cachedAt: record.cachedAt,
      status: record.source.status,
      totalRaw: record.source.balances[0]?.totalRaw,
      errorCode: record.source.errorCode
    })),
    deleted,
    remaining: (await repository.list(generationId, scope)).length
  }
}

const productionPortfolioGenerationId = parseStorageV2GenerationId(
  'metadata:portfolio:production-e2e'
)
const productionPortfolioFingerprint = parseStorageV2SourceFingerprint('c'.repeat(64))

async function initializeProductionEvmPortfolio() {
  await Promise.all([deleteStorageV2Persistence(), deleteIndexedDbPortfolioCache()])
  const repository = new IndexedDbStorageV2Repository()
  const snapshot = parseStorageV2Snapshot({
    manifest: {
      schemaVersion: 2,
      generationId: productionPortfolioGenerationId,
      status: 'verified',
      sourceFingerprint: productionPortfolioFingerprint,
      mainKeyDomainId: portfolioChainAccount.scope.keyDomainId,
      activeAccount: {
        keyDomainId: portfolioChainAccount.scope.keyDomainId,
        accountId: portfolioChainAccount.scope.accountId
      },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 1, addresses: 1 },
      createdAt: 1_000,
      verifiedAt: 1_001
    },
    keyDomains: [
      {
        id: portfolioChainAccount.scope.keyDomainId,
        credentialRef: 'credential-set:portfolio:production-e2e',
        source: { kind: 'software', mnemonicWordCount: 12 },
        displayName: 'Wallet 1',
        createdAt: 1_000
      }
    ],
    accounts: [
      {
        id: portfolioChainAccount.scope.accountId,
        keyDomainId: portfolioChainAccount.scope.keyDomainId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1_000
      }
    ],
    chainAccounts: [portfolioChainAccount],
    addresses: [
      {
        id: 'address:portfolio:production-e2e',
        chainAccountId: portfolioChainAccount.id,
        value: portfolioChainAccount.identity.value,
        scheme: 'evm',
        purpose: 'identity',
        derivation: portfolioChainAccount.derivation,
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    ]
  })
  await repository.stage(snapshot)
  return repository.commit(
    {
      schemaVersion: 2,
      generationId: productionPortfolioGenerationId,
      sourceFingerprint: productionPortfolioFingerprint,
      committedAt: 1_002
    },
    null
  )
}

async function inspectProductionEvmPortfolioCache() {
  const record = await new IndexedDbPortfolioCacheRepository().get(
    productionPortfolioGenerationId,
    portfolioChainAccount.id
  )
  return record
    ? {
        generationId: record.generationId,
        status: record.source.status,
        balances: record.source.balances.map(balance => ({
          assetId: balance.assetId,
          totalRaw: balance.totalRaw
        }))
      }
    : null
}

async function resetProductionEvmPortfolio() {
  await Promise.all([deleteStorageV2Persistence(), deleteIndexedDbPortfolioCache()])
}

const productionActivityAccountKey = buildAccountKey(
  'mainnet',
  portfolioChainAccount.scope.keyDomainId,
  portfolioChainAccount.scope.accountId
)

async function initializeProductionActivity() {
  await Promise.all([
    initializeProductionEvmPortfolio(),
    deleteIndexedDbTransactionPersistence(),
    deleteTransactions(productionActivityAccountKey)
  ])
  const transactionId = parseTransactionId('transaction:activity:production-e2e')
  const segmentId = parseTransactionSegmentId('segment:activity:production-e2e')
  await new IndexedDbTransactionRepository().create(
    parseTransactionGraph({
      root: {
        id: transactionId,
        scope: {
          keyDomainId: portfolioChainAccount.scope.keyDomainId,
          accountId: portfolioChainAccount.scope.accountId
        },
        kind: 'transfer',
        status: 'signed',
        segmentIds: [segmentId],
        intent: {
          schemaVersion: 1,
          direction: 'outgoing',
          primaryAmount: {
            assetId: 'eip155:1/slip44:60',
            amountRaw: '1000000000000000000'
          },
          sender: {
            chainId: ethereumChainId,
            address: portfolioChainAccount.identity.value
          },
          recipient: {
            chainId: ethereumChainId,
            address: '0x2222222222222222222222222222222222222222'
          }
        },
        createdAt: 1_100,
        updatedAt: 1_100,
        revision: 0
      },
      segments: [
        {
          id: segmentId,
          transactionId,
          role: 'origin',
          target: {
            kind: 'onchain',
            chainId: ethereumChainId,
            chainAccountId: portfolioChainAccount.id
          },
          status: 'signed',
          requiredForFinality: true,
          dependsOn: [],
          evidence: { transactionHash: `0x${'3'.repeat(64)}` },
          createdAt: 1_100,
          updatedAt: 1_100,
          revision: 0
        }
      ]
    })
  )
  await mutateTransactions(productionActivityAccountKey, () => [
    {
      id: 'zcash-v1:activity:production-e2e',
      txHash: 'abc123',
      status: 'success',
      type: 'receive',
      amount: '0.5',
      to: 'u1activityrecipient',
      from: '',
      fromType: 'shielded',
      fee: '0',
      timestamp: 1_200,
      network: 'mainnet'
    }
  ])
}

async function resetProductionActivity() {
  await Promise.all([
    deleteStorageV2Persistence(),
    deleteIndexedDbPortfolioCache(),
    deleteIndexedDbTransactionPersistence(),
    deleteTransactions(productionActivityAccountKey)
  ])
}

const resyncIsolationTransactionIds = Object.freeze([
  'transaction:resync-isolation:evm',
  'transaction:resync-isolation:bitcoin'
])

async function loadResyncIsolationProbeContext() {
  const storageRepository = new IndexedDbStorageV2Repository()
  const pointer = await storageRepository.getActivePointer()
  if (!pointer) throw new Error('Resync isolation probe requires an active Storage V2 generation')
  const snapshot = await storageRepository.getSnapshot(pointer.generationId)
  if (!snapshot?.manifest.activeAccount) {
    throw new Error('Resync isolation probe requires an active Account')
  }
  const active = snapshot.manifest.activeAccount
  const sibling = snapshot.accounts.find(
    account => account.keyDomainId === active.keyDomainId && account.id !== active.accountId
  )
  if (!sibling) throw new Error('Resync isolation probe requires a sibling Account')
  const chainAccounts = snapshot.chainAccounts.filter(
    chainAccount =>
      chainAccount.scope.keyDomainId === sibling.keyDomainId &&
      chainAccount.scope.accountId === sibling.id
  )
  const evm = chainAccounts.find(chainAccount => chainAccount.scope.chainId === ethereumChainId)
  const bitcoin = chainAccounts.find(chainAccount => chainAccount.scope.chainId === bitcoinChainId)
  if (!evm || !bitcoin) {
    throw new Error('Resync isolation probe requires released EVM and Bitcoin ChainAccounts')
  }
  return {
    generationId: pointer.generationId,
    scope: { keyDomainId: sibling.keyDomainId, accountId: sibling.id },
    chainAccounts: [evm, bitcoin] as const
  }
}

async function inspectResyncIsolationProbe() {
  const context = await loadResyncIsolationProbeContext()
  const portfolio = await new IndexedDbPortfolioCacheRepository().list(
    context.generationId,
    context.scope
  )
  const activity = await new IndexedDbTransactionRepository().list({ scope: context.scope })
  return {
    generationId: context.generationId,
    scope: context.scope,
    portfolio: portfolio
      .filter(record =>
        context.chainAccounts.some(
          chainAccount => chainAccount.id === record.source.chainAccount.id
        )
      )
      .map(record => ({
        chainAccountId: record.source.chainAccount.id,
        chainId: record.source.chainAccount.scope.chainId,
        cachedAt: record.cachedAt
      }))
      .sort((left, right) => left.chainId.localeCompare(right.chainId)),
    activity: activity
      .filter(graph => resyncIsolationTransactionIds.includes(graph.root.id))
      .map(graph => ({ id: graph.root.id, status: graph.root.status }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }
}

async function initializeResyncIsolationProbe() {
  const context = await loadResyncIsolationProbeContext()
  const portfolioRepository = new IndexedDbPortfolioCacheRepository()
  const transactionRepository = new IndexedDbTransactionRepository()

  for (const chainAccount of context.chainAccounts) {
    await portfolioRepository.put({
      generationId: context.generationId,
      cachedAt: 1_234,
      source: { chainAccount, status: 'ready', balances: [] }
    })
  }

  for (const [index, chainAccount] of context.chainAccounts.entries()) {
    const transactionId = resyncIsolationTransactionIds[index]
    const segmentId = `segment:resync-isolation:${index}`
    const result = await transactionRepository.create(
      parseTransactionGraph({
        root: {
          id: transactionId,
          scope: context.scope,
          kind: 'transfer',
          status: 'signed',
          segmentIds: [segmentId],
          createdAt: 1_234,
          updatedAt: 1_234,
          revision: 0
        },
        segments: [
          {
            id: segmentId,
            transactionId,
            role: 'origin',
            target: {
              kind: 'onchain',
              chainId: chainAccount.scope.chainId,
              chainAccountId: chainAccount.id
            },
            status: 'signed',
            requiredForFinality: true,
            dependsOn: [],
            evidence: { transactionHash: `${index + 1}`.repeat(64) },
            createdAt: 1_234,
            updatedAt: 1_234,
            revision: 0
          }
        ]
      })
    )
    if (result.status !== 'created') {
      throw new Error(`Unable to create ${transactionId} resync isolation probe`)
    }
  }

  return inspectResyncIsolationProbe()
}

export interface TransactionRepositoryIntegration {
  readonly reset: (databaseName: string) => Promise<void>
  readonly initialize: (databaseName: string) => ReturnType<typeof initialize>
  readonly inspect: (databaseName: string) => ReturnType<typeof inspect>
  readonly deleteAccount: (databaseName: string) => ReturnType<typeof deleteAccount>
  readonly initializeProductionEvmMonitor: typeof initializeProductionEvmMonitor
  readonly inspectProductionEvmMonitor: typeof inspectProductionEvmMonitor
  readonly resetProductionEvmMonitor: typeof resetProductionEvmMonitor
  readonly initializePortfolioCache: typeof initializePortfolioCache
  readonly inspectPortfolioCache: typeof inspectPortfolioCache
  readonly initializeProductionEvmPortfolio: typeof initializeProductionEvmPortfolio
  readonly inspectProductionEvmPortfolioCache: typeof inspectProductionEvmPortfolioCache
  readonly resetProductionEvmPortfolio: typeof resetProductionEvmPortfolio
  readonly initializeProductionActivity: typeof initializeProductionActivity
  readonly resetProductionActivity: typeof resetProductionActivity
  readonly initializeResyncIsolationProbe: typeof initializeResyncIsolationProbe
  readonly inspectResyncIsolationProbe: typeof inspectResyncIsolationProbe
}

declare global {
  interface Window {
    transactionRepositoryIntegration?: TransactionRepositoryIntegration
  }
}

window.transactionRepositoryIntegration = Object.freeze({
  reset: deleteDatabase,
  initialize,
  inspect,
  deleteAccount,
  initializeProductionEvmMonitor,
  inspectProductionEvmMonitor,
  resetProductionEvmMonitor,
  initializePortfolioCache,
  inspectPortfolioCache,
  initializeProductionEvmPortfolio,
  inspectProductionEvmPortfolioCache,
  resetProductionEvmPortfolio,
  initializeProductionActivity,
  resetProductionActivity,
  initializeResyncIsolationProbe,
  inspectResyncIsolationProbe
})
