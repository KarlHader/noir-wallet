import { useEffect, useRef, type RefObject } from 'react'
import type { SwapApprovalContinuation } from '@/background/swap-approval-continuation'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { RheaSwapQuoteView } from '@/core/services/rhea-swap'
import { isRheaSwapQuoteFresh } from '@/core/services/rhea-swap/rhea-swap-quote-validity'
import { parseTransactionId, type TransactionGraph } from '@/core/transactions/domain'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import type { QuoteDepositExecutionMode } from '@/popup/services/quote-deposit-transfer-client'
import { getRheaSwapErrorMessage } from '@/popup/services/rhea-swap-client'
import { swapApprovalContinuationClient } from '@/popup/services/swap-approval-continuation-client'

export interface SubmittedSwapApproval {
  readonly graph: TransactionGraph
  readonly awaitingHardwareSignature?: boolean
  readonly token: string
  readonly spender: string
  readonly amountRaw: string
  readonly owner: string
  readonly executionMode: QuoteDepositExecutionMode
}

interface ApprovalIntent {
  readonly sourceAssetId?: string
  readonly destinationAssetId?: string
  readonly amountIn: string
  readonly recipientAddress: string | null | undefined
  readonly sourceMode: QuoteDepositExecutionMode
  readonly destinationMode: QuoteDepositExecutionMode
}

function getApprovalAllowance(chainId: string, approval: SubmittedSwapApproval): Promise<string> {
  return evmWalletClient.getTokenAllowance(
    chainId,
    approval.token,
    approval.spender,
    approval.owner,
    approval.executionMode
  )
}

export function useSwapApprovalContinuation({
  phase,
  approval,
  continuation,
  walletId,
  accountId,
  intent,
  requestKey,
  quote,
  quoteKey,
  preparing,
  sequence,
  onPreparing,
  onError,
  onReady
}: {
  readonly phase: 'input' | 'review' | 'approval-pending'
  readonly approval: SubmittedSwapApproval | null
  readonly continuation: SwapApprovalContinuation | undefined
  readonly walletId: string | null
  readonly accountId: string | null
  readonly intent: ApprovalIntent
  readonly requestKey: string | undefined
  readonly quote: RheaSwapQuoteView | null
  readonly quoteKey: string | null
  readonly preparing: RefObject<boolean>
  readonly sequence: RefObject<number>
  readonly onPreparing: (value: boolean) => void
  readonly onError: (error: string | null) => void
  readonly onReady: (result: {
    readonly restoredQuote: RheaSwapQuoteView | null
    readonly reuseApprovedQuote: boolean
  }) => void
}) {
  const completedApprovalId = useRef<string | null>(null)
  const origin = approval?.graph.segments.find(segment => segment.role === 'origin')
  const chainId = origin?.target.kind === 'onchain' ? origin.target.chainId : null

  const continueAfterApproval = async () => {
    if (!approval || !chainId || !requestKey || preparing.current) return
    preparing.current = true
    onPreparing(true)
    onError(null)
    const requestSequence = ++sequence.current
    try {
      if (
        continuation &&
        (continuation.transactionId !== approval.graph.root.id ||
          continuation.sourceAssetId !== intent.sourceAssetId ||
          continuation.destinationAssetId !== intent.destinationAssetId ||
          continuation.amountIn !== intent.amountIn ||
          continuation.recipientAddress !== intent.recipientAddress ||
          continuation.sourceMode !== intent.sourceMode ||
          continuation.destinationMode !== intent.destinationMode)
      ) {
        throw new Error('Swap details changed. Start a new Swap.')
      }
      const resumed = continuation
        ? await swapApprovalContinuationClient.continue(continuation.transactionId)
        : null
      if (resumed?.status === 'pending') return 'pending'
      const allowance =
        resumed?.approval.amountRaw ?? (await getApprovalAllowance(chainId, approval))
      if (requestSequence !== sequence.current) return
      if (BigInt(allowance) < BigInt(approval.amountRaw)) return 'pending'
      if (continuation) completedApprovalId.current = continuation.transactionId
      const restoredQuote =
        resumed?.quote &&
        continuation?.quoteHandle === resumed.quote.quoteHandle &&
        continuation.quoteRequestKey === requestKey &&
        resumed.quote.recipient.toLowerCase() === intent.recipientAddress?.toLowerCase() &&
        isRheaSwapQuoteFresh(resumed.quote) &&
        intent.destinationAssetId
          ? resumed.quote
          : null
      onReady({
        restoredQuote,
        reuseApprovedQuote:
          restoredQuote !== null ||
          (quote !== null && quoteKey === requestKey && isRheaSwapQuoteFresh(quote))
      })
    } catch (error) {
      if (requestSequence === sequence.current) onError(getRheaSwapErrorMessage(error))
    } finally {
      preparing.current = false
      onPreparing(false)
    }
  }

  const continueRef = useRef(continueAfterApproval)
  continueRef.current = continueAfterApproval

  useEffect(() => {
    if (phase !== 'approval-pending' || !approval || !walletId || !accountId || !chainId) return
    let active = true
    let timer: number | undefined
    const poll = async () => {
      if (!active) return
      if (preparing.current) {
        timer = window.setTimeout(poll, 2_000)
        return
      }
      try {
        const graph = await new IndexedDbTransactionRepository().get(
          { keyDomainId: parseKeyDomainId(walletId), accountId: parseAccountId(accountId) },
          parseTransactionId(approval.graph.root.id)
        )
        if (!active) return
        if (graph?.root.status === 'failed') {
          onError('Token approval failed. Start a new Swap.')
          return
        }
        if (graph?.root.status !== 'final') {
          timer = window.setTimeout(poll, 2_000)
          return
        }
        const allowance = await getApprovalAllowance(chainId, approval)
        if (!active) return
        if (BigInt(allowance) < BigInt(approval.amountRaw)) {
          timer = window.setTimeout(poll, 2_000)
          return
        }
        const result = await continueRef.current()
        if (active && result === 'pending') timer = window.setTimeout(poll, 2_000)
      } catch {
        if (active) timer = window.setTimeout(poll, 2_000)
      }
    }
    void poll()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [phase, approval, walletId, accountId, chainId, preparing, requestKey, onError])

  useEffect(() => {
    if (phase !== 'review' || !completedApprovalId.current) return
    const transactionId = completedApprovalId.current
    completedApprovalId.current = null
    void swapApprovalContinuationClient.clear(transactionId).catch(() => {})
  }, [phase])

  return continueAfterApproval
}
