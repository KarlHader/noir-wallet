import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createSigningJournal } from '../../../src/lib/multisig-signing-storage'
import {
  createMultisigTransactionJournal,
  MULTISIG_TRANSACTION_STORAGE_KEY,
  prepareFinalizationRecovery,
  recordFinalizationReceipt,
  recordProtectedSnapshotVerified,
  recordDurableFinalization,
  listFinalizationRecovery
} from '../../../src/lib/multisig-transaction-storage'
import type { SigningIntentBinding } from '../../../src/core/multisig/signing-journal'
import { installStorageEnv, reorderStorageObjectKeys } from './helpers/storage-env'
import {
  commitAccountMetadataDeletion,
  commitWalletMetadataDeletion,
  resetWalletMetadata,
  WALLET_STATE_KEY
} from '../../../src/lib/wallet-metadata-storage'
import {
  deleteMultisigDataForAccount,
  deleteMultisigDataForWallet
} from '../../../src/lib/multisig-vault-storage'
import { clearMultisigData } from '../../../src/lib/multisig-group-storage'
import { parseMultisigTransactionRecord } from '../../../src/core/multisig/transaction-journal'
import {
  beginFinalizationBarrier,
  clearFinalizationBarrier
} from '../../../src/lib/multisig-finalization-barrier'

const NOW = 1_800_000_000_000
const BINDING: SigningIntentBinding = {
  walletId: 'wallet',
  accountId: 'account',
  network: 'testnet',
  groupId: 'group',
  rosterVersion: 1,
  reviewId: 'review-1',
  pcztDigest: 'ab'.repeat(32),
  sessionId: 'AAAAAAAAAAAAAAAAAAAAAA==',
  threshold: '2-of-3',
  selectedSlots: [0, 2],
  expiresAt: NOW + 300_000,
  transport: 'qr',
  createdAt: NOW
}
const BARE_FINALIZED = {
  binding: BINDING,
  txId: '12'.repeat(32),
  rawTxSha256: '34'.repeat(32),
  rawTxLen: 2300,
  snapshotSha256: '56'.repeat(32)
}
const REVIEW = {
  recipient: 'u1recipient',
  amount: '100000',
  memo: '',
  fee: '10000',
  marginalFeeZats: 5000,
  feeQuoteId: 'quote-1'
}
const FINALIZED = { ...BARE_FINALIZED, review: REVIEW }

const recoveryScope = {
  network: BINDING.network,
  walletId: BINDING.walletId,
  accountId: BINDING.accountId,
  reviewId: BINDING.reviewId,
  sessionId: BINDING.sessionId
}

test('reviewed recovery evidence advances without granting submission authority', async () => {
  await sign()
  await assert.rejects(
    prepareFinalizationRecovery(
      { binding: BINDING, review: REVIEW, rawTx: 'secret' } as never,
      NOW + 6
    )
  )
  await prepareFinalizationRecovery({ binding: BINDING, review: REVIEW }, NOW + 6)
  assert.equal((await listFinalizationRecovery())[0]?.phase, 'prepared')
  await assert.rejects(
    recordFinalizationReceipt({ ...recoveryScope, ...BARE_FINALIZED, accountId: 'other' }, NOW + 7)
  )
  await assert.rejects(
    recordFinalizationReceipt(
      {
        ...recoveryScope,
        txId: FINALIZED.txId,
        rawTxSha256: FINALIZED.rawTxSha256,
        rawTxLen: FINALIZED.rawTxLen,
        rawTx: 'secret'
      } as never,
      NOW + 7
    )
  )
  await recordFinalizationReceipt(
    {
      ...recoveryScope,
      txId: FINALIZED.txId,
      rawTxSha256: FINALIZED.rawTxSha256,
      rawTxLen: FINALIZED.rawTxLen
    },
    NOW + 7
  )
  assert.equal((await listFinalizationRecovery())[0]?.phase, 'receipt')
  await recordProtectedSnapshotVerified(
    { ...recoveryScope, txId: FINALIZED.txId, snapshotSha256: FINALIZED.snapshotSha256 },
    NOW + 8
  )
  assert.equal((await listFinalizationRecovery())[0]?.phase, 'protected_snapshot_verified')
  await recordDurableFinalization(
    { ...recoveryScope, txId: FINALIZED.txId, snapshotSha256: FINALIZED.snapshotSha256 },
    NOW + 9
  )
  assert.equal((await listFinalizationRecovery())[0]?.phase, 'durable_finalization')
  const restarted = createMultisigTransactionJournal()
  await assert.rejects(restarted.beginSubmission(BINDING, FINALIZED.txId, NOW + 10))
})

