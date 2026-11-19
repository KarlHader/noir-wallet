import {
  advanceMultisigTransaction,
  isUnresolvedMultisigTransaction,
  parseFinalizedMultisigTransaction,
  parseFinalizationRecoveryRecord,
  parseMultisigTransactionRecord,
  type FinalizedMultisigTransaction,
  type FinalizationRecoveryRecord,
  type MultisigTransactionPhase,
  type MultisigTransactionRecord
} from '@/core/multisig/transaction-journal'
import {
  parseSigningIntent,
  parseSigningIntentBinding,
  signingIntentBinding,
  signingJournalScopeKey,
  parseSigningJournalScopeKey,
  type SigningIntentBinding
} from '@/core/multisig/signing-journal'
import { MULTISIG_SIGNING_STORAGE_KEY, withMultisigStorageLock } from './multisig-group-storage'
import { withUndeletedWalletAccountMetadata } from './wallet-metadata-storage'
import {
  MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY,
  MULTISIG_TRANSACTION_STORAGE_KEY
} from './multisig-transaction-guard'
import { storageJsonEquals } from './storage-json-equality'

export {
  MULTISIG_TRANSACTION_STORAGE_KEY,
  MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY
} from './multisig-transaction-guard'
const FAIL = 'Multisig transaction is unavailable'
const PER_ACCOUNT_LIMIT = 512
type Journals = Record<string, MultisigTransactionRecord[]>
type RecoveryJournals = Record<string, FinalizationRecoveryRecord[]>

function exactInput(value: unknown, keys: readonly string[]): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

export interface FinalizationRecoveryScope {
  network: 'mainnet' | 'testnet'
  walletId: string
  accountId: string
  reviewId: string
  sessionId: string
}

interface FinalizationReceiptInput extends FinalizationRecoveryScope {
  txId: string
  rawTxSha256: string
  rawTxLen: number
}

interface FinalizationSnapshotInput extends FinalizationRecoveryScope {
  txId: string
  snapshotSha256: string
}

export interface FinalizationRepairProof {
  assertAccountSource(binding: SigningIntentBinding): Promise<void>
  verifyProtectedSnapshot(input: {
    network: 'mainnet' | 'testnet'
    walletId: string
    accountId: string
    txId: string
    snapshotSha256: string
  }): Promise<void>
  assertBarrierCleared(input: { network: 'mainnet' | 'testnet'; walletId: string }): Promise<void>
}

function sameBinding(left: SigningIntentBinding, right: SigningIntentBinding): boolean {
  return storageJsonEquals(left, right)
}

