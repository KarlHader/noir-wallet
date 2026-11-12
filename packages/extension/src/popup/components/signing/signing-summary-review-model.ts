import { formatBaseUnitAmount, formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type {
  BitcoinBip322MessageSummary,
  BitcoinPsbtSummary,
  PearlBip322MessageSummary,
  PearlPsbtSummary,
  QuantusTransferSummary,
  SigningSummary,
  StarknetCallSummary,
  StarknetDeployAccountSummary,
  StarknetInvokeSummary,
  StarknetResourceBoundsSummary,
  StarknetTypedDataSummary
} from '@/core/keyring/domain'
import type {
  DashMessageSummary,
  DashOutputSummary,
  DashPsbtSummary
} from '@/core/keyring/domain/signing-summary'
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
import {
  canonicalContentRows,
  completeReviewModel,
  reviewRow,
  type SigningSummaryReviewModel,
  type SigningSummaryReviewRow,
  type SigningSummaryReviewSection
} from './signing-summary-review-model-types'

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

function dashAmount(duffs: string): string {
  return `${duffs} duffs`
}

function dashOutputRows(
  label: 'Recipient' | 'Change' | 'Unclassified output',
  output: DashOutputSummary
): readonly SigningSummaryReviewRow[] {
  return [
    reviewRow(label, output.address ?? 'Unknown', { code: true, breakAll: true }),
    reviewRow(label === 'Change' ? 'Change amount' : 'Amount', dashAmount(output.amountDuffs), {
      code: true
    })
  ]
}

function dashPsbtReview(summary: DashPsbtSummary): SigningSummaryReviewModel {
  const recipients = summary.fields.outputs.filter(output => output.classification === 'recipient')
  const change = summary.fields.outputs.filter(output => output.classification === 'change')
  const unclassified = summary.fields.outputs.filter(output => output.classification === 'unknown')
  return completeReviewModel(summary, {
    title: 'Sign Dash transaction',
    description:
      'Review the recipient, amount, fee, and change. Dash transfers are visible on-chain.',
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          ...recipients.flatMap(output => dashOutputRows('Recipient', output)),
          reviewRow('Total fee', dashAmount(summary.fields.feeDuffs), { code: true }),
          ...change.flatMap(output => dashOutputRows('Change', output)),
          ...unclassified.flatMap(output => dashOutputRows('Unclassified output', output))
        ]
      }
    ]
  })
}

function dashMessageReview(summary: DashMessageSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Dash message',
    description: 'This signature proves control of the selected Dash address.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Address', summary.fields.signer, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}

function issueDescription(code: string): { title: string; description: string } {
  switch (code) {
    case 'external-input':
      return {
        title: 'External input',
        description: 'This request signs data that was not produced by the wallet review.'
      }
    case 'unrecognized-call':
      return {
        title: 'Unrecognized call',
        description: 'The extrinsic call could not be matched to a known native transfer.'
      }
    default:
      return {
        title: 'Review required',
        description: 'Review this request carefully before signing.'
      }
  }
}

function quantusTransactionReview(summary: QuantusTransferSummary): SigningSummaryReviewModel {
  const fields = summary.fields
  // Planck uses PLK; the symbol follows the reviewed chain, not the provider.
  const symbol = summary.chainId === 'quantus:planck' ? 'PLK' : 'QTC'
  const amount = formatBaseUnitDecimalAmount(fields.amountRaw, 12)
  const feeLimit = formatBaseUnitDecimalAmount(fields.feeLimitRaw, 12)
  const tip = formatBaseUnitDecimalAmount(fields.tipRaw, 12)
  const sections: SigningSummaryReviewSection[] = [
    {
      title: 'Transfer',
      rows: [
        reviewRow('From', fields.signerAddress, { breakAll: true }),
        reviewRow('Recipient', fields.recipient, { breakAll: true }),
        reviewRow('Amount', `${formatBaseUnitAmount(fields.amountRaw, 12)} ${symbol}`, {
          amount: { value: amount, symbol, profile: 'review' }
        }),
        reviewRow(
          'Fee limit (estimated)',
          `${formatBaseUnitAmount(fields.feeLimitRaw, 12)} ${symbol}`,
          {
            amount: { value: feeLimit, symbol, profile: 'fee' }
          }
        ),
        reviewRow('Keep account alive', fields.keepAlive),
        reviewRow('Tip', `${formatBaseUnitAmount(fields.tipRaw, 12)} ${symbol}`, {
          amount: { value: tip, symbol, profile: 'fee' }
        })
      ]
    },
    {
      title: 'Signing',
      rows: [
        reviewRow('Scheme', fields.scheme),
        reviewRow('Nonce', fields.nonce),
        reviewRow('Era period', fields.eraPeriod),
        reviewRow('Block number', fields.blockNumber),
        reviewRow('Call hash', fields.callHash, { breakAll: true, code: true }),
        reviewRow('Call bytes', fields.callLength)
      ]
    },
    {
      title: 'Request',
      rows: [
        reviewRow('Schema', summary.schema, { code: true, breakAll: true }),
        reviewRow('Chain ID', summary.chainId, { code: true, breakAll: true })
      ]
    }
  ]
  return {
    title: 'Sign Quantus transfer',
    operation: summary.operation,
    level: summary.review.level,
    issues: summary.review.issues.map(issue => ({
      code: issue.code,
      ...issueDescription(issue.code)
    })),
    sections
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
    case 'dash.psbt.v1':
      return dashPsbtReview(summary)
    case 'dash.message.v1':
      return dashMessageReview(summary)
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
    case 'quantus.transfer.v1':
      return quantusTransactionReview(summary)
    case 'starknet.invoke.v1':
      return starknetInvokeReview(summary)
    case 'starknet.deploy-account.v1':
      return starknetDeployAccountReview(summary)
    case 'starknet.typed-data.v1':
      return starknetTypedDataReview(summary)
    default:
      return assertNever(summary)
  }
}