test('two recovery receipts cannot claim the same network transaction ID', async () => {
  const otherBinding: SigningIntentBinding = {
    ...BINDING,
    accountId: 'other-account',
    reviewId: 'other-review',
    sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ=='
  }
  await sign()
  await sign(otherBinding)
  await prepareFinalizationRecovery({ binding: BINDING, review: REVIEW }, NOW + 6)
  await prepareFinalizationRecovery({ binding: otherBinding, review: REVIEW }, NOW + 6)
  await recordFinalizationReceipt(
    {
      ...recoveryScope,
      txId: FINALIZED.txId,
      rawTxSha256: FINALIZED.rawTxSha256,
      rawTxLen: FINALIZED.rawTxLen
    },
    NOW + 7
  )
  await assert.rejects(
    recordFinalizationReceipt(
      {
        ...recoveryScope,
        accountId: otherBinding.accountId,
        reviewId: otherBinding.reviewId,
        sessionId: otherBinding.sessionId,
        txId: FINALIZED.txId,
        rawTxSha256: FINALIZED.rawTxSha256,
        rawTxLen: FINALIZED.rawTxLen
      },
      NOW + 7
    )
  )
  assert.deepEqual((await listFinalizationRecovery()).map(record => record.phase).sort(), [
    'prepared',
    'receipt'
  ])
})

test('recovery stage acknowledgement requires storage readback', async () => {
  await sign()
  const originalSet = chrome.storage.local.set
  const originalGet = chrome.storage.local.get
  chrome.storage.local.set = async () => {}
  try {
    await assert.rejects(
      prepareFinalizationRecovery({ binding: BINDING, review: REVIEW }, NOW + 6),
      /could not be saved/
    )
  } finally {
    chrome.storage.local.set = originalSet
  }
  assert.deepEqual(await listFinalizationRecovery(), [])
  await prepareFinalizationRecovery({ binding: BINDING, review: REVIEW }, NOW + 6)
  chrome.storage.local.set = async items => {
    await originalSet(items)
    chrome.storage.local.get = async () => {
      chrome.storage.local.get = originalGet
      throw new Error('readback unavailable')
    }
  }
  try {
    await assert.rejects(
      recordFinalizationReceipt(
        {
          ...recoveryScope,
          txId: FINALIZED.txId,
          rawTxSha256: FINALIZED.rawTxSha256,
          rawTxLen: FINALIZED.rawTxLen
        },
        NOW + 7
      ),
      /readback unavailable/
    )
  } finally {
    chrome.storage.local.set = originalSet
    chrome.storage.local.get = originalGet
  }
  assert.equal((await listFinalizationRecovery())[0]?.phase, 'receipt')
  await assert.rejects(
    createMultisigTransactionJournal().beginSubmission(BINDING, FINALIZED.txId, NOW + 8)
  )
})

