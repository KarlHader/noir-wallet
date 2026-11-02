import type {
  BitcoinBip322MessageSummary,
  BitcoinPsbtSummary,
  EvmPersonalMessageSummary,
  EvmTransactionSummary,
  EvmTypedDataSummary,
  EvmTypedDataValue,
  NearActionSummary,
  NearNep413MessageSummary,
  NearTransactionSummary,
  SolanaMessageSummary,
  SolanaTransactionSummary,
  ZcashMessageSummary,
  ZcashTransactionSummary
} from '@/core/keyring/domain'
import {
  canonicalContentRows,
  completeReviewModel,
  payloadDigestRows,
  reviewRow,
  type SigningSummaryReviewModel,
  type SigningSummaryReviewRow
} from './signing-summary-review-model-types'
import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
import { decodeErc20CalldataRequest } from '@/infrastructure/chains/evm/evm-contract-call-classification'
import { formatSortAddress } from '@/lib/format'
import { formatAmount, formatFeeAmount, formatReviewAmount } from '@/lib/number-format'

export interface EvmReviewPresentationOptions {
  readonly nativeCurrency?: { readonly symbol: string; readonly decimals: number }
  readonly directContract?: boolean
  readonly tokenMetadata?: readonly {
    readonly contractAddress: string
    readonly symbol: string
    readonly decimals: number
  }[]
}

const MAX_UINT256 = ((1n << 256n) - 1n).toString()

function evmRequestedTokenCallRows(
  summary: EvmTransactionSummary,
  options: EvmReviewPresentationOptions
): readonly SigningSummaryReviewRow[] {
  const contract = summary.fields.to
  if (contract === null || summary.fields.calldata.encoding !== 'hex') return []
  const request = decodeErc20CalldataRequest(summary.fields.calldata.value)
  if (!request) return []
  const knownToken = options.tokenMetadata?.find(
    token => token.contractAddress.toLowerCase() === contract.toLowerCase()
  )
  // ERC-721 shares approve/transferFrom selectors; the selector alone cannot establish ERC-20 semantics.
  if (
    !knownToken ||
    !Number.isInteger(knownToken.decimals) ||
    knownToken.decimals < 0 ||
    knownToken.decimals > 255
  ) {
    return []
  }
  const amount = (raw: string) => {
    if (request.kind === 'approve' && raw === MAX_UINT256) {
      return 'Unlimited'
    }
    return `${formatAmount(raw, knownToken.decimals)} ${knownToken.symbol}`
  }
  const addressRow = (label: string, value: string) =>
    reviewRow(label, formatSortAddress(value), { code: true, title: value })
  return [
    reviewRow('Requested method', request.kind, { code: true }),
    ...(request.kind === 'approve'
      ? [
          addressRow('Requested spender', request.spender),
          reviewRow('Requested allowance', amount(request.amountRaw), {
            code: true,
            breakAll: true
          })
        ]
      : request.kind === 'transfer'
        ? [
            addressRow('Requested recipient', request.recipient),
            reviewRow('Requested amount', amount(request.amountRaw), { code: true, breakAll: true })
          ]
        : [
            addressRow('Requested sender', request.sender),
            addressRow('Requested recipient', request.recipient),
            reviewRow('Requested amount', amount(request.amountRaw), { code: true, breakAll: true })
          ])
  ]
}

function assertNever(value: never): never {
  throw new Error(`Unsupported signing summary item: ${JSON.stringify(value)}`)
}

function formatWeiPerGasAsGwei(value: string | null): string | null {
  if (value === null) return null
  return `${formatEvmWeiAsGwei(value)} GWEI`
}

function typedDataRows(
  label: string,
  value: EvmTypedDataValue
): readonly SigningSummaryReviewRow[] {
  switch (value.kind) {
    case 'scalar':
      const breakAll = value.solidityType === 'address' || value.solidityType.startsWith('bytes')
      return [
        reviewRow(label, `${value.solidityType} · ${value.value}`, {
          code: true,
          ...(breakAll ? { breakAll: true } : {})
        })
      ]
    case 'struct':
      return value.fields.length === 0
        ? [reviewRow(label, `${value.typeName} (empty)`)]
        : value.fields.flatMap(field => typedDataRows(`${label}.${field.name}`, field.value))
    case 'array':
      return value.items.length === 0
        ? [reviewRow(label, `${value.itemType}[] (empty)`)]
        : value.items.flatMap((item, index) => typedDataRows(`${label}[${index}]`, item))
    default:
      return assertNever(value)
  }
}

