import { useCallback, useEffect, useRef, useState } from 'react'
import {
  executeMultisigSend,
  listMultisigSendTransactions
} from '@/popup/services/multisig-send-client'
import { mergeMultisigSendTransactions } from './send-model'
import type {
  VaultSendAuthority,
  VaultSendReview,
  VaultSendTransaction
} from '@/core/multisig/send-rpc'

type SubmissionView = 'signed' | 'executing' | 'notifying' | 'checking' | 'result' | 'recovery'

/** One user command authorizes Background's durable finalize-and-submit sequence. */
export function useMultisigSendSubmission(
  review: VaultSendReview,
  authority: VaultSendAuthority,
  notifyPhones: (transaction: VaultSendTransaction) => Promise<void>
) {
  const [view, setView] = useState<SubmissionView>('signed')
  const [transaction, setTransaction] = useState<VaultSendTransaction | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const hasAttemptedSend = useRef(false)
  const hasSendStarted = useCallback(() => hasAttemptedSend.current, [])
  const hasPhoneNotificationFailed = useRef(false)
  const isMounted = useRef(true)
  const currentTransaction = useRef<VaultSendTransaction | null>(null)
  const binding = review.binding
  const scope = {
    walletId: binding.walletId,
    accountId: binding.accountId,
    network: binding.network
  }

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const accept = useCallback(
    (next: VaultSendTransaction): void => {
      if (
        next.binding.reviewId !== binding.reviewId ||
        next.binding.sessionId !== binding.sessionId ||
        next.binding.pcztDigest !== binding.pcztDigest ||
        next.binding.groupId !== binding.groupId ||
        JSON.stringify(next.binding.selectedSlots) !== JSON.stringify(binding.selectedSlots)
      )
        throw new Error('Transaction does not match the signed review')
      const merged = mergeMultisigSendTransactions(
        currentTransaction.current ? [currentTransaction.current] : [],
        [next],
        scope
      )[0]
      currentTransaction.current = merged
      if (isMounted.current) {
        setTransaction(merged)
        setView('result')
      }
    },
    [binding, scope.accountId, scope.network, scope.walletId]
  )

  const checkStatus = useCallback(
    async (isManual = false) => {
      if (isMounted.current && isManual) setView('checking')
      try {
        const transactions = await listMultisigSendTransactions(scope)
        if (!isMounted.current) return
        const matches = transactions.filter(value => value.binding.reviewId === binding.reviewId)
        if (matches.length !== 1) {
          setView('recovery')
          setNotice('The signed transaction needs checking. Do not sign or submit another payment.')
          return
        }
        accept(matches[0])
        if (matches[0].phase === 'broadcast' || matches[0].phase === 'confirmed') {
          setNotice(
            hasPhoneNotificationFailed.current
              ? 'Broadcast was accepted, but the phone did not receive the result.'
              : null
          )
        }
      } catch {
        if (!isMounted.current) return
        setView(currentTransaction.current ? 'result' : 'recovery')
        setNotice('Transaction status could not be read. Do not sign or submit another payment.')
      }
    },
    [accept, binding.reviewId, scope.accountId, scope.network, scope.walletId]
  )

  const sendTransfer = useCallback(async () => {
    if (hasAttemptedSend.current || !isMounted.current) return
    hasAttemptedSend.current = true
    setView('executing')
    setNotice(null)
    try {
      const submitted = await executeMultisigSend(authority)
      if (!isMounted.current) return
      accept(submitted)
      if (submitted.phase === 'broadcast' && submitted.outbound.length) {
        setView('notifying')
        try {
          await notifyPhones(submitted)
        } catch {
          hasPhoneNotificationFailed.current = true
          if (isMounted.current)
            setNotice('Broadcast was accepted, but the phone did not receive the result.')
        } finally {
          if (isMounted.current) setView('result')
        }
      } else if (
        (submitted.phase === 'finalized' || submitted.phase === 'submission_unknown') &&
        isMounted.current
      ) {
        setNotice('Submission is not confirmed. Check status before any other payment.')
      }
    } catch {
      if (isMounted.current)
        setNotice('Submission returned no reliable result. Check status before any other payment.')
      await checkStatus(true)
    }
  }, [accept, authority, checkStatus, notifyPhones])

  useEffect(() => {
    if (!transaction || transaction.phase === 'confirmed' || view !== 'result') return
    const timer = window.setInterval(() => void checkStatus(), 15_000)
    return () => window.clearInterval(timer)
  }, [checkStatus, transaction, view])

  return { view, transaction, notice, sendTransfer, checkStatus, hasSendStarted }
}