test('restart repairs only durable matching evidence after snapshot and barrier checks', async () => {
  await sign()
  await prepareFinalizationRecovery({ binding: BINDING, review: REVIEW }, NOW + 6)
  const transactions = createMultisigTransactionJournal()
  const proof = {
    assertAccountSource: async () => {},
    verifyProtectedSnapshot: async () => {},
    assertBarrierCleared: async () => {}
  }
  await assert.rejects(
    transactions.repairDurableFinalization(BINDING, FINALIZED.txId, NOW + 10, proof)
  )
  await recordFinalizationReceipt(
    {
      ...recoveryScope,
      txId: FINALIZED.txId,
      rawTxSha256: FINALIZED.rawTxSha256,
      rawTxLen: FINALIZED.rawTxLen
    },
    NOW + 7
  )
  await recordProtectedSnapshotVerified(
    { ...recoveryScope, txId: FINALIZED.txId, snapshotSha256: FINALIZED.snapshotSha256 },
    NOW + 8
  )
  await assert.rejects(
    transactions.repairDurableFinalization(BINDING, FINALIZED.txId, NOW + 10, proof)
  )
  await recordDurableFinalization(
    { ...recoveryScope, txId: FINALIZED.txId, snapshotSha256: FINALIZED.snapshotSha256 },
    NOW + 9
  )
  await assert.rejects(
    transactions.repairDurableFinalization(BINDING, FINALIZED.txId, NOW + 10, {
      ...proof,
      assertBarrierCleared: async () => {
        throw new Error('barrier remains')
      }
    }),
    /barrier remains/
  )
  await assert.rejects(
    transactions.repairDurableFinalization(BINDING, FINALIZED.txId, NOW + 10, {
      ...proof,
      assertAccountSource: async () => {
        throw new Error('source changed')
      }
    }),
    /source changed/
  )
  await assert.rejects(
    transactions.repairDurableFinalization(BINDING, FINALIZED.txId, NOW + 10, {
      ...proof,
      verifyProtectedSnapshot: async () => {
        throw new Error('snapshot mismatch')
      }
    }),
    /snapshot mismatch/
  )
  const repaired = await transactions.repairDurableFinalization(
    BINDING,
    FINALIZED.txId,
    NOW + 10,
    proof
  )
  assert.equal(repaired.phase, 'finalized')
  assert.deepEqual(repaired.review, REVIEW)
  await assert.rejects(transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 11))
  assert.deepEqual(
    await transactions.repairDurableFinalization(BINDING, FINALIZED.txId, NOW + 12, proof),
    repaired
  )
})

test('recovery evidence blocks deletion until the exact payment is confirmed', async () => {
  await sign()
  await prepareFinalizationRecovery({ binding: BINDING, review: REVIEW }, NOW + 6)
  await assert.rejects(deleteMultisigDataForAccount('wallet', 'account'))
  await recordFinalizationReceipt(
    {
      ...recoveryScope,
      txId: FINALIZED.txId,
      rawTxSha256: FINALIZED.rawTxSha256,
      rawTxLen: FINALIZED.rawTxLen
    },
    NOW + 7
  )
  await assert.rejects(
    recordProtectedSnapshotVerified(
      { ...recoveryScope, txId: '00'.repeat(32), snapshotSha256: FINALIZED.snapshotSha256 },
      NOW + 8
    )
  )
  assert.equal((await listFinalizationRecovery())[0]?.phase, 'receipt')
  await recordProtectedSnapshotVerified(
    { ...recoveryScope, txId: FINALIZED.txId, snapshotSha256: FINALIZED.snapshotSha256 },
    NOW + 8
  )
  await assert.rejects(deleteMultisigDataForAccount('wallet', 'account'))
  await recordDurableFinalization(
    { ...recoveryScope, txId: FINALIZED.txId, snapshotSha256: FINALIZED.snapshotSha256 },
    NOW + 9
  )
  const transactions = createMultisigTransactionJournal()
  await transactions.recordFinalized(FINALIZED, NOW + 10)
  await assert.rejects(deleteMultisigDataForAccount('wallet', 'account'))
  await transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 11)
  await transactions.recordConfirmed(BINDING, FINALIZED.txId, NOW + 12)
  const otherBinding: SigningIntentBinding = {
    ...BINDING,
    accountId: 'other-account',
    reviewId: 'other-review',
    sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ=='
  }
  const otherFinalized = { ...FINALIZED, binding: otherBinding, txId: 'ab'.repeat(32) }
  const otherScope = {
    ...recoveryScope,
    accountId: otherBinding.accountId,
    reviewId: otherBinding.reviewId,
    sessionId: otherBinding.sessionId
  }
  await sign(otherBinding)
  await prepareFinalizationRecovery({ binding: otherBinding, review: REVIEW }, NOW + 13)
  await recordFinalizationReceipt(
    {
      ...otherScope,
      txId: otherFinalized.txId,
      rawTxSha256: otherFinalized.rawTxSha256,
      rawTxLen: otherFinalized.rawTxLen
    },
    NOW + 14
  )
  await recordProtectedSnapshotVerified(
    { ...otherScope, txId: otherFinalized.txId, snapshotSha256: otherFinalized.snapshotSha256 },
    NOW + 15
  )
  await recordDurableFinalization(
    { ...otherScope, txId: otherFinalized.txId, snapshotSha256: otherFinalized.snapshotSha256 },
    NOW + 16
  )
  await transactions.recordFinalized(otherFinalized, NOW + 17)
  await transactions.beginSubmission(otherBinding, otherFinalized.txId, NOW + 18)
  await transactions.recordConfirmed(otherBinding, otherFinalized.txId, NOW + 19)
  await deleteMultisigDataForAccount('wallet', 'account')
  assert.deepEqual(
    (await listFinalizationRecovery()).map(record => record.binding.accountId),
    ['other-account']
  )
})