function nearActionRows(
  action: NearActionSummary,
  index: number
): readonly SigningSummaryReviewRow[] {
  const prefix = `Action ${index + 1}`
  switch (action.kind) {
    case 'create-account':
      return [reviewRow(prefix, 'Create account')]
    case 'deploy-contract':
      return [
        reviewRow(prefix, 'Deploy contract'),
        ...payloadDigestRows('Contract code', action.code)
      ]
    case 'function-call':
      return [
        reviewRow(prefix, 'Function call'),
        reviewRow('Method', action.methodName, { code: true }),
        reviewRow('Gas', action.gas, { code: true }),
        reviewRow('Deposit', `${action.depositYocto} yoctoNEAR`, { code: true }),
        ...canonicalContentRows('Arguments', action.args)
      ]
    case 'transfer':
      return [
        reviewRow(prefix, 'Transfer'),
        reviewRow('Deposit', `${action.depositYocto} yoctoNEAR`, { code: true })
      ]
    case 'stake':
      return [
        reviewRow(prefix, 'Stake'),
        reviewRow('Stake', `${action.stakeYocto} yoctoNEAR`, { code: true }),
        reviewRow('Validator key', action.publicKey, { code: true, breakAll: true })
      ]
    case 'add-key':
      return [
        reviewRow(prefix, 'Add access key'),
        reviewRow('Public key', action.publicKey, { code: true, breakAll: true }),
        reviewRow('Nonce', action.nonce, { code: true }),
        reviewRow(
          'Permission',
          action.permission.kind === 'full-access'
            ? 'Full access'
            : `Function call · ${action.permission.receiverId}`,
          { tone: action.permission.kind === 'full-access' ? 'warning' : 'default' }
        ),
        ...(action.permission.kind === 'function-call'
          ? [
              reviewRow(
                'Allowance',
                action.permission.allowanceYocto === null
                  ? 'Unlimited'
                  : `${action.permission.allowanceYocto} yoctoNEAR`,
                { code: true }
              ),
              reviewRow(
                'Methods',
                action.permission.methodNames.length === 0
                  ? 'All methods'
                  : action.permission.methodNames.join(', '),
                { code: true, breakAll: true }
              )
            ]
          : [])
      ]
    case 'delete-key':
      return [
        reviewRow(prefix, 'Delete access key'),
        reviewRow('Public key', action.publicKey, { code: true, breakAll: true })
      ]
    case 'delete-account':
      return [
        reviewRow(prefix, 'Delete account', { tone: 'danger' }),
        reviewRow('Beneficiary', action.beneficiaryId, { code: true, breakAll: true })
      ]
    case 'unrecognized':
      return [
        reviewRow(prefix, `Unknown action tag ${action.actionTag}`, { tone: 'danger' }),
        ...payloadDigestRows('Action payload', action.payload)
      ]
    default:
      return assertNever(action)
  }
}

export function zcashTransactionReview(
  summary: ZcashTransactionSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: summary.fields.kind === 'shield' ? 'Shield Zcash' : 'Send Zcash',
    ...(summary.fields.kind === 'shield'
      ? { description: 'Moves transparent funds into the shielded pool.' }
      : {}),
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          reviewRow('Funding source', summary.fields.fundingSource),
          reviewRow('Fee', `${summary.fields.feeZats} zats`, { code: true }),
          reviewRow('Transparent inputs', `${summary.fields.transparentInputZats} zats`, {
            code: true
          }),
          reviewRow('Shielded inputs', `${summary.fields.shieldedInputZats} zats`, { code: true }),
          reviewRow('Transparent outputs', `${summary.fields.transparentOutputZats} zats`, {
            code: true
          }),
          reviewRow('Shielded outputs', `${summary.fields.shieldedOutputZats} zats`, { code: true })
        ]
      },
      {
        title: `Recipients (${summary.fields.recipients.length})`,
        rows: summary.fields.recipients.flatMap((recipient, index) => [
          reviewRow(`Address ${index + 1}`, recipient.address, { code: true, breakAll: true }),
          reviewRow(`Amount ${index + 1}`, `${recipient.amountZats} zats`, { code: true }),
          ...(recipient.memo ? canonicalContentRows(`Memo ${index + 1}`, recipient.memo) : [])
        ])
      }
    ]
  })
}

