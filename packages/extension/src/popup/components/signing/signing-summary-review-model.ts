import type {
  BitcoinBip322MessageSummary,
  BitcoinPsbtSummary,
  PearlBip322MessageSummary,
  PearlPsbtSummary,
  SigningSummary
} from '@/core/keyring/domain'
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

function pearlReview(
  summary: PearlPsbtSummary | PearlBip322MessageSummary
): SigningSummaryReviewModel {
  const bitcoinReview =
    summary.schema === 'pearl.psbt.v1'
      ? bitcoinPsbtReview({ ...summary, schema: 'bitcoin.psbt.v1' } as BitcoinPsbtSummary)
      : bitcoinMessageReview({
          ...summary,
          schema: 'bitcoin.bip322-message.v1'
        } as BitcoinBip322MessageSummary)
  const request = bitcoinReview.sections.at(-1)
  if (!request) throw new Error('Missing signing request review')
  return {
    ...bitcoinReview,
    title: summary.schema === 'pearl.psbt.v1' ? 'Sign Pearl transaction' : 'Sign Pearl message',
    ...(summary.schema === 'pearl.bip322-message.v1'
      ? { description: 'BIP-322 proves control of the selected Pearl address.' }
      : {}),
    sections: [
      ...bitcoinReview.sections.slice(0, -1),
      {
        ...request,
        rows: request.rows.map(row =>
          row.label === 'Schema' ? { ...row, value: summary.schema } : row
        )
      }
    ]
  }
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
      return evmTypedDataReview(summary)
    case 'bitcoin.psbt.v1':
      return bitcoinPsbtReview(summary)
    case 'bitcoin.bip322-message.v1':
      return bitcoinMessageReview(summary)
    case 'pearl.psbt.v1':
    case 'pearl.bip322-message.v1':
      return pearlReview(summary)
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
