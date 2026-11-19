import {
  isUnresolvedMultisigTransaction,
  parseFinalizationRecoveryRecord,
  parseMultisigTransactionRecord
} from '@/core/multisig/transaction-journal'
import {
  parseSigningJournalScopeKey,
  signingJournalScopeKey
} from '@/core/multisig/signing-journal'
import { parseSigningIntent, signingIntentBinding } from '@/core/multisig/signing-journal'
import { storageJsonEquals } from './storage-json-equality'
import { hasFinalizationBarrier } from './multisig-finalization-barrier'

export const MULTISIG_TRANSACTION_STORAGE_KEY = 'multisig_transactions_v1'
export const MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY = 'multisig_finalization_recovery_v1'

/** Call only after the unresolved guard, while its multisig lock is still held. */
export async function deleteResolvedFinalizationRecoveryLocked(
  matches: (walletId: string, accountId: string) => boolean
): Promise<void> {
  const raw: unknown = (await chrome.storage.local.get(MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY))[
    MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY
  ]
  if (raw === undefined) return
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Multisig finalization recovery is unavailable')
  const kept: Record<string, unknown[]> = {}
  let changed = false
  for (const [key, rows] of Object.entries(raw)) {
    if (!parseSigningJournalScopeKey(key) || !Array.isArray(rows))
      throw new Error('Multisig finalization recovery is unavailable')
    const retained = rows.filter(row => {
      const record = parseFinalizationRecoveryRecord(row)
      if (signingJournalScopeKey(record.binding) !== key)
        throw new Error('Multisig finalization recovery is unavailable')
      return !matches(record.binding.walletId, record.binding.accountId)
    })
    if (retained.length !== rows.length) changed = true
    if (retained.length)
      Object.defineProperty(kept, key, {
        value: retained,
        enumerable: true,
        configurable: true,
        writable: true
      })
  }
  if (!changed) return
  await chrome.storage.local.set({ [MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY]: kept })
  const readback: unknown = (
    await chrome.storage.local.get(MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY)
  )[MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY]
  if (!storageJsonEquals(readback, kept))
    throw new Error('Multisig finalization recovery could not be cleared')
}

/** Call while holding the multisig storage lock; malformed records block deletion. */
export async function assertNoUnresolvedMultisigTransactionsLocked(
  matches: (walletId: string, accountId: string) => boolean,
  walletIds: readonly string[] = []
): Promise<void> {
  const barrierScopes = new Map<string, { network: 'mainnet' | 'testnet'; walletId: string }>()
  const relevant = (walletId: string, accountId: string) =>
    walletIds.includes(walletId) || matches(walletId, accountId)
  const trackBarrier = (network: 'mainnet' | 'testnet', walletId: string) => {
    barrierScopes.set(JSON.stringify([network, walletId]), { network, walletId })
  }
  for (const walletId of walletIds)
    for (const network of ['mainnet', 'testnet'] as const) trackBarrier(network, walletId)
  const saved = await chrome.storage.local.get([
    MULTISIG_TRANSACTION_STORAGE_KEY,
    MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY,
    'multisig_signing_v1'
  ])
  const stored: unknown = saved[MULTISIG_TRANSACTION_STORAGE_KEY]
  if (stored !== undefined && (!stored || typeof stored !== 'object' || Array.isArray(stored)))
    throw new Error('Multisig transaction records are unavailable')
  const confirmed = []
  for (const [key, rows] of Object.entries(stored ?? {})) {
    if (!parseSigningJournalScopeKey(key) || !Array.isArray(rows))
      throw new Error('Multisig transaction records are unavailable')
    for (const row of rows) {
      const record = parseMultisigTransactionRecord(row)
      if (signingJournalScopeKey(record.binding) !== key)
        throw new Error('Multisig transaction records are unavailable')
      if (relevant(record.binding.walletId, record.binding.accountId))
        trackBarrier(record.binding.network, record.binding.walletId)
      if (
        isUnresolvedMultisigTransaction(record.phase) &&
        relevant(record.binding.walletId, record.binding.accountId)
      )
        throw new Error('Resolve pending multisig transactions before deleting this account')
      if (record.phase === 'confirmed') confirmed.push(record)
    }
  }
  const recovery: unknown = saved[MULTISIG_FINALIZATION_RECOVERY_STORAGE_KEY]
  if (
    recovery !== undefined &&
    (!recovery || typeof recovery !== 'object' || Array.isArray(recovery))
  )
    throw new Error('Multisig finalization recovery is unavailable')
  for (const [key, rows] of Object.entries(recovery ?? {})) {
    if (!parseSigningJournalScopeKey(key) || !Array.isArray(rows))
      throw new Error('Multisig finalization recovery is unavailable')
    for (const row of rows) {
      const record = parseFinalizationRecoveryRecord(row)
      if (signingJournalScopeKey(record.binding) !== key)
        throw new Error('Multisig finalization recovery is unavailable')
      if (relevant(record.binding.walletId, record.binding.accountId))
        trackBarrier(record.binding.network, record.binding.walletId)
      if (!relevant(record.binding.walletId, record.binding.accountId)) continue
      const settled =
        record.phase === 'durable_finalization' &&
        confirmed.some(
          transaction =>
            storageJsonEquals(transaction.binding, record.binding) &&
            transaction.txId === record.txId &&
            transaction.rawTxSha256 === record.rawTxSha256 &&
            transaction.rawTxLen === record.rawTxLen &&
            transaction.snapshotSha256 === record.snapshotSha256 &&
            storageJsonEquals(transaction.review, record.review)
        )
      if (!settled)
        throw new Error('Resolve pending multisig finalization before deleting this account')
    }
  }
  const signing: unknown = saved.multisig_signing_v1
  if (signing !== undefined && (!signing || typeof signing !== 'object' || Array.isArray(signing)))
    throw new Error('Multisig signing records are unavailable')
  for (const [key, account] of Object.entries(signing ?? {})) {
    if (
      !parseSigningJournalScopeKey(key) ||
      !account ||
      typeof account !== 'object' ||
      Array.isArray(account) ||
      !Array.isArray((account as { records?: unknown }).records)
    )
      throw new Error('Multisig signing records are unavailable')
    for (const raw of (account as { records: unknown[] }).records) {
      const intent = parseSigningIntent(raw)
      if (signingJournalScopeKey(intent) !== key)
        throw new Error('Multisig signing records are unavailable')
      if (relevant(intent.walletId, intent.accountId)) trackBarrier(intent.network, intent.walletId)
      if (
        intent.phase === 'signed' &&
        relevant(intent.walletId, intent.accountId) &&
        !confirmed.some(record => storageJsonEquals(record.binding, signingIntentBinding(intent)))
      )
        throw new Error('Resolve signed multisig transaction before deleting this account')
    }
  }
  for (const scope of barrierScopes.values())
    if (await hasFinalizationBarrier(scope))
      throw new Error('Resolve pending multisig finalization before deleting this account')
}