export function zcashMessageReview(summary: ZcashMessageSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Zcash message',
    description: 'Signing proves control of this address and does not move funds.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}

export function evmTransactionReview(
  summary: EvmTransactionSummary,
  options: EvmReviewPresentationOptions = {}
): SigningSummaryReviewModel {
  const currency = options.nativeCurrency
  const requestedTokenCallRows = evmRequestedTokenCallRows(summary, options)
  const amountRow = (label: string, raw: string) => {
    if (!currency) return reviewRow(label, `${raw} wei`, { code: true })
    const value = formatAmount(raw, currency.decimals)
    const profile = label === 'Maximum fee' ? 'fee' : 'review'
    return reviewRow(
      label,
      `${profile === 'fee' ? formatFeeAmount(value) : formatReviewAmount(value).display} ${currency.symbol}`,
      {
        code: true,
        amount: { value, symbol: currency.symbol, profile }
      }
    )
  }
  return completeReviewModel(summary, {
    title: summary.fields.to === null ? 'Create contract' : 'Review EVM transaction',
    ...(summary.fields.to === null ? { description: 'Deploys a new smart contract.' } : {}),
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('From', formatSortAddress(summary.fields.from), {
            code: true,
            title: summary.fields.from
          }),
          reviewRow(
            summary.fields.to !== null && summary.fields.calldata.value !== '0x'
              ? 'Contract'
              : 'To',
            summary.fields.to === null ? null : formatSortAddress(summary.fields.to),
            {
              code: true,
              title: summary.fields.to ?? undefined
            }
          ),
          amountRow(
            summary.fields.to === null || summary.fields.calldata.value !== '0x'
              ? 'Native value'
              : 'Value',
            summary.fields.valueWei
          ),
          amountRow('Maximum fee', summary.fields.maximumFeeWei),
          ...(options.directContract ? [reviewRow('Execution', 'Public on-chain')] : []),
          reviewRow('Gas limit', summary.fields.gasLimit, { code: true }),
          reviewRow('Nonce', summary.fields.nonce, { code: true }),
          reviewRow('Transaction type', summary.fields.transactionType),
          reviewRow('Method selector', summary.fields.methodSelector, { code: true }),
          reviewRow('Gas price', formatWeiPerGasAsGwei(summary.fields.gasPriceWei), { code: true }),
          reviewRow('Max fee per gas', formatWeiPerGasAsGwei(summary.fields.maxFeePerGasWei), {
            code: true
          }),
          reviewRow(
            'Priority fee per gas',
            formatWeiPerGasAsGwei(summary.fields.maxPriorityFeePerGasWei),
            { code: true }
          )
        ]
      },
      ...(requestedTokenCallRows.length > 0
        ? [{ title: 'Calldata request', rows: requestedTokenCallRows }]
        : []),
      {
        title: 'Contract data',
        rows: [
          ...canonicalContentRows('Calldata', summary.fields.calldata),
          reviewRow('Access list entries', summary.fields.accessList.length)
        ]
      }
    ]
  })
}

export function evmPersonalMessageReview(
  summary: EvmPersonalMessageSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign EVM message',
    description:
      'A signature can authorize off-chain actions. It does not directly submit a transaction.',
    sections: [
      {
        title: 'Message',
        rows: [...canonicalContentRows('Content', summary.fields.message)]
      }
    ]
  })
}