test('a barrier for another account in the same wallet blocks metadata and group deletion', async () => {
  const otherBinding: SigningIntentBinding = {
    ...BINDING,
    accountId: 'other-account',
    reviewId: 'other-review',
    sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ=='
  }
  const barrier = await beginFinalizationBarrier(
    {
      network: otherBinding.network,
      walletId: otherBinding.walletId,
      accountId: otherBinding.accountId,
      reviewId: otherBinding.reviewId,
      sessionId: otherBinding.sessionId
    },
    'barrier-token'
  )
  try {
    await assert.rejects(
      commitAccountMetadataDeletion('wallet', 'account', 'testnet', 0),
      /pending multisig finalization/
    )
    await assert.rejects(
      deleteMultisigDataForAccount('wallet', 'account'),
      /pending multisig finalization/
    )
  } finally {
    await clearFinalizationBarrier(barrier)
  }
})

test('another account prepared to finalize blocks shared wallet cleanup before its barrier exists', async () => {
  const otherBinding: SigningIntentBinding = {
    ...BINDING,
    accountId: 'other-account',
    reviewId: 'other-review',
    sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ=='
  }
  await sign(otherBinding)
  await prepareFinalizationRecovery({ binding: otherBinding, review: REVIEW }, NOW + 6)
  await assert.rejects(
    commitAccountMetadataDeletion('wallet', 'account', 'testnet', 0),
    /pending multisig finalization/
  )
  await assert.rejects(
    deleteMultisigDataForAccount('wallet', 'account'),
    /pending multisig finalization/
  )
  assert.equal((await listFinalizationRecovery())[0]?.binding.accountId, 'other-account')
})

test('a new finalization requires the reviewed transfer and approved fee quote', async () => {
  await sign()
  const transactions = createMultisigTransactionJournal()
  await assert.rejects(transactions.recordFinalized(BARE_FINALIZED as never, NOW + 6))
  for (const review of [
    { ...REVIEW, amount: '0' },
    { ...REVIEW, memo: 'a'.repeat(513) },
    { ...REVIEW, marginalFeeZats: -1 },
    { ...REVIEW, feeQuoteId: '' },
    { ...REVIEW, privateKey: 'secret' }
  ])
    await assert.rejects(
      transactions.recordFinalized({ ...BARE_FINALIZED, review } as never, NOW + 6)
    )
  assert.equal(env.store.has(MULTISIG_TRANSACTION_STORAGE_KEY), false)
})

test('legacy v1 transaction rows remain readable without inventing a review', () => {
  const legacy = parseMultisigTransactionRecord({
    ...BARE_FINALIZED,
    version: 1,
    phase: 'submission_unknown',
    updatedAt: NOW + 6
  })
  assert.equal(legacy.version, 1)
  assert.equal(legacy.review, undefined)
  assert.throws(() => parseMultisigTransactionRecord({ ...legacy, review: REVIEW, version: 1 }))
})

let env: ReturnType<typeof installStorageEnv>
beforeEach(() => {
  env = installStorageEnv()
})
afterEach(() => env.restore())

