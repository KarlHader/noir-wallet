import type {
  TronContractSummary,
  TronTransactionSummary,
  TronSignMessageV2Summary
} from '@/core/keyring/domain'
import {
  canonicalContentRows,
  completeReviewModel,
  payloadDigestRows,
  reviewRow,
  type SigningSummaryReviewPresentation,
  type SigningSummaryReviewSection,
  type SigningSummaryReviewModel
} from './signing-summary-review-model-types'

function assertNever(value: never): never {
  throw new Error(`Unsupported TRON contract: ${JSON.stringify(value)}`)
}

function contractPresentation(contract: TronContractSummary): SigningSummaryReviewPresentation {
  switch (contract.type) {
    case 'transfer':
      return {
        title: 'Send TRX',
        sections: [
          {
            title: 'Transfer',
            rows: [
              reviewRow('Owner', contract.owner, { code: true, breakAll: true }),
              reviewRow('Recipient', contract.to, { code: true, breakAll: true }),
              reviewRow('Amount', `${contract.amountSun} SUN`, { code: true })
            ]
          }
        ]
      }
    case 'transfer-asset':
      return {
        title: 'Send TRC-10 token',
        sections: [
          {
            title: 'TRC-10 transfer',
            rows: [
              reviewRow('Owner', contract.owner, { code: true, breakAll: true }),
              reviewRow('Recipient', contract.to, { code: true, breakAll: true }),
              reviewRow('Raw amount', contract.amountRaw, { code: true }),
              ...canonicalContentRows('Asset name', contract.assetName)
            ]
          }
        ]
      }
    case 'vote-witness':
      return {
        title: 'Vote for witnesses',
        description: 'Voting changes how this account allocates TRON Power.',
        sections: [
          {
            title: 'Vote',
            rows: [reviewRow('Owner', contract.owner, { code: true, breakAll: true })]
          },
          {
            title: `Witnesses (${contract.votes.length})`,
            rows: contract.votes.flatMap((vote, index) => [
              reviewRow(`Witness ${index + 1}`, vote.voteAddress, { code: true, breakAll: true }),
              reviewRow(`Votes ${index + 1}`, vote.voteCount, { code: true })
            ])
          }
        ]
      }
    case 'trigger-smart-contract': {
      const commonRows = [
        reviewRow('Owner', contract.owner, { code: true, breakAll: true }),
        reviewRow('Contract', contract.contractAddress, { code: true, breakAll: true }),
        reviewRow('TRX call value', `${contract.callValueSun} SUN`, { code: true }),
        reviewRow('Token call value', contract.callTokenValue, { code: true }),
        reviewRow('Token ID', contract.tokenId, { code: true }),
        reviewRow('Method selector', contract.methodSelector, { code: true })
      ]
      const rawSection: SigningSummaryReviewSection = {
        title: 'Contract data',
        rows: [...canonicalContentRows('Calldata', contract.calldata)]
      }
      switch (contract.interpretation.kind) {
        case 'trc20-transfer':
          return {
            title: 'Send TRC-20 token',
            description: 'Token metadata is unavailable, so amounts are shown in raw units.',
            sections: [
              {
                title: 'TRC-20 transfer',
                rows: [
                  reviewRow('Recipient', contract.interpretation.to, {
                    code: true,
                    breakAll: true
                  }),
                  reviewRow('Raw amount', contract.interpretation.amountRaw, { code: true }),
                  ...commonRows
                ]
              },
              rawSection
            ]
          }
        case 'trc20-approve':
          return {
            title: 'Approve token spending',
            description: 'This changes how much of the token another address may spend.',
            sections: [
              {
                title: 'TRC-20 approval',
                rows: [
                  reviewRow('Spender', contract.interpretation.spender, {
                    code: true,
                    breakAll: true,
                    tone: 'warning'
                  }),
                  reviewRow('Raw allowance', contract.interpretation.amountRaw, {
                    code: true,
                    tone: 'warning'
                  }),
                  ...commonRows
                ]
              },
              rawSection
            ]
          }
        case 'trc20-transfer-from':
          return {
            title: 'Transfer approved tokens',
            description: 'This spends an existing TRC-20 allowance.',
            sections: [
              {
                title: 'TRC-20 transferFrom',
                rows: [
                  reviewRow('Token owner', contract.interpretation.from, {
                    code: true,
                    breakAll: true
                  }),
                  reviewRow('Recipient', contract.interpretation.to, {
                    code: true,
                    breakAll: true
                  }),
                  reviewRow('Raw amount', contract.interpretation.amountRaw, { code: true }),
                  ...commonRows
                ]
              },
              rawSection
            ]
          }
        case 'unrecognized':
          return {
            title: 'Unknown smart contract call',
            description: 'Noir Wallet cannot explain this calldata and will not allow signing.',
            sections: [{ title: 'Smart contract', rows: commonRows }, rawSection]
          }
        default:
          return assertNever(contract.interpretation)
      }
    }
    case 'freeze-balance-v2':
    case 'unfreeze-balance-v2':
      return {
        title: contract.type === 'freeze-balance-v2' ? 'Freeze TRX' : 'Unfreeze TRX',
        description:
          contract.type === 'freeze-balance-v2'
            ? 'Freezing TRX obtains network resources and may affect availability.'
            : 'Unfreezing TRX starts the protocol withdrawal process.',
        sections: [
          {
            title: 'Resource action',
            rows: [
              reviewRow('Owner', contract.owner, { code: true, breakAll: true }),
              reviewRow('Resource', contract.resource),
              reviewRow('Amount', `${contract.amountSun} SUN`, { code: true })
            ]
          }
        ]
      }
    case 'withdraw-expire-unfreeze':
    case 'cancel-all-unfreeze-v2':
      return {
        title:
          contract.type === 'withdraw-expire-unfreeze'
            ? 'Withdraw unfrozen TRX'
            : 'Cancel all unfreezes',
        description:
          contract.type === 'withdraw-expire-unfreeze'
            ? 'Withdraw every currently matured unfreeze balance.'
            : 'Cancel every pending unfreeze for this owner.',
        sections: [
          {
            title: 'Resource action',
            rows: [reviewRow('Owner', contract.owner, { code: true, breakAll: true })]
          }
        ]
      }
    case 'delegate-resource':
      return {
        title: 'Delegate resources',
        description: "Give another address access to this account's TRON resources.",
        sections: [
          {
            title: 'Delegation',
            rows: [
              reviewRow('Owner', contract.owner, { code: true, breakAll: true }),
              reviewRow('Receiver', contract.receiver, { code: true, breakAll: true }),
              reviewRow('Resource', contract.resource),
              reviewRow('Amount', `${contract.amountSun} SUN`, { code: true }),
              reviewRow('Locked', contract.locked),
              reviewRow('Lock period', contract.lockPeriod, { code: true })
            ]
          }
        ]
      }
    case 'undelegate-resource':
      return {
        title: 'Undelegate resources',
        description: 'Remove delegated TRON resources from another address.',
        sections: [
          {
            title: 'Undelegation',
            rows: [
              reviewRow('Owner', contract.owner, { code: true, breakAll: true }),
              reviewRow('Receiver', contract.receiver, { code: true, breakAll: true }),
              reviewRow('Resource', contract.resource),
              reviewRow('Amount', `${contract.amountSun} SUN`, { code: true })
            ]
          }
        ]
      }
    default:
      return assertNever(contract)
  }
}