export function evmTypedDataReview(summary: EvmTypedDataSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign typed data',
    description: 'This signature may authorize off-chain or on-chain actions.',
    sections: [
      {
        title: 'Typed data',
        rows: [
          reviewRow('Primary type', summary.fields.primaryType, { code: true }),
          ...typedDataRows('Domain', summary.fields.domain),
          ...typedDataRows('Message', summary.fields.message),
          reviewRow('Digest', summary.fields.digestHex, { code: true, breakAll: true })
        ]
      }
    ]
  })
}

export function bitcoinPsbtReview(summary: BitcoinPsbtSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Bitcoin transaction',
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          reviewRow('PSBT version', summary.fields.psbtVersion),
          reviewRow('Total input', `${summary.fields.totalInputSats} sats`, { code: true }),
          reviewRow('Total output', `${summary.fields.totalOutputSats} sats`, { code: true }),
          reviewRow('Fee', `${summary.fields.feeSats} sats`, { code: true }),
          reviewRow('Signing inputs', summary.fields.signingInputIndexes.join(', '), { code: true })
        ]
      },
      {
        title: `Outputs (${summary.fields.outputs.length})`,
        rows: summary.fields.outputs.flatMap(output => [
          reviewRow(`Output ${output.index + 1}`, output.classification),
          reviewRow('Address', output.address, { code: true, breakAll: true }),
          reviewRow('Amount', `${output.amountSats} sats`, { code: true }),
          reviewRow('Script', output.scriptPubKeyHex, { code: true, breakAll: true })
        ])
      },
      {
        title: `Inputs (${summary.fields.inputs.length})`,
        rows: summary.fields.inputs.flatMap(input => [
          reviewRow(`Input ${input.index + 1}`, input.ownership),
          reviewRow('Outpoint', `${input.transactionId}:${input.outputIndex}`, {
            code: true,
            breakAll: true
          }),
          reviewRow('Amount', `${input.amountSats} sats`, { code: true }),
          reviewRow('Sighash', input.sighashType, { code: true })
        ])
      }
    ]
  })
}

export function bitcoinMessageReview(
  summary: BitcoinBip322MessageSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Bitcoin message',
    description: 'BIP-322 proves control of the selected Bitcoin address.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Address', summary.fields.address, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}