async function sign(binding = BINDING) {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(binding, NOW)
  for (const [index, [expectedNoncePhase, nextNoncePhase]] of (
    [
      ['none', 'created'],
      ['created', 'committed'],
      ['committed', 'consumed']
    ] as const
  ).entries()) {
    if (index === 0)
      await journal.advanceSigningIntent(
        binding,
        {
          expectedPhase: 'review_ready',
          expectedNoncePhase: 'none',
          nextPhase: 'signing',
          nextNoncePhase: 'none'
        },
        NOW + 1
      )
    await journal.advanceSigningIntent(
      binding,
      {
        expectedPhase: 'signing',
        expectedNoncePhase,
        nextPhase: 'signing',
        nextNoncePhase
      },
      NOW + 2 + index
    )
  }
  await journal.advanceSigningIntent(
    binding,
    {
      expectedPhase: 'signing',
      expectedNoncePhase: 'consumed',
      nextPhase: 'signed',
      nextNoncePhase: 'consumed'
    },
    NOW + 5
  )
}

test('finalization requires the exact durably signed review and rejects private or malformed fields', async () => {
  const transactions = createMultisigTransactionJournal()
  await assert.rejects(transactions.recordFinalized(FINALIZED, NOW + 6))
  await sign()
  for (const patch of [
    { pczt: 'private' },
    { rawTx: 'private' },
    { snapshotSha256: 'not a digest' },
    { txId: '0' },
    { rawTxLen: 0 },
    { rawTxLen: Number.MAX_SAFE_INTEGER },
    { binding: { ...BINDING, selectedSlots: [0, 1] } },
    { binding: { ...BINDING, reviewId: 'another' } }
  ])
    await assert.rejects(transactions.recordFinalized({ ...FINALIZED, ...patch } as never, NOW + 6))
  assert.equal(env.store.has(MULTISIG_TRANSACTION_STORAGE_KEY), false)
  const saved = await transactions.recordFinalized(FINALIZED, NOW + 6)
  assert.equal(saved.phase, 'finalized')
  assert.equal(saved.rawTxSha256, FINALIZED.rawTxSha256)
  assert.equal(JSON.stringify(saved).includes('private'), false)
})

test('write readback is required before submission and unknown survives restart without rebuilding', async () => {
  await sign()
  const transactions = createMultisigTransactionJournal()
  const originalSet = chrome.storage.local.set
  chrome.storage.local.set = async () => {}
  try {
    await assert.rejects(transactions.recordFinalized(FINALIZED, NOW + 6), /saved/)
  } finally {
    chrome.storage.local.set = originalSet
  }
  assert.equal(await transactions.readTransaction(BINDING, FINALIZED.txId), null)
  await transactions.recordFinalized(FINALIZED, NOW + 7)
  const originalGet = chrome.storage.local.get
  chrome.storage.local.set = async items => {
    await originalSet(items)
    chrome.storage.local.get = async () => {
      chrome.storage.local.get = originalGet
      throw new Error('readback failed')
    }
  }
  try {
    await assert.rejects(transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 8))
  } finally {
    chrome.storage.local.set = originalSet
    chrome.storage.local.get = originalGet
  }
  assert.equal(
    (await transactions.readTransaction(BINDING, FINALIZED.txId))?.phase,
    'submission_unknown'
  )
  const restarted = createMultisigTransactionJournal()
  assert.equal(
    (await restarted.readTransaction(BINDING, FINALIZED.txId))?.phase,
    'submission_unknown'
  )
  await assert.rejects(restarted.beginSubmission(BINDING, FINALIZED.txId, NOW + 9))
  await assert.rejects(restarted.recordFinalized(FINALIZED, NOW + 9))
})

test('restart preserves unsent finalization and removes authority to submit without explicit recovery', async () => {
  await sign()
  const transactions = createMultisigTransactionJournal()
  await transactions.recordFinalized(FINALIZED, NOW + 6)
  const restarted = createMultisigTransactionJournal()
  assert.deepEqual(
    (await restarted.recoverPending()).map(record => record.phase),
    ['finalized']
  )
  assert.equal((await transactions.readTransaction(BINDING, FINALIZED.txId))?.phase, 'finalized')
  await assert.rejects(restarted.beginSubmission(BINDING, FINALIZED.txId, NOW + 8))
  await transactions.recoverPending()
  await assert.rejects(transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 8))
})

