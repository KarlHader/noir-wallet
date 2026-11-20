import { parseFinalizedMultisigTransaction } from '@/core/multisig/transaction-journal'
import { parseEnvelope } from '@/core/multisig/messages'
import { storageJsonEquals } from '@/lib/storage-json-equality'
import type { MultisigTransactionRecord } from '@/core/multisig/transaction-journal'
import type { FinalizedMultisigTransaction } from '@/core/multisig/transaction-journal'
import type { SigningIntentBinding } from '@/core/multisig/signing-journal'
import type { SigningWorkerMethod } from '@/core/multisig/signing-worker-rpc'
import type { VaultSendTransaction } from '@/core/multisig/send-rpc'
import {
  prepareFinalizationRecovery,
  type MultisigTransactionJournal
} from '@/lib/multisig-transaction-storage'
import type { SigningJournal } from '@/lib/multisig-signing-storage'

const FAIL = 'Multisig transaction is unavailable. Check this account before trying again.'

export function projectMultisigTransaction(
  record: MultisigTransactionRecord
): VaultSendTransaction {
  const {
    threshold: _threshold,
    transport: _transport,
    createdAt: _createdAt,
    ...binding
  } = record.binding
  return {
    binding: { ...binding, selectedSlots: [...binding.selectedSlots] },
    phase: record.phase,
    txId: record.txId,
    outbound: [],
    ...(record.review
      ? {
          summary: {
            recipient: record.review.recipient,
            amount: record.review.amount,
            memo: record.review.memo,
            fee: record.review.fee
          }
        }
      : {})
  }
}

/** Disk durability is acknowledged by Offscreen; pages never supply finalization receipts. */
export function createMultisigTransactionController(deps: {
  journal: SigningJournal
  transactions: MultisigTransactionJournal
  authorize(binding: SigningIntentBinding): Promise<void>
  forwardToWorker(
    method: SigningWorkerMethod,
    payload: Readonly<Record<string, unknown>>
  ): Promise<unknown>
  now(): number
  onChanged?(record: Readonly<MultisigTransactionRecord>): void
}) {
  const attemptedFinalizations = new Set<string>()
  const knownBroadcasts = new Map<string, VaultSendTransaction>()
  const reference = (binding: SigningIntentBinding) => ({
    walletId: binding.walletId,
    reviewId: binding.reviewId,
    sessionId: binding.sessionId
  })
  async function read(
    binding: SigningIntentBinding
  ): Promise<Readonly<MultisigTransactionRecord> | null> {
    const matches = (await deps.transactions.listTransactions()).filter(
      record => record.binding.reviewId === binding.reviewId
    )
    if (matches.length > 1 || (matches[0] && !storageJsonEquals(matches[0].binding, binding)))
      throw new Error(FAIL)
    return matches[0] ?? null
  }
  return {
    async finalize(
      binding: SigningIntentBinding,
      review: FinalizedMultisigTransaction['review']
    ): Promise<VaultSendTransaction> {
      await deps.authorize(binding)
      const previous = await read(binding)
      if (previous) return projectMultisigTransaction(previous)
      const signed = await deps.journal.readSigningIntent(binding)
      if (
        signed?.phase !== 'signed' ||
        signed.noncePhase !== 'consumed' ||
        attemptedFinalizations.has(binding.reviewId)
      )
        throw new Error(FAIL)
      // Even a rejected/late receipt may follow a memory-DB mutation. Never re-finalize it.
      attemptedFinalizations.add(binding.reviewId)
      await prepareFinalizationRecovery({ binding, review }, deps.now())
      await deps.authorize(binding)
      const response = await deps.forwardToWorker('vault.sign.worker.finalize', {
        ...reference(binding),
        accountId: binding.accountId
      })
      if (!response || typeof response !== 'object' || Array.isArray(response))
        throw new Error(FAIL)
      const receipt = response as Record<string, unknown>
      const keys = ['txId', 'rawTxSha256', 'rawTxLen', 'network', 'accountId', 'snapshotSha256']
      if (
        Object.keys(receipt).length !== keys.length ||
        keys.some(key => !(key in receipt)) ||
        receipt.network !== binding.network ||
        receipt.accountId !== binding.accountId
      )
        throw new Error(FAIL)
      const finalized = parseFinalizedMultisigTransaction({
        binding,
        txId: receipt.txId,
        rawTxSha256: receipt.rawTxSha256,
        rawTxLen: receipt.rawTxLen,
        snapshotSha256: receipt.snapshotSha256,
        review
      })
      await deps.authorize(binding)
      const stored = await deps.transactions.recordFinalized(finalized, deps.now())
      await deps.authorize(binding)
      return projectMultisigTransaction(stored)
    },
    async submit(binding: SigningIntentBinding): Promise<VaultSendTransaction> {
      await deps.authorize(binding)
      const stored = await read(binding)
      if (!stored) throw new Error(FAIL)
      if (stored.phase === 'confirmed') return projectMultisigTransaction(stored)
      if (stored.phase !== 'finalized')
        return knownBroadcasts.get(binding.reviewId) ?? projectMultisigTransaction(stored)
      // A lost response from here on is uncertainty, including a failure before dispatch.
      const pending = await deps.transactions.beginSubmission(binding, stored.txId, deps.now())
      deps.onChanged?.(pending)
      await deps.authorize(binding)
      let response: unknown
      try {
        response = await deps.forwardToWorker('vault.sign.worker.submit', {
          ...reference(binding),
          accountId: binding.accountId,
          network: binding.network,
          txId: stored.txId,
          rawTxSha256: stored.rawTxSha256,
          rawTxLen: stored.rawTxLen,
          snapshotSha256: stored.snapshotSha256
        })
      } catch {
        await deps.authorize(binding)
        return projectMultisigTransaction(pending)
      }
      await deps.authorize(binding)
      const reply = response as { phase?: unknown; txId?: unknown; outbound?: unknown }
      if (
        !reply ||
        reply.phase !== 'broadcast' ||
        reply.txId !== stored.txId ||
        !Array.isArray(reply.outbound)
      )
        return projectMultisigTransaction(pending)
      const outbound = reply.outbound.map(parseEnvelope)
      if (
        outbound.some(
          envelope =>
            !envelope ||
            envelope.message_type !== 'SIGN_RESULT' ||
            envelope.group_id !== binding.groupId ||
            envelope.session_id !== binding.sessionId ||
            envelope.sender_id !== 'device-1' ||
            !binding.selectedSlots.some(
              slot => slot !== 0 && envelope.recipient_id === `device-${slot + 1}`
            )
        )
      )
        return projectMultisigTransaction(pending)
      const result: VaultSendTransaction = {
        ...projectMultisigTransaction(pending),
        phase: 'broadcast',
        outbound: outbound as VaultSendTransaction['outbound']
      }
      knownBroadcasts.set(binding.reviewId, result)
      // Local bookkeeping cannot undo a node's acknowledged acceptance.
      const recorded = await deps.transactions
        .recordBroadcast(binding, stored.txId, deps.now())
        .catch(() => null)
      deps.onChanged?.(recorded ?? { ...pending, phase: 'broadcast' })
      return result
    }
  }
}