export function solanaTransactionReview(
  summary: SolanaTransactionSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Solana transaction',
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Message version', summary.fields.messageVersion),
          reviewRow('Fee payer', summary.fields.feePayer, { code: true, breakAll: true }),
          reviewRow('Recent blockhash', summary.fields.recentBlockhash, {
            code: true,
            breakAll: true
          }),
          reviewRow('Required signers', summary.fields.requiredSigners.join('\n'), {
            code: true,
            breakAll: true
          }),
          reviewRow('Address table lookups', summary.fields.addressTableLookups.length),
          reviewRow(
            'RPC total fee',
            summary.fields.feeLamports === null
              ? 'Unavailable'
              : `${summary.fields.feeLamports} lamports`,
            { code: true }
          ),
          reviewRow('Compute unit limit', summary.fields.computeUnitLimit, { code: true }),
          reviewRow(
            'CU price',
            summary.fields.computeUnitPriceMicroLamports === null
              ? null
              : `${summary.fields.computeUnitPriceMicroLamports} micro-lamports/CU`,
            { code: true }
          ),
          reviewRow(
            'Max priority fee',
            summary.fields.maximumPriorityFeeLamports === null
              ? null
              : `${summary.fields.maximumPriorityFeeLamports} lamports`,
            { code: true }
          ),
          reviewRow('Simulation', summary.fields.simulationStatus),
          reviewRow('Simulated units', summary.fields.simulationUnitsConsumed, { code: true })
        ]
      },
      {
        title: `Instructions (${summary.fields.instructions.length})`,
        rows: summary.fields.instructions.flatMap(instruction => {
          const interpretation = instruction.interpretation
          const interpretedRows: SigningSummaryReviewRow[] = []
          switch (interpretation.kind) {
            case 'system-transfer':
              interpretedRows.push(
                reviewRow('Action', 'System transfer'),
                reviewRow('From', interpretation.from, { code: true, breakAll: true }),
                reviewRow('To', interpretation.to, { code: true, breakAll: true }),
                reviewRow('Amount', `${interpretation.lamports} lamports`, { code: true })
              )
              break
            case 'spl-token-transfer':
              interpretedRows.push(
                reviewRow('Action', 'SPL token transfer'),
                reviewRow('Source', interpretation.source, { code: true, breakAll: true }),
                reviewRow('Destination', interpretation.destination, {
                  code: true,
                  breakAll: true
                }),
                reviewRow('Authority', interpretation.authority, { code: true, breakAll: true }),
                reviewRow('Raw amount', interpretation.amountRaw, { code: true }),
                reviewRow('Mint', interpretation.mint, { code: true, breakAll: true })
              )
              break
            case 'associated-token-create-idempotent':
              interpretedRows.push(
                reviewRow('Action', 'Create associated token account if needed'),
                reviewRow('Payer', interpretation.payer, { code: true, breakAll: true }),
                reviewRow('Owner', interpretation.owner, { code: true, breakAll: true }),
                reviewRow('Token account', interpretation.associatedAccount, {
                  code: true,
                  breakAll: true
                }),
                reviewRow('Mint', interpretation.mint, { code: true, breakAll: true })
              )
              break
            case 'compute-unit-limit':
              interpretedRows.push(
                reviewRow('Action', 'Set compute unit limit'),
                reviewRow('Units', interpretation.units, { code: true })
              )
              break
            case 'compute-unit-price':
              interpretedRows.push(
                reviewRow('Action', 'Set compute unit price'),
                reviewRow('Price', `${interpretation.microLamports} micro-lamports/CU`, {
                  code: true
                })
              )
              break
            case 'compute-request-heap-frame':
              interpretedRows.push(
                reviewRow('Action', 'Request heap frame'),
                reviewRow('Bytes', interpretation.bytes, { code: true })
              )
              break
            case 'compute-loaded-accounts-data-size-limit':
              interpretedRows.push(
                reviewRow('Action', 'Set loaded account data limit'),
                reviewRow('Bytes', interpretation.bytes, { code: true })
              )
              break
            case 'compute-request-units-deprecated':
              interpretedRows.push(
                reviewRow('Action', 'Request compute units (legacy)'),
                reviewRow('Units', interpretation.units, { code: true }),
                reviewRow('Additional fee', `${interpretation.additionalFeeLamports} lamports`, {
                  code: true
                })
              )
              break
            case 'unrecognized':
              interpretedRows.push(reviewRow('Action', 'Unknown instruction', { tone: 'danger' }))
              break
            default:
              assertNever(interpretation)
          }
          return [
            reviewRow(`Instruction ${instruction.index + 1}`, instruction.programId, {
              code: true,
              breakAll: true
            }),
            ...interpretedRows,
            ...canonicalContentRows('Instruction data', instruction.data)
          ]
        })
      }
    ]
  })
}

export function solanaMessageReview(summary: SolanaMessageSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Solana message',
    description: 'Signing proves control of this account and does not submit a transaction.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          reviewRow('Domain', summary.fields.domain, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}

export function nearTransactionReview(summary: NearTransactionSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign NEAR transaction',
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Signer', summary.fields.signerId, { code: true, breakAll: true }),
          reviewRow('Receiver', summary.fields.receiverId, { code: true, breakAll: true }),
          reviewRow('Public key', summary.fields.publicKey, { code: true, breakAll: true }),
          reviewRow('Nonce', summary.fields.nonce, { code: true }),
          reviewRow('Block hash', summary.fields.blockHash, { code: true, breakAll: true })
        ]
      },
      {
        title: `Actions (${summary.fields.actions.length})`,
        rows: summary.fields.actions.flatMap(nearActionRows)
      }
    ]
  })
}

export function nearMessageReview(summary: NearNep413MessageSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign NEP-413 message',
    description: 'This signature may authorize actions for the stated recipient.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Signer', summary.fields.signerId, { code: true, breakAll: true }),
          reviewRow('Public key', summary.fields.publicKey, { code: true, breakAll: true }),
          reviewRow('Recipient', summary.fields.recipient, { code: true, breakAll: true }),
          reviewRow('Callback URL', summary.fields.callbackUrl, { breakAll: true }),
          reviewRow('Nonce', summary.fields.nonceBase64, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}
