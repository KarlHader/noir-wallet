import { create } from 'zustand'
import type { TransactionStep } from '@/popup/hooks/useTransaction'
import type { SwapStatus } from '@/core/services/intents-api'
import { mergeSwapProgressStatus } from '@/lib/swap-progress'
import type { CreateAddressBookContactInput } from '@/core/address-book/address-book'
import type {
  ConfidentialFundingPhase,
  ConfidentialFundingProgress
} from '@/core/services/confidential-funding'

interface ZcashTransactionResult {
  type: 'zcash'
  step: TransactionStep
  amount: string
  fromAddress?: string
  toAddress?: string
  txHash?: string
  error?: string | null
  accountKey?: string
  transactionId?: string
  timestamp?: number
  customTitle?: string
  customDescription?: string
  showFrom?: boolean
  showTo?: boolean
  showTxHash?: boolean
  showTime?: boolean
  extraDetails?: Array<{ label: string; value: string }>
  saveRecipient?: CreateAddressBookContactInput & { readonly selfTransfer?: boolean }
}

interface SwapTransactionResult {
  type: 'swap'
  depositAddress: string
  status: SwapStatus | null
  tokenInSymbol: string
  tokenOutSymbol: string
  amountIn: string
  amountOut: string
  actionName?: string
  destinationAsset?: string
  destinationChain?: string
  originChain?: string
  originTxHash?: string
  activityTransactionId?: string
  zcashAccountKey?: string
  zcashTransactionId?: string
  signedOrder?: boolean
  sourceExecutionMode?: 'main' | 'private'
  rheaQuoteHandle?: string
  approvalRequestIdAfterFunding?: string
  confidentialFunding?: Readonly<{
    planId: string
    phase: ConfidentialFundingPhase
    completed: number
    total: number
    stage: ConfidentialFundingProgress['stage']
    message: string
  }>
  /** ZEC fee paid for the on-chain leg, when known (e.g. Supply). */
  fee?: string
}

export type TransactionResultData = ZcashTransactionResult | SwapTransactionResult

interface TransactionResultStore {
  data: TransactionResultData | null
  returnPath: string
  setResult: (data: TransactionResultData, returnPath?: string) => void
  updateStep: (
    step: TransactionStep,
    updates?: Partial<ZcashTransactionResult>,
    accountKey?: string,
    transactionId?: string
  ) => void
  updateSwapStatus: (status: SwapStatus) => void
  updateSwapOriginTransaction: (
    chain: string,
    txHash: string | undefined,
    transaction?: { accountKey: string; transactionId: string },
    quoteHandle?: string
  ) => void
  updateConfidentialFunding: (input: {
    phase: ConfidentialFundingPhase
    completed: number
    total: number
    stage: ConfidentialFundingProgress['stage']
    message: string
    status: SwapStatus
  }) => void
  clear: () => void
}

export const useTransactionResultStore = create<TransactionResultStore>()((set, get) => ({
  data: null,
  returnPath: '/',

  setResult: (data, returnPath = '/') => {
    set({ data, returnPath })
  },

  updateStep: (step, updates, accountKey, transactionId) => {
    const current = get().data
    if (!current || current.type !== 'zcash') return
    if (accountKey && current.accountKey !== accountKey) return
    if (transactionId && current.transactionId !== transactionId) return
    if ((current.step === 'success' || current.step === 'failed') && step !== current.step) return
    if ((current.step === 'submitted' || current.step === 'confirming') && step === 'pending')
      return
    if (current.step === 'confirming' && step === 'submitted') return
    set({
      data: { ...current, step, ...updates }
    })
  },

  updateSwapStatus: status => {
    const current = get().data
    if (!current || current.type !== 'swap') return
    const merged = mergeSwapProgressStatus(current.status, status)
    if (merged !== current.status) set({ data: { ...current, status: merged } })
  },

  updateSwapOriginTransaction: (chain, txHash, transaction, quoteHandle) => {
    const current = get().data
    if (!current || current.type !== 'swap') return
    if (quoteHandle && current.rheaQuoteHandle !== quoteHandle) return
    set({
      data: {
        ...current,
        originChain: chain,
        ...(txHash ? { originTxHash: txHash } : {}),
        ...(transaction
          ? {
              zcashAccountKey: transaction.accountKey,
              zcashTransactionId: transaction.transactionId
            }
          : {})
      }
    })
  },

  updateConfidentialFunding: input => {
    const current = get().data
    if (!current || current.type !== 'swap' || !current.confidentialFunding) return
    set({
      data: {
        ...current,
        status: input.status,
        confidentialFunding: {
          ...current.confidentialFunding,
          phase: input.phase,
          completed: input.completed,
          total: input.total,
          stage: input.stage,
          message: input.message
        }
      }
    })
  },

  clear: () => {
    set({ data: null, returnPath: '/' })
  }
}))