test('broadcast and confirmation are monotonic, tied to one txid and cannot release an unknown payment', async () => {
  await sign()
  const transactions = createMultisigTransactionJournal()
  await transactions.recordFinalized(FINALIZED, NOW + 6)
  await assert.rejects(transactions.recordBroadcast(BINDING, FINALIZED.txId, NOW + 7))
  await transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 7)
  await assert.rejects(transactions.recordBroadcast(BINDING, '00'.repeat(32), NOW + 8))
  await assert.rejects(
    transactions.recordBroadcast({ ...BINDING, accountId: 'other' }, FINALIZED.txId, NOW + 8)
  )
  await transactions.recordBroadcast(BINDING, FINALIZED.txId, NOW + 8)
  assert.equal((await transactions.readTransaction(BINDING, FINALIZED.txId))?.phase, 'broadcast')
  await assert.rejects(transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 9))
  await transactions.recordConfirmed(BINDING, FINALIZED.txId, NOW + 9)
  assert.equal((await transactions.readTransaction(BINDING, FINALIZED.txId))?.phase, 'confirmed')
  await assert.rejects(transactions.recordBroadcast(BINDING, FINALIZED.txId, NOW + 10))
})

test('the same network transaction ID cannot be recorded under another account', async () => {
  const otherBinding: SigningIntentBinding = {
    ...BINDING,
    accountId: 'other',
    reviewId: 'review-2',
    sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ=='
  }
  await sign()
  await sign(otherBinding)
  const transactions = createMultisigTransactionJournal()
  await transactions.recordFinalized(FINALIZED, NOW + 6)
  await assert.rejects(
    transactions.recordFinalized({ ...FINALIZED, binding: otherBinding }, NOW + 6)
  )
  assert.equal((await transactions.listTransactions()).length, 1)
})

test('storage reordering is accepted but changed tx bytes, scope or snapshot are rejected', async () => {
  await sign()
  const transactions = createMultisigTransactionJournal()
  const originalSet = chrome.storage.local.set
  chrome.storage.local.set = async items =>
    originalSet(reorderStorageObjectKeys(items) as Record<string, unknown>)
  try {
    await transactions.recordFinalized(FINALIZED, NOW + 6)
  } finally {
    chrome.storage.local.set = originalSet
  }
  for (const mutate of [
    (row: Record<string, unknown>) => {
      row.rawTxSha256 = '00'.repeat(32)
    },
    (row: Record<string, unknown>) => {
      row.snapshotSha256 = '00'.repeat(32)
    },
    (row: Record<string, unknown>) => {
      ;(row.binding as Record<string, unknown>).accountId = 'other'
    },
    (row: Record<string, unknown>) => {
      row.rawTx = 'secret'
    }
  ]) {
    const before = structuredClone(env.store.get(MULTISIG_TRANSACTION_STORAGE_KEY))
    chrome.storage.local.set = async items => {
      const altered = structuredClone(items)
      const records = altered[MULTISIG_TRANSACTION_STORAGE_KEY] as Record<
        string,
        Record<string, unknown>[]
      >
      mutate(records['["testnet","wallet","account"]'][0])
      await originalSet(altered)
    }
    try {
      await assert.rejects(transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 7))
    } finally {
      chrome.storage.local.set = originalSet
      env.store.set(MULTISIG_TRANSACTION_STORAGE_KEY, before)
    }
  }
  assert.equal((await transactions.readTransaction(BINDING, FINALIZED.txId))?.phase, 'finalized')
})