function starknetBoundRows(
  bounds: StarknetResourceBoundsSummary
): readonly SigningSummaryReviewRow[] {
  return (['l1Gas', 'l2Gas', 'l1DataGas'] as const).flatMap(name => [
    reviewRow(`${name} max amount`, bounds[name].maxAmount, { code: true }),
    reviewRow(`${name} max price`, bounds[name].maxPricePerUnit, { code: true })
  ])
}

function starknetCallRows(
  calls: readonly StarknetCallSummary[]
): readonly SigningSummaryReviewRow[] {
  return calls.flatMap((call, index) => [
    reviewRow(`Call ${index + 1} contract`, call.to, { code: true, breakAll: true }),
    reviewRow(`Call ${index + 1} selector`, call.selector, { code: true, breakAll: true }),
    reviewRow(`Call ${index + 1} calldata count`, String(call.calldata.length), { code: true })
  ])
}

function starknetInvokeReview(summary: StarknetInvokeSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Starknet transaction',
    description:
      'Each call is unrecognized. Verify the destination and calldata before continuing.',
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Sender', summary.fields.senderAddress, { code: true, breakAll: true }),
          reviewRow('Nonce', summary.fields.nonce, { code: true, breakAll: true }),
          reviewRow('Tip', summary.fields.tip, { code: true }),
          reviewRow('Nonce data', summary.fields.nonceDataAvailabilityMode),
          reviewRow('Fee data', summary.fields.feeDataAvailabilityMode),
          ...starknetBoundRows(summary.fields.resourceBounds)
        ]
      },
      {
        title: `Calls (${summary.fields.calls.length})`,
        rows: starknetCallRows(summary.fields.calls)
      }
    ]
  })
}

function starknetDeployAccountReview(
  summary: StarknetDeployAccountSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Deploy Starknet account',
    description: 'This creates a new account contract. Verify the class hash and constructor data.',
    sections: [
      {
        title: 'Account',
        rows: [
          reviewRow('Contract', summary.fields.contractAddress, { code: true, breakAll: true }),
          reviewRow('Class hash', summary.fields.classHash, { code: true, breakAll: true }),
          reviewRow('Salt', summary.fields.salt, { code: true, breakAll: true }),
          reviewRow('Constructor calldata', summary.fields.constructorCalldata.join(', '), {
            code: true,
            breakAll: true
          }),
          reviewRow('Nonce', summary.fields.nonce, { code: true, breakAll: true }),
          reviewRow('Tip', summary.fields.tip, { code: true }),
          reviewRow('Nonce data', summary.fields.nonceDataAvailabilityMode),
          reviewRow('Fee data', summary.fields.feeDataAvailabilityMode),
          ...starknetBoundRows(summary.fields.resourceBounds)
        ]
      }
    ]
  })
}

function starknetTypedDataReview(summary: StarknetTypedDataSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Starknet typed data',
    description: 'The message contents are opaque. Read the full typed data before continuing.',
    sections: [
      {
        title: 'Typed data',
        rows: [
          reviewRow('Account', summary.fields.accountAddress, { code: true, breakAll: true }),
          reviewRow('Public key', summary.fields.publicKey, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.typedData)
        ]
      }
    ]
  })
}

export type {
  SigningSummaryReviewIssue,
  SigningSummaryReviewModel,
  SigningSummaryReviewRow,
  SigningSummaryReviewSection
} from './signing-summary-review-model-types'
