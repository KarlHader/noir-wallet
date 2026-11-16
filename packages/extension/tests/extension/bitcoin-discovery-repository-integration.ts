import { parseAccountId, parseAccountIndex } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { BitcoinChangeReservationScope } from '@/infrastructure/chains/bitcoin/bitcoin-change-reservation-model'
import { IndexedDbBitcoinChangeReservationRepository } from '@/infrastructure/chains/bitcoin/bitcoin-change-reservation-repository'
import { IndexedDbBitcoinInputReservationRepository } from '@/infrastructure/chains/bitcoin/bitcoin-input-reservation-repository'
import {
  IndexedDbBitcoinDiscoveryRepository,
  type BitcoinDiscoveryProgress
} from '@/infrastructure/chains/bitcoin/bitcoin-discovery-repository'

const chainId = parseChainId('bip122:000000000019d6689c085ae165831e93').id
const keyDomainId = parseKeyDomainId('key-domain:bitcoin:repository-e2e')
const accountId = parseAccountId('account:bitcoin:repository-e2e')
const accountIndex = parseAccountIndex(0)
const chainAccount = {
  id: 'chain-account:bitcoin:repository-e2e',
  scope: { keyDomainId, accountId, chainId },
  derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
  identity: {
    kind: 'account-identifier' as const,
    value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
  },
  createdAt: 1_000
}
const addresses = [
  'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  'bc1qzmtrqsfuaf6l6kkcsseumq26ukaphfj9skkug6'
]

function progress(addressIndex: number, nextAddressIndex: number): BitcoinDiscoveryProgress {
  return {
    chainAccount,
    accountIndex,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex,
      gapLimit: 2,
      maximumAddressesPerTarget: 4,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex,
          consecutiveUnused: nextAddressIndex,
          complete: nextAddressIndex === 2
        }
      ]
    },
    observation: {
      derived: {
        chainId,
        addressType: 'p2wpkh',
        accountIndex,
        change: false,
        addressIndex,
        address: addresses[addressIndex],
        addressScheme: 'bitcoin-p2wpkh',
        derivationScheme: 'bip84',
        derivationPath: `m/84'/0'/0'/0/${addressIndex}`,
        publicKey: `0x02${String(addressIndex + 1).repeat(64)}`
      },
      activity: {
        confirmedTransactionCount: 0,
        mempoolTransactionCount: 0,
        used: false
      },
      utxos: []
    },
    updatedAt: 2_000 + addressIndex
  }
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onerror = () => reject(request.error ?? new Error('Test database deletion failed'))
    request.onblocked = () => reject(new Error('Test database deletion blocked'))
    request.onsuccess = () => resolve()
  })
}

function repository(databaseName: string) {
  return new IndexedDbBitcoinDiscoveryRepository({ databaseName })
}

const changeScope: BitcoinChangeReservationScope = {
  chainAccount,
  accountIndex,
  addressType: 'p2wpkh'
}

function changeAddress(addressIndex: number) {
  return {
    chainId,
    addressType: 'p2wpkh' as const,
    accountIndex,
    change: true,
    addressIndex,
    address: addresses[addressIndex % addresses.length],
    addressScheme: 'bitcoin-p2wpkh' as const,
    derivationScheme: 'bip84' as const,
    derivationPath: `m/84'/0'/0'/1/${addressIndex}`,
    publicKey: `0x02${String((addressIndex % 8) + 1).repeat(64)}`
  }
}

function changeRepository(databaseName: string) {
  return new IndexedDbBitcoinChangeReservationRepository({ databaseName })
}

function inputRepository(databaseName: string) {
  return new IndexedDbBitcoinInputReservationRepository({ databaseName })
}

const inputA = { transactionId: 'a'.repeat(64), outputIndex: 0 }
const inputB = { transactionId: 'b'.repeat(64), outputIndex: 1 }
const inputC = { transactionId: 'c'.repeat(64), outputIndex: 2 }

