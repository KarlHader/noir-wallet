import type { SigningSummary } from '@/core/keyring/domain'
import {
  bitcoinMessageReview,
  bitcoinPsbtReview,
  evmPersonalMessageReview,
  evmTransactionReview,
  evmTypedDataReview,
  type EvmReviewPresentationOptions,
  nearMessageReview,
  nearTransactionReview,
  solanaMessageReview,
  solanaTransactionReview,
  zcashMessageReview,
  zcashTransactionReview
} from './signing-summary-review-model-other'
import { tronMessageReview, tronTransactionReview } from './signing-summary-review-model-tron'
import type { SigningSummaryReviewModel } from './signing-summary-review-model-types'

function assertNever(value: never): never {
  throw new Error(`Unsupported signing summary schema: ${JSON.stringify(value)}`)
}

export function buildSigningSummaryReviewModel(
  summary: SigningSummary,
  evmOptions: EvmReviewPresentationOptions = {}
): SigningSummaryReviewModel {
  switch (summary.schema) {
    case 'zcash.transaction.v1':
      return zcashTransactionReview(summary)
    case 'zcash.message.v1':
      return zcashMessageReview(summary)
    case 'evm.transaction.v1':
      return evmTransactionReview(summary, evmOptions)
    case 'evm.personal-message.v1':
      return evmPersonalMessageReview(summary)
    case 'evm.typed-data.v1':
      return evmTypedDataReview(summary, evmOptions)
    case 'bitcoin.psbt.v1':
      return bitcoinPsbtReview(summary)
    case 'bitcoin.bip322-message.v1':
      return bitcoinMessageReview(summary)
    case 'solana.transaction.v1':
      return solanaTransactionReview(summary)
    case 'solana.message.v1':
      return solanaMessageReview(summary)
    case 'tron.transaction.v1':
      return tronTransactionReview(summary)
    case 'tron.sign-message-v2.v1':
      return tronMessageReview(summary)
    case 'near.transaction.v1':
      return nearTransactionReview(summary)
    case 'near.nep413-message.v1':
      return nearMessageReview(summary)
    default:
      return assertNever(summary)
  }
}

export type {
  SigningSummaryReviewIssue,
  SigningSummaryReviewModel,
  SigningSummaryReviewRow,
  SigningSummaryReviewSection
} from './signing-summary-review-model-types'