export function tronTransactionReview(summary: TronTransactionSummary): SigningSummaryReviewModel {
  const presentation = contractPresentation(summary.fields.contract)
  return completeReviewModel(summary, {
    ...presentation,
    sections: [
      ...presentation.sections,
      {
        title: 'TRON authorization',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          reviewRow('Contract owner', summary.fields.owner, {
            code: true,
            breakAll: true,
            tone: summary.fields.ownerMatchesSigner ? 'default' : 'danger'
          }),
          reviewRow(
            'Permission',
            summary.fields.permissionId === 0
              ? 'Owner permission (0)'
              : `Active permission (${summary.fields.permissionId})`,
            { tone: summary.fields.permissionId === 0 ? 'default' : 'warning' }
          ),
          reviewRow(
            'Existing signers',
            summary.fields.existingSigners.length === 0
              ? 'None'
              : summary.fields.existingSigners.join('\n'),
            { code: true, breakAll: true }
          )
        ]
      },
      {
        title: 'Transaction details',
        rows: [
          reviewRow('Transaction ID', summary.fields.transactionId, {
            code: true,
            breakAll: true
          }),
          reviewRow('Fee limit', `${summary.fields.feeLimitSun} SUN`, { code: true }),
          reviewRow('Timestamp', `${summary.fields.timestampMs} ms`, { code: true }),
          reviewRow('Expiration', `${summary.fields.expirationMs} ms`, { code: true }),
          reviewRow('Reference block', summary.fields.refBlockNum, { code: true }),
          reviewRow('Reference bytes', summary.fields.refBlockBytes, { code: true }),
          reviewRow('Reference hash', summary.fields.refBlockHash, {
            code: true,
            breakAll: true
          }),
          ...payloadDigestRows('Raw data', summary.fields.rawData),
          ...canonicalContentRows('Memo', summary.fields.memo)
        ]
      }
    ]
  })
}

export function tronMessageReview(summary: TronSignMessageV2Summary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign TRON message',
    description: 'Signing proves control of the address but does not submit a transaction.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          reviewRow('TRON prefix', JSON.stringify(summary.fields.prefix), { code: true }),
          reviewRow('Signing hash', summary.fields.signingHash, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}