async function initialize(databaseName: string) {
  await deleteDatabase(databaseName)
  const current = repository(databaseName)
  const first = progress(0, 1)
  await current.putProgress(first)
  await current.putProgress(first)
  let rejectedInvalidAdvance = false
  try {
    await current.putProgress({
      ...progress(1, 2),
      checkpoint: {
        ...progress(1, 2).checkpoint,
        cursors: [
          {
            target: { addressType: 'p2wpkh', change: false },
            nextAddressIndex: 3,
            consecutiveUnused: 2,
            complete: true
          }
        ]
      }
    })
  } catch {
    rejectedInvalidAdvance = true
  }
  const afterFailure = await current.get({ chainAccount, accountIndex })
  await current.putProgress(progress(1, 2))
  return {
    rejectedInvalidAdvance,
    observationsAfterFailure: afterFailure?.observations.length,
    final: await current.get({ chainAccount, accountIndex })
  }
}

async function inspect(databaseName: string) {
  const current = repository(databaseName)
  const state = await current.get({ chainAccount, accountIndex })
  const deleted = await current.deleteByAccountScope({ keyDomainId, accountId })
  return {
    state,
    deleted,
    afterDelete: await current.get({ chainAccount, accountIndex })
  }
}

async function refresh(databaseName: string) {
  await deleteDatabase(databaseName)
  const current = repository(databaseName)
  await current.putProgress(progress(0, 1))
  await current.putProgress(progress(1, 2))
  const existing = await current.get({ chainAccount, accountIndex })
  if (!existing) throw new Error('Bitcoin discovery refresh fixture is missing')
  const refreshedObservations = existing.observations.map((observation, index) =>
    index === 1
      ? {
          ...observation,
          activity: {
            confirmedTransactionCount: 1,
            mempoolTransactionCount: 0,
            used: true
          },
          utxos: [
            {
              transactionId: 'd'.repeat(64),
              outputIndex: 0,
              valueRaw: '2500',
              status: {
                confirmed: true,
                blockHeight: 100,
                blockHash: 'e'.repeat(64)
              }
            }
          ]
        }
      : observation
  )
  const refreshedCheckpoint = {
    ...existing.checkpoint,
    cursors: [
      {
        ...existing.checkpoint.cursors[0],
        consecutiveUnused: 0,
        complete: false
      }
    ]
  }
  await current.putRefresh({
    chainAccount,
    accountIndex,
    checkpoint: refreshedCheckpoint,
    observations: refreshedObservations,
    updatedAt: 3_000
  })
  let rejectedIdentityChange = false
  try {
    await current.putRefresh({
      chainAccount,
      accountIndex,
      checkpoint: refreshedCheckpoint,
      observations: [
        {
          ...refreshedObservations[0],
          derived: {
            ...refreshedObservations[0].derived,
            publicKey: `0x03${'f'.repeat(64)}`
          }
        },
        refreshedObservations[1]
      ],
      updatedAt: 3_001
    })
  } catch {
    rejectedIdentityChange = true
  }
  return {
    rejectedIdentityChange,
    state: await current.get({ chainAccount, accountIndex })
  }
}

async function extendDiscoveryTargets(databaseName: string) {
  await deleteDatabase(databaseName)
  const current = repository(databaseName)
  await current.putProgress(progress(0, 1))
  await current.putProgress(progress(1, 2))
  const existing = await current.get({ chainAccount, accountIndex })
  if (!existing) throw new Error('Bitcoin discovery target extension fixture is missing')
  const checkpoint = {
    ...existing.checkpoint,
    cursors: [
      ...existing.checkpoint.cursors,
      {
        target: { addressType: 'p2pkh' as const, change: false },
        nextAddressIndex: 0,
        consecutiveUnused: 0,
        complete: false
      },
      {
        target: { addressType: 'p2sh-p2wpkh' as const, change: false },
        nextAddressIndex: 0,
        consecutiveUnused: 0,
        complete: false
      }
    ]
  }
  await current.extendTargets({
    chainAccount,
    accountIndex,
    checkpoint,
    updatedAt: 3_000
  })
  let rejectedExistingCursorChange = false
  try {
    await current.extendTargets({
      chainAccount,
      accountIndex,
      checkpoint: {
        ...checkpoint,
        cursors: [
          { ...checkpoint.cursors[0], nextAddressIndex: 1, consecutiveUnused: 1, complete: false },
          ...checkpoint.cursors.slice(1),
          {
            target: { addressType: 'p2tr' as const, change: false },
            nextAddressIndex: 0,
            consecutiveUnused: 0,
            complete: false
          }
        ]
      },
      updatedAt: 3_001
    })
  } catch {
    rejectedExistingCursorChange = true
  }
  return {
    rejectedExistingCursorChange,
    state: await current.get({ chainAccount, accountIndex })
  }
}