async function readStored(): Promise<Journals> {
  const raw: unknown = (await chrome.storage.local.get(MULTISIG_TRANSACTION_STORAGE_KEY))[
    MULTISIG_TRANSACTION_STORAGE_KEY
  ]
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(FAIL)
  const journals: Journals = {}
  const sessions = new Set<string>()
  const reviews = new Set<string>()
  const networkTransactions = new Set<string>()
  const activeAccounts = new Set<string>()
  for (const [key, value] of Object.entries(raw)) {
    if (
      !parseSigningJournalScopeKey(key) ||
      !Array.isArray(value) ||
      value.length > PER_ACCOUNT_LIMIT
    )
      throw new Error(FAIL)
    const records = value.map(parseMultisigTransactionRecord)
    for (const record of records) {
      const binding = record.binding
      const accountKey = JSON.stringify([binding.walletId, binding.accountId])
      const networkTxId = JSON.stringify([binding.network, record.txId])
      if (
        signingJournalScopeKey(binding) !== key ||
        sessions.has(binding.sessionId) ||
        reviews.has(binding.reviewId) ||
        networkTransactions.has(networkTxId) ||
        (isUnresolvedMultisigTransaction(record.phase) && activeAccounts.has(accountKey))
      )
        throw new Error(FAIL)
      sessions.add(binding.sessionId)
      reviews.add(binding.reviewId)
      networkTransactions.add(networkTxId)
      if (isUnresolvedMultisigTransaction(record.phase)) activeAccounts.add(accountKey)
    }
    Object.defineProperty(journals, key, {
      value: records,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return journals
}

async function saveVerified(journals: Journals): Promise<void> {
  await chrome.storage.local.set({ [MULTISIG_TRANSACTION_STORAGE_KEY]: journals })
  const readback: unknown = (await chrome.storage.local.get(MULTISIG_TRANSACTION_STORAGE_KEY))[
    MULTISIG_TRANSACTION_STORAGE_KEY
  ]
  if (!storageJsonEquals(readback, journals))
    throw new Error('Multisig transaction progress could not be saved')
}

async function readRecoveryStored(): Promise<RecoveryJournals> {
  const raw: unknown = (await chrome.storage.local.get(MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY))[
    MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY
  ]
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(FAIL)
  const journals: RecoveryJournals = {}
  const sessions = new Set<string>()
  const reviews = new Set<string>()
  const networkTransactions = new Set<string>()
  for (const [key, value] of Object.entries(raw)) {
    if (
      !parseSigningJournalScopeKey(key) ||
      !Array.isArray(value) ||
      value.length > PER_ACCOUNT_LIMIT
    )
      throw new Error(FAIL)
    const records = value.map(parseFinalizationRecoveryRecord)
    for (const record of records) {
      if (
        signingJournalScopeKey(record.binding) !== key ||
        sessions.has(record.binding.sessionId) ||
        reviews.has(record.binding.reviewId) ||
        (record.txId &&
          networkTransactions.has(JSON.stringify([record.binding.network, record.txId])))
      )
        throw new Error(FAIL)
      sessions.add(record.binding.sessionId)
      reviews.add(record.binding.reviewId)
      if (record.txId)
        networkTransactions.add(JSON.stringify([record.binding.network, record.txId]))
    }
    Object.defineProperty(journals, key, {
      value: records,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return journals
}

async function saveRecoveryVerified(journals: RecoveryJournals): Promise<void> {
  await chrome.storage.local.set({ [MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY]: journals })
  const readback: unknown = (
    await chrome.storage.local.get(MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY)
  )[MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY]
  if (!storageJsonEquals(readback, journals))
    throw new Error('Multisig finalization recovery could not be saved')
}

function sameRecoveryScope(
  record: FinalizationRecoveryRecord,
  scope: FinalizationRecoveryScope
): boolean {
  const binding = record.binding
  return (
    binding.network === scope.network &&
    binding.walletId === scope.walletId &&
    binding.accountId === scope.accountId &&
    binding.reviewId === scope.reviewId &&
    binding.sessionId === scope.sessionId
  )
}

function recoveryFinalized(record: FinalizationRecoveryRecord): FinalizedMultisigTransaction {
  if (
    record.phase !== 'durable_finalization' ||
    !record.txId ||
    !record.rawTxSha256 ||
    !record.rawTxLen ||
    !record.snapshotSha256
  )
    throw new Error(FAIL)
  return parseFinalizedMultisigTransaction({
    binding: record.binding,
    review: record.review,
    txId: record.txId,
    rawTxSha256: record.rawTxSha256,
    rawTxLen: record.rawTxLen,
    snapshotSha256: record.snapshotSha256
  })
}

export function isConfirmedFinalizationRecovery(
  record: FinalizationRecoveryRecord,
  transactions: readonly MultisigTransactionRecord[]
): boolean {
  if (record.phase !== 'durable_finalization') return false
  const finalized = recoveryFinalized(record)
  return transactions.some(
    transaction =>
      transaction.phase === 'confirmed' &&
      storageJsonEquals(transaction.binding, finalized.binding) &&
      transaction.txId === finalized.txId &&
      transaction.rawTxSha256 === finalized.rawTxSha256 &&
      transaction.rawTxLen === finalized.rawTxLen &&
      transaction.snapshotSha256 === finalized.snapshotSha256 &&
      storageJsonEquals(transaction.review, finalized.review)
  )
}

/** Call before asking the Worker to finalize; an existing attempt cannot be restarted. */
export async function prepareFinalizationRecovery(
  input: Pick<FinalizedMultisigTransaction, 'binding' | 'review'>,
  now: number
): Promise<Readonly<FinalizationRecoveryRecord>> {
  if (!exactInput(input, ['binding', 'review'])) throw new Error(FAIL)
  const binding = parseSigningIntentBinding(input.binding)
  const record = parseFinalizationRecoveryRecord({
    version: 1,
    binding,
    review: input.review,
    phase: 'prepared',
    updatedAt: now
  })
  return withUndeletedWalletAccountMetadata(
    binding.walletId,
    binding.accountId,
    binding.network,
    () =>
      withMultisigStorageLock(async () => {
        await assertSignedUnderLock(binding)
        const journals = await readRecoveryStored()
        const transactions = Object.values(await readStored()).flat()
        const all = Object.values(journals).flat()
        if (
          (journals[signingJournalScopeKey(binding)]?.length ?? 0) >= PER_ACCOUNT_LIMIT ||
          all.some(
            previous =>
              previous.binding.sessionId === binding.sessionId ||
              previous.binding.reviewId === binding.reviewId ||
              (previous.binding.walletId === binding.walletId &&
                previous.binding.accountId === binding.accountId &&
                !isConfirmedFinalizationRecovery(previous, transactions))
          ) ||
          transactions.some(
            previous =>
              previous.binding.sessionId === binding.sessionId ||
              previous.binding.reviewId === binding.reviewId ||
              (previous.binding.walletId === binding.walletId &&
                previous.binding.accountId === binding.accountId &&
                isUnresolvedMultisigTransaction(previous.phase))
          )
        )
          throw new Error(FAIL)
        const key = signingJournalScopeKey(binding)
        journals[key] = [...(journals[key] ?? []), record]
        await saveRecoveryVerified(journals)
        return record
      })
  )
}

export function listFinalizationRecovery(): Promise<Readonly<FinalizationRecoveryRecord>[]> {
  return withMultisigStorageLock(async () => Object.values(await readRecoveryStored()).flat())
}

async function advanceRecovery(
  scope: FinalizationRecoveryScope,
  expected: FinalizationRecoveryRecord['phase'],
  next: FinalizationRecoveryRecord['phase'],
  details: Record<string, unknown>,
  now: number,
  verify?: (record: FinalizationRecoveryRecord) => boolean
): Promise<Readonly<FinalizationRecoveryRecord>> {
  return withMultisigStorageLock(async () => {
    const journals = await readRecoveryStored()
    const key = signingJournalScopeKey(scope)
    const records = journals[key]
    const index = records?.findIndex(record => sameRecoveryScope(record, scope)) ?? -1
    const current = records?.[index]
    if (
      !current ||
      current.phase !== expected ||
      !Number.isSafeInteger(now) ||
      now < current.updatedAt ||
      (verify && !verify(current))
    )
      throw new Error(FAIL)
    const nextRecord = parseFinalizationRecoveryRecord({
      ...current,
      ...details,
      phase: next,
      updatedAt: now
    })
    if (!sameRecoveryScope(nextRecord, scope)) throw new Error(FAIL)
    if (
      nextRecord.txId &&
      Object.values(journals)
        .flat()
        .some(
          previous =>
            previous !== current &&
            previous.binding.network === nextRecord.binding.network &&
            previous.txId === nextRecord.txId
        )
    )
      throw new Error(FAIL)
    records[index] = nextRecord
    await saveRecoveryVerified(journals)
    return nextRecord
  })
}

export async function recordFinalizationReceipt(
  input: FinalizationReceiptInput,
  now: number
): Promise<Readonly<FinalizationRecoveryRecord>> {
  if (
    !exactInput(input, [
      'network',
      'walletId',
      'accountId',
      'reviewId',
      'sessionId',
      'txId',
      'rawTxSha256',
      'rawTxLen'
    ])
  )
    throw new Error(FAIL)
  const { txId, rawTxSha256, rawTxLen, ...scope } = input
  return advanceRecovery(scope, 'prepared', 'receipt', { txId, rawTxSha256, rawTxLen }, now)
}

export async function recordProtectedSnapshotVerified(
  input: FinalizationSnapshotInput,
  now: number
): Promise<Readonly<FinalizationRecoveryRecord>> {
  if (
    !exactInput(input, [
      'network',
      'walletId',
      'accountId',
      'reviewId',
      'sessionId',
      'txId',
      'snapshotSha256'
    ])
  )
    throw new Error(FAIL)
  const { txId, snapshotSha256, ...scope } = input
  return advanceRecovery(
    scope,
    'receipt',
    'protected_snapshot_verified',
    { snapshotSha256 },
    now,
    record => record.txId === txId
  )
}

export async function recordDurableFinalization(
  input: FinalizationSnapshotInput,
  now: number
): Promise<Readonly<FinalizationRecoveryRecord>> {
  if (
    !exactInput(input, [
      'network',
      'walletId',
      'accountId',
      'reviewId',
      'sessionId',
      'txId',
      'snapshotSha256'
    ])
  )
    throw new Error(FAIL)
  const { txId, snapshotSha256, ...scope } = input
  return advanceRecovery(
    scope,
    'protected_snapshot_verified',
    'durable_finalization',
    {},
    now,
    record => record.txId === txId && record.snapshotSha256 === snapshotSha256
  )
}

async function assertSignedUnderLock(binding: SigningIntentBinding): Promise<void> {
  const raw: unknown = (await chrome.storage.local.get(MULTISIG_SIGNING_STORAGE_KEY))[
    MULTISIG_SIGNING_STORAGE_KEY
  ]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(FAIL)
  const scoped: unknown = (raw as Record<string, unknown>)[signingJournalScopeKey(binding)]
  if (!scoped || typeof scoped !== 'object' || Array.isArray(scoped)) throw new Error(FAIL)
  const records: unknown = (scoped as Record<string, unknown>).records
  if (!Array.isArray(records)) throw new Error(FAIL)
  const matches = records
    .map(parseSigningIntent)
    .filter(intent => intent.sessionId === binding.sessionId)
  if (
    matches.length !== 1 ||
    matches[0].phase !== 'signed' ||
    matches[0].noncePhase !== 'consumed' ||
    !sameBinding(signingIntentBinding(matches[0]), binding)
  )
    throw new Error(FAIL)
}

/** Metadata only. The caller must read back the exact protected DB snapshot before recording. */
export function createMultisigTransactionJournal() {
  const ownedFinalizations = new Set<string>()
  const ownershipKey = (binding: SigningIntentBinding, txId: string) =>
    JSON.stringify([binding.network, binding.walletId, binding.accountId, binding.reviewId, txId])
  async function update(
    input: SigningIntentBinding,
    txId: string,
    expected: readonly MultisigTransactionPhase[],
    next: MultisigTransactionPhase,
    now: number
  ): Promise<Readonly<MultisigTransactionRecord>> {
    const binding = parseSigningIntentBinding(input)
    return withUndeletedWalletAccountMetadata(
      binding.walletId,
      binding.accountId,
      binding.network,
      () =>
        withMultisigStorageLock(async () => {
          const journals = await readStored()
          const key = signingJournalScopeKey(binding)
          const records = journals[key]
          const index = records?.findIndex(record => record.txId === txId) ?? -1
          const current = records?.[index]
          if (
            !current ||
            !sameBinding(current.binding, binding) ||
            !expected.includes(current.phase)
          )
            throw new Error(FAIL)
          const advanced = advanceMultisigTransaction(current, next, now)
          records[index] = advanced
          await saveVerified(journals)
          return advanced
        })
    )
  }

  return {
    async recordFinalized(
      input: FinalizedMultisigTransaction,
      now: number
    ): Promise<Readonly<MultisigTransactionRecord>> {
      const finalized = parseFinalizedMultisigTransaction(input)
      const binding = finalized.binding
      const record = parseMultisigTransactionRecord({
        ...finalized,
        version: 2,
        phase: 'finalized',
        updatedAt: now
      })
      return withUndeletedWalletAccountMetadata(
        binding.walletId,
        binding.accountId,
        binding.network,
        () =>
          withMultisigStorageLock(async () => {
            await assertSignedUnderLock(binding)
            const journals = await readStored()
            const recovery = (await readRecoveryStored())[signingJournalScopeKey(binding)]?.find(
              previous => previous.binding.reviewId === binding.reviewId
            )
            if (recovery && !storageJsonEquals(recoveryFinalized(recovery), finalized))
              throw new Error(FAIL)
            const accountKey = JSON.stringify([binding.walletId, binding.accountId])
            const networkTxId = JSON.stringify([binding.network, finalized.txId])
            const all = Object.values(journals).flat()
            const key = signingJournalScopeKey(binding)
            if (
              (journals[key]?.length ?? 0) >= PER_ACCOUNT_LIMIT ||
              all.some(
                previous =>
                  previous.binding.sessionId === binding.sessionId ||
                  previous.binding.reviewId === binding.reviewId ||
                  JSON.stringify([previous.binding.network, previous.txId]) === networkTxId ||
                  (JSON.stringify([previous.binding.walletId, previous.binding.accountId]) ===
                    accountKey &&
                    isUnresolvedMultisigTransaction(previous.phase))
              )
            )
              throw new Error(FAIL)
            journals[key] = [...(journals[key] ?? []), record]
            await saveVerified(journals)
            ownedFinalizations.add(ownershipKey(binding, finalized.txId))
            return record
          })
      )
    },
    async repairDurableFinalization(
      input: SigningIntentBinding,
      txId: string,
      now: number,
      proof: FinalizationRepairProof
    ): Promise<Readonly<MultisigTransactionRecord>> {
      const binding = parseSigningIntentBinding(input)
      if (
        !/^[0-9a-f]{64}$/.test(txId) ||
        !proof ||
        typeof proof.assertAccountSource !== 'function' ||
        typeof proof.verifyProtectedSnapshot !== 'function' ||
        typeof proof.assertBarrierCleared !== 'function'
      )
        throw new Error(FAIL)
      return withUndeletedWalletAccountMetadata(
        binding.walletId,
        binding.accountId,
        binding.network,
        () =>
          withMultisigStorageLock(async () => {
            const recovery = (await readRecoveryStored())[signingJournalScopeKey(binding)]?.find(
              previous => previous.binding.reviewId === binding.reviewId
            )
            if (
              !recovery ||
              !sameBinding(recovery.binding, binding) ||
              recovery.phase !== 'durable_finalization' ||
              recovery.txId !== txId ||
              !Number.isSafeInteger(now) ||
              now < recovery.updatedAt
            )
              throw new Error(FAIL)
            const finalized = recoveryFinalized(recovery)
            await proof.assertAccountSource(binding)
            await proof.verifyProtectedSnapshot({
              network: binding.network,
              walletId: binding.walletId,
              accountId: binding.accountId,
              txId,
              snapshotSha256: finalized.snapshotSha256
            })
            await proof.assertBarrierCleared({
              network: binding.network,
              walletId: binding.walletId
            })
            const journals = await readStored()
            const all = Object.values(journals).flat()
            const existing = all.find(previous => previous.binding.reviewId === binding.reviewId)
            if (existing) {
              if (
                !sameBinding(existing.binding, binding) ||
                !storageJsonEquals(
                  {
                    binding: existing.binding,
                    review: existing.review,
                    txId: existing.txId,
                    rawTxSha256: existing.rawTxSha256,
                    rawTxLen: existing.rawTxLen,
                    snapshotSha256: existing.snapshotSha256
                  },
                  finalized
                )
              )
                throw new Error(FAIL)
              return existing
            }
            await assertSignedUnderLock(binding)
            if (
              all.some(
                previous =>
                  previous.binding.sessionId === binding.sessionId ||
                  (previous.binding.walletId === binding.walletId &&
                    previous.binding.accountId === binding.accountId &&
                    isUnresolvedMultisigTransaction(previous.phase)) ||
                  (previous.binding.network === binding.network && previous.txId === txId)
              )
            )
              throw new Error(FAIL)
            const record = parseMultisigTransactionRecord({
              ...finalized,
              version: 2,
              phase: 'finalized',
              updatedAt: now
            })
            const key = signingJournalScopeKey(binding)
            if ((journals[key]?.length ?? 0) >= PER_ACCOUNT_LIMIT) throw new Error(FAIL)
            journals[key] = [...(journals[key] ?? []), record]
            await saveVerified(journals)
            return record
          })
      )
    },
    readTransaction(
      input: SigningIntentBinding,
      txId: string
    ): Promise<Readonly<MultisigTransactionRecord> | null> {
      const binding = parseSigningIntentBinding(input)
      return withMultisigStorageLock(async () => {
        const record = (await readStored())[signingJournalScopeKey(binding)]?.find(
          previous => previous.txId === txId
        )
        if (record && !sameBinding(record.binding, binding)) throw new Error(FAIL)
        return record ?? null
      })
    },
    listTransactions(): Promise<Readonly<MultisigTransactionRecord>[]> {
      return withMultisigStorageLock(async () => Object.values(await readStored()).flat())
    },
    /** Persist uncertainty before calling the network; never repeat this operation to resend. */
    async beginSubmission(input: SigningIntentBinding, txId: string, now: number) {
      const binding = parseSigningIntentBinding(input)
      const key = ownershipKey(binding, txId)
      if (!ownedFinalizations.has(key)) throw new Error(FAIL)
      const record = await update(binding, txId, ['finalized'], 'submission_unknown', now)
      ownedFinalizations.delete(key)
      return record
    },
    recordBroadcast(input: SigningIntentBinding, txId: string, now: number) {
      return update(input, txId, ['submission_unknown'], 'broadcast', now)
    },
    recordConfirmed(input: SigningIntentBinding, txId: string, now: number) {
      return update(input, txId, ['submission_unknown', 'broadcast'], 'confirmed', now)
    },
    /** A restarted finalized row was not sent; it still needs explicit recovery before release. */
    recoverPending(): Promise<Readonly<MultisigTransactionRecord>[]> {
      ownedFinalizations.clear()
      return withMultisigStorageLock(async () =>
        Object.values(await readStored())
          .flat()
          .filter(record => isUnresolvedMultisigTransaction(record.phase))
      )
    }
  }
}
export type MultisigTransactionJournal = ReturnType<typeof createMultisigTransactionJournal>