test('unresolved transaction prevents account and wallet deletion before metadata changes', async () => {
  env.store.set(WALLET_STATE_KEY, {
    version: 0,
    state: {
      wallets: [{ id: BINDING.walletId, accounts: [{ id: BINDING.accountId }] }],
      currentWalletId: BINDING.walletId,
      currentAccountId: BINDING.accountId
    }
  })
  await sign()
  const transactions = createMultisigTransactionJournal()
  await transactions.recordFinalized(FINALIZED, NOW + 6)

  await assert.rejects(commitAccountMetadataDeletion('wallet', 'account', 'testnet', 0))
  await assert.rejects(commitWalletMetadataDeletion('wallet', ['account']))
  await assert.rejects(deleteMultisigDataForAccount('wallet', 'account'))
  await assert.rejects(deleteMultisigDataForWallet('wallet'))
  await assert.rejects(clearMultisigData())
  await assert.rejects(resetWalletMetadata())
  assert.equal((await transactions.readTransaction(BINDING, FINALIZED.txId))?.phase, 'finalized')
  assert.deepEqual(
    (env.store.get(WALLET_STATE_KEY) as { state: { wallets: { id: string }[] } }).state.wallets.map(
      wallet => wallet.id
    ),
    ['wallet']
  )
  assert.equal(env.store.has('wallet_deleted_ids'), false)
  assert.equal(env.store.has('wallet_deleted_account_keys'), false)
})

test('only a confirmed matching transaction settles signed intent and permits a new review', async () => {
  await sign()
  const journal = createSigningJournal()
  const transactions = createMultisigTransactionJournal()
  await transactions.recordFinalized(FINALIZED, NOW + 6)
  await assert.rejects(journal.settleConfirmedSigningIntent(BINDING, FINALIZED.txId, NOW + 7))
  await assert.rejects(
    journal.advanceSigningIntent(
      BINDING,
      {
        expectedPhase: 'signed',
        expectedNoncePhase: 'consumed',
        nextPhase: 'confirmed',
        nextNoncePhase: 'consumed'
      },
      NOW + 7
    )
  )
  await transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 7)
  await transactions.recordConfirmed(BINDING, FINALIZED.txId, NOW + 8)
  await assert.rejects(journal.settleConfirmedSigningIntent(BINDING, '00'.repeat(32), NOW + 9))
  await assert.rejects(
    journal.settleConfirmedSigningIntent(
      { ...BINDING, pcztDigest: '00'.repeat(32) },
      FINALIZED.txId,
      NOW + 9
    )
  )
  const settled = await journal.settleConfirmedSigningIntent(BINDING, FINALIZED.txId, NOW + 9)
  assert.equal(settled.phase, 'confirmed')
  assert.equal(settled.noncePhase, 'consumed')
  const next = { ...BINDING, reviewId: 'review-next', sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ==' }
  await journal.reserveSigningIntent(next, NOW + 10)
  await assert.rejects(journal.reserveSigningIntent(BINDING, NOW + 10))
})

test('signed intent without a confirmed transaction blocks deletion after a crash before finalization', async () => {
  env.store.set(WALLET_STATE_KEY, {
    state: { wallets: [{ id: 'wallet', accounts: [{ id: 'account', derivationIndex: 0 }] }] }
  })
  await sign()
  await assert.rejects(commitAccountMetadataDeletion('wallet', 'account', 'testnet', 0))
  await assert.rejects(commitWalletMetadataDeletion('wallet', ['account']))
  await assert.rejects(deleteMultisigDataForAccount('wallet', 'account'))
  await assert.rejects(clearMultisigData())
  await assert.rejects(resetWalletMetadata())
  assert.equal(env.store.has('wallet_deleted_ids'), false)
})

test('account cleanup removes confirmed transaction metadata after settlement', async () => {
  await sign()
  const transactions = createMultisigTransactionJournal()
  const journal = createSigningJournal()
  await transactions.recordFinalized(FINALIZED, NOW + 6)
  await transactions.beginSubmission(BINDING, FINALIZED.txId, NOW + 7)
  await transactions.recordConfirmed(BINDING, FINALIZED.txId, NOW + 8)
  await journal.settleConfirmedSigningIntent(BINDING, FINALIZED.txId, NOW + 9)
  await deleteMultisigDataForAccount('wallet', 'account')
  assert.equal(await transactions.readTransaction(BINDING, FINALIZED.txId), null)
  assert.equal(await journal.readSigningIntent(BINDING), null)
})