async function initializeIndependentTarget(databaseName: string) {
  await deleteDatabase(databaseName)
  const current = repository(databaseName)
  await current.putProgress({
    chainAccount,
    accountIndex,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex,
      gapLimit: 1,
      maximumAddressesPerTarget: 1,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex: 0,
          consecutiveUnused: 0,
          complete: false
        },
        {
          target: { addressType: 'p2tr', change: false },
          nextAddressIndex: 1,
          consecutiveUnused: 1,
          complete: true
        }
      ]
    },
    observation: {
      derived: {
        chainId,
        addressType: 'p2tr',
        accountIndex,
        change: false,
        addressIndex: 0,
        address: 'bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9',
        addressScheme: 'bitcoin-p2tr',
        derivationScheme: 'bip86',
        derivationPath: "m/86'/0'/0'/0/0",
        publicKey: `0x02${'3'.repeat(64)}`
      },
      activity: {
        confirmedTransactionCount: 0,
        mempoolTransactionCount: 0,
        used: false
      },
      utxos: []
    },
    updatedAt: 3_500
  })
  return current.get({ chainAccount, accountIndex })
}

async function initializeChanges(databaseName: string) {
  await deleteDatabase(databaseName)
  const current = changeRepository(databaseName)
  const committedAllocation = await current.allocate({
    ...changeScope,
    transactionId: 'transaction:change:committed',
    minimumAddressIndex: 3,
    now: 3_000
  })
  const repeatedAllocation = await current.allocate({
    ...changeScope,
    transactionId: 'transaction:change:committed',
    minimumAddressIndex: 9,
    now: 3_001
  })
  await current.bindAddress({
    ...changeScope,
    transactionId: committedAllocation.transactionId,
    address: changeAddress(committedAllocation.addressIndex),
    now: 3_001
  })
  const committed = await current.transition({
    ...changeScope,
    transactionId: committedAllocation.transactionId,
    state: 'committed',
    now: 3_002
  })
  let rejectedTerminalTransition = false
  try {
    await current.transition({
      ...changeScope,
      transactionId: committedAllocation.transactionId,
      state: 'abandoned',
      now: 3_003
    })
  } catch {
    rejectedTerminalTransition = true
  }

  const abandonedAllocation = await current.allocate({
    ...changeScope,
    transactionId: 'transaction:change:abandoned',
    minimumAddressIndex: 0,
    now: 3_003
  })
  await current.bindAddress({
    ...changeScope,
    transactionId: abandonedAllocation.transactionId,
    address: changeAddress(abandonedAllocation.addressIndex),
    now: 3_004
  })
  const abandoned = await current.transition({
    ...changeScope,
    transactionId: abandonedAllocation.transactionId,
    state: 'abandoned',
    now: 3_005
  })
  const interrupted = await current.allocate({
    ...changeScope,
    transactionId: 'transaction:change:interrupted',
    minimumAddressIndex: 0,
    now: 3_006
  })
  return {
    repeatedAllocation,
    committed,
    abandoned,
    interrupted,
    rejectedTerminalTransition
  }
}

async function inspectChanges(databaseName: string) {
  const current = changeRepository(databaseName)
  const committed = await current.get(changeScope, 'transaction:change:committed')
  const abandoned = await current.get(changeScope, 'transaction:change:abandoned')
  const interruptedBeforeBind = await current.get(changeScope, 'transaction:change:interrupted')
  if (!interruptedBeforeBind) throw new Error('Interrupted reservation is missing')
  const resumed = await current.bindAddress({
    ...changeScope,
    transactionId: interruptedBeforeBind.transactionId,
    address: changeAddress(interruptedBeforeBind.addressIndex),
    now: 4_000
  })
  const next = await current.allocate({
    ...changeScope,
    transactionId: 'transaction:change:next',
    minimumAddressIndex: 0,
    now: 4_001
  })
  const deleted = await current.deleteByAccountScope({ keyDomainId, accountId })
  return {
    committed,
    abandoned,
    interruptedBeforeBind,
    resumed,
    next,
    deleted,
    afterDelete: await current.get(changeScope, 'transaction:change:committed')
  }
}

async function initializeInputs(databaseName: string) {
  await deleteDatabase(databaseName)
  const current = inputRepository(databaseName)
  const first = await current.reserve({
    ...changeScope,
    transactionId: 'transaction:inputs:first',
    outpoints: [inputB, inputA],
    now: 5_000
  })
  const repeated = await current.reserve({
    ...changeScope,
    transactionId: 'transaction:inputs:first',
    outpoints: [inputA, inputB],
    now: 5_001
  })
  let rejectedConflict = false
  try {
    await current.reserve({
      ...changeScope,
      transactionId: 'transaction:inputs:second',
      outpoints: [inputB],
      now: 5_002
    })
  } catch {
    rejectedConflict = true
  }
  await current.release(changeScope, first.transactionId)
  const second = await current.reserve({
    ...changeScope,
    transactionId: 'transaction:inputs:second',
    outpoints: [inputB],
    now: 5_003
  })
  const committed = await current.commit({
    ...changeScope,
    transactionId: second.transactionId,
    now: 5_004
  })
  let rejectedCommittedRelease = false
  try {
    await current.release(changeScope, committed.transactionId)
  } catch {
    rejectedCommittedRelease = true
  }
  const concurrent = await Promise.allSettled([
    current.reserve({
      ...changeScope,
      transactionId: 'transaction:inputs:third',
      outpoints: [inputC],
      now: 5_005
    }),
    current.reserve({
      ...changeScope,
      transactionId: 'transaction:inputs:fourth',
      outpoints: [inputC],
      now: 5_005
    })
  ])
  const winners = concurrent.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof current.reserve>>> =>
      result.status === 'fulfilled'
  )
  return {
    first,
    repeated,
    rejectedConflict,
    committed,
    rejectedCommittedRelease,
    concurrentWinnerCount: winners.length,
    reserved: winners[0]?.value
  }
}

async function inspectInputs(databaseName: string) {
  const current = inputRepository(databaseName)
  const committed = await current.get(changeScope, 'transaction:inputs:second')
  const reserved =
    (await current.get(changeScope, 'transaction:inputs:third')) ??
    (await current.get(changeScope, 'transaction:inputs:fourth'))
  const listed = await current.list(changeScope)
  const accountListed = await current.listByAccountScope({ keyDomainId, accountId })
  let rejectedCommittedConflict = false
  try {
    await current.reserve({
      ...changeScope,
      transactionId: 'transaction:inputs:fourth',
      outpoints: [inputB],
      now: 6_000
    })
  } catch {
    rejectedCommittedConflict = true
  }
  const retiredCommitted = await current.retireCommitted(changeScope, 'transaction:inputs:second')
  const afterRetire = await current.get(changeScope, 'transaction:inputs:second')
  const deleted = await current.deleteByAccountScope({ keyDomainId, accountId })
  return {
    committed,
    reserved,
    listed,
    accountListed,
    rejectedCommittedConflict,
    retiredCommitted,
    afterRetire,
    deleted,
    afterDelete: await current.get(changeScope, 'transaction:inputs:second')
  }
}

export interface BitcoinDiscoveryRepositoryIntegration {
  readonly initialize: typeof initialize
  readonly inspect: typeof inspect
  readonly refresh: typeof refresh
  readonly extendDiscoveryTargets: typeof extendDiscoveryTargets
  readonly initializeIndependentTarget: typeof initializeIndependentTarget
  readonly initializeChanges: typeof initializeChanges
  readonly inspectChanges: typeof inspectChanges
  readonly initializeInputs: typeof initializeInputs
  readonly inspectInputs: typeof inspectInputs
  readonly reset: typeof deleteDatabase
}

declare global {
  interface Window {
    bitcoinDiscoveryRepositoryIntegration?: BitcoinDiscoveryRepositoryIntegration
  }
}

window.bitcoinDiscoveryRepositoryIntegration = Object.freeze({
  initialize,
  inspect,
  refresh,
  extendDiscoveryTargets,
  initializeIndependentTarget,
  initializeChanges,
  inspectChanges,
  initializeInputs,
  inspectInputs,
  reset: deleteDatabase
})
