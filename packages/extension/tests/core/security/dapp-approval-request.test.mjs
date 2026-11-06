import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { parsePendingApprovalResponse } from '../../../src/popup/services/dapp-approval-request.ts'
import {
  parsePublicActivationReview,
  parsePublicTransactionReview
} from '../../../src/popup/services/noir-public-approval-review.ts'
import {
  parseEvmGasFundingDetails,
  resolveEvmGasFundingPreview
} from '../../../src/popup/services/evm-gas-funding.ts'

const approvalPageSource = readFileSync(
  new URL('../../../src/popup/pages/dapp/ApprovalPage.tsx', import.meta.url),
  'utf8'
)
const signingReviewSource = readFileSync(
  new URL('../../../src/popup/components/signing/SigningSummaryReview.tsx', import.meta.url),
  'utf8'
)
const approvalPresentationSource = readFileSync(
  new URL('../../../src/popup/components/dapp/ApprovalRequestPresentation.tsx', import.meta.url),
  'utf8'
)

const requestId = 'approval-1'

function response(overrides = {}) {
  return {
    request: {
      id: requestId,
      origin: 'https://dapp.example',
      action: 'evmMessage',
      data: { review: { summary: {} } },
      ...overrides
    }
  }
}

test.describe('dApp approval request boundary', () => {
  test('accepts Native connection and rejects retired Public approval actions', () => {
    expect(
      parsePendingApprovalResponse(response({ action: 'connect', data: {} }), requestId)
    ).toMatchObject({ status: 'ready', request: { action: 'connect' } })
    for (const action of ['publicConnect', 'publicSignMessage']) {
      expect(parsePendingApprovalResponse(response({ action, data: {} }), requestId).status).toBe(
        'error'
      )
    }
  })

  test('accepts web Public activation and only the wallet own internal activation origin', () => {
    const previousChrome = globalThis.chrome
    globalThis.chrome = {
      runtime: { id: 'wallet-id', getURL: () => 'chrome-extension://wallet-id/' }
    }
    try {
      expect(
        parsePendingApprovalResponse(
          response({
            action: 'publicActivate',
            origin: 'chrome-extension://wallet-id',
            data: {}
          }),
          requestId
        ).status
      ).toBe('ready')
      expect(
        parsePendingApprovalResponse(
          response({
            action: 'publicTransaction',
            origin: 'chrome-extension://wallet-id',
            data: {}
          }),
          requestId
        ).status
      ).toBe('error')
      expect(
        parsePendingApprovalResponse(
          response({
            action: 'publicActivate',
            origin: 'https://dapp.example',
            data: {}
          }),
          requestId
        ).status
      ).toBe('ready')
      expect(
        parsePendingApprovalResponse(
          response({
            action: 'publicActivate',
            origin: 'chrome-extension://another-wallet',
            data: {}
          }),
          requestId
        ).status
      ).toBe('error')
    } finally {
      globalThis.chrome = previousChrome
    }
  })

  test('requires the actual Public transaction calls and complete activation costs', () => {
    const account = {
      chain: 'zcash-l2',
      network: 'mainnet',
      publicKey: 'pk',
      signingMode: 'derived',
      address: 'public-account',
      mcaId: 'mca',
      parentContractId: 'parent.near',
      status: 'active'
    }
    const call = {
      method_name: 'transfer',
      args: '{"amount":"1"}',
      gas: '30000000000000',
      deposit: '1'
    }
    const review = {
      account,
      nonce: '1',
      deadline: '9999999999',
      tgas: 200,
      executionFee: { tokenId: 'zec.omft.near', amountRaw: '6800', recipient: 'fees.near' },
      txRequests: [
        {
          FunctionCall: {
            receiver_id: 'zec.omft.near',
            function_calls: [
              {
                method_name: 'ft_transfer',
                args: '{"receiver_id":"fees.near","amount":"6800"}',
                gas: '30000000000000',
                deposit: '1'
              }
            ]
          }
        },
        { FunctionCall: { receiver_id: 'token.near', function_calls: [call] } }
      ],
      label: 'Harmless operation'
    }
    expect(
      parsePublicTransactionReview(review)?.txRequests[1].FunctionCall.function_calls[0].deposit
    ).toBe('1')
    expect(
      parsePublicTransactionReview({
        ...review,
        txRequests: [
          review.txRequests[0],
          { FunctionCall: { receiver_id: 'token.near', function_calls: Array(16).fill(call) } }
        ]
      })?.txRequests[1].FunctionCall.function_calls
    ).toHaveLength(16)
    expect(
      parsePublicTransactionReview(review)?.txRequests[1].FunctionCall.function_calls[0].args
    ).toBe(call.args)
    expect(parsePublicTransactionReview({ ...review, txRequests: [] })).toBeNull()
    expect(
      parsePublicTransactionReview({
        ...review,
        account: { ...account, signingMode: 'noir_protocol_public' }
      })
    ).toBeNull()
    expect(
      parsePublicTransactionReview({
        ...review,
        txRequests: [
          review.txRequests[0],
          {
            FunctionCall: {
              receiver_id: 'token.near',
              function_calls: [{ ...call, deposit: undefined }]
            }
          }
        ]
      })
    ).toBeNull()
    expect(
      parsePublicTransactionReview({
        ...review,
        executionFee: { ...review.executionFee, amountRaw: '1' }
      })
    ).toBeNull()
    expect(
      parsePublicActivationReview({
        account: { ...account, status: 'inactive' },
        amount: '0.01',
        fee: '0.001',
        creationFee: '0.0003',
        expectedCredit: '0.009',
        depositAddress: 't1address',
        expiresAt: Date.now() + 60000
      })
    ).toMatchObject({ totalPayment: '0.011' })
    expect(
      parsePublicActivationReview({
        account: { ...account, status: 'inactive' },
        amount: '0.01',
        fee: '0.001',
        creationFee: '0.0003',
        expectedCredit: '0.009',
        depositAddress: 't1address',
        expiresAt: Date.now() - 1
      })
    ).toBeNull()
  })
  test('accepts a supported request bound to the expected ID and web origin', () => {
    expect(parsePendingApprovalResponse(response(), requestId)).toEqual({
      status: 'ready',
      request: {
        id: requestId,
        origin: 'https://dapp.example',
        action: 'evmMessage',
        data: { review: { summary: {} } }
      }
    })
  })

  test('accepts the unified CAIP-25 multichain approval action', () => {
    expect(
      parsePendingApprovalResponse(
        response({ action: 'multichainConnect', data: { scopes: [] } }),
        requestId
      )
    ).toEqual({
      status: 'ready',
      request: {
        id: requestId,
        origin: 'https://dapp.example',
        action: 'multichainConnect',
        data: { scopes: [] }
      }
    })
  })

  test('accepts the Private Gas funding approval action', () => {
    expect(
      parsePendingApprovalResponse(
        response({ action: 'evmGasFunding', data: { shortfallRaw: '1' } }),
        requestId
      )
    ).toMatchObject({ status: 'ready', request: { action: 'evmGasFunding' } })
  })

  test('checks fresh Public funds without spending Confidential or another account balance', () => {
    const details = parseEvmGasFundingDetails({
      chainId: 1,
      nativeCurrency: { symbol: 'ETH', decimals: 18, slip44Reference: '60' },
      privateAddress: '0x2222222222222222222222222222222222222222',
      requiredNativeBalanceRaw: '1',
      availableNativeBalanceRaw: '0',
      shortfallRaw: '1',
      maximumGasCostRaw: '0'
    })
    expect(details).not.toBeNull()
    const portfolio = {
      scope: { keyDomainId: 'wallet-1', accountId: 'account-1' },
      assets: [
        {
          asset: { id: details.nativeAssetId },
          freshness: 'fresh',
          balance: {
            availableRaw: '1000000000000000000',
            mainRaw: '0',
            privateRaw: '1000000000000000000'
          }
        }
      ]
    }
    const input = {
      details,
      walletId: 'wallet-1',
      accountId: 'account-1',
      portfolio,
      nativePriceUsd: '2000'
    }
    const unavailable = resolveEvmGasFundingPreview(input)
    expect(unavailable.publicBalanceRaw).toBe('0')
    expect(unavailable.error).toBe('Insufficient ETH balance in Public account.')
    expect(unavailable.suggestedOutputRaw).toBe('2500000000000000')
    const publicAsset = { ...portfolio.assets[0], balance: { mainRaw: '1000000000000000000' } }
    expect(
      resolveEvmGasFundingPreview({ ...input, portfolio: { ...portfolio, assets: [publicAsset] } })
        .error
    ).toBeNull()
    for (const invalidPortfolio of [
      { ...portfolio, scope: { ...portfolio.scope, accountId: 'account-2' } },
      { ...portfolio, assets: [{ ...publicAsset, freshness: 'stale' }] },
      {
        ...portfolio,
        assets: [{ ...publicAsset, balance: { availableRaw: '1000000000000000000' } }]
      }
    ]) {
      expect(
        resolveEvmGasFundingPreview({ ...input, portfolio: invalidPortfolio }).publicBalanceRaw
      ).toBeNull()
    }
  })

  test('preserves an explicit expired-request error', () => {
    expect(
      parsePendingApprovalResponse({ error: 'Request not found or expired' }, requestId)
    ).toEqual({ status: 'error', error: 'Request not found or expired' })
    expect(parsePendingApprovalResponse({ error: '' }, requestId)).toEqual({
      status: 'error',
      error: 'Unable to load this approval request.'
    })
  })

  test('fails closed for mismatched IDs, non-web origins, unknown actions, or invalid data', () => {
    for (const value of [
      response({ id: 'approval-2' }),
      response({ origin: 'chrome-extension://wallet' }),
      response({ action: 'futureSign' }),
      response({ data: null })
    ]) {
      expect(parsePendingApprovalResponse(value, requestId)).toEqual({
        status: 'error',
        error: 'Invalid or unsupported approval request.'
      })
    }
  })

  test('fails closed for malformed runtime responses', () => {
    for (const value of [undefined, null, [], {}, { request: null }]) {
      expect(parsePendingApprovalResponse(value, requestId).status).toBe('error')
    }
  })

  test('uses the dApp identity header across network, transaction, and signing approvals', () => {
    expect(approvalPageSource).toContain('<DAppRequestHeader')
    expect(approvalPageSource).not.toContain('<ApprovalRequestHeader')
    expect(signingReviewSource).toContain("source.kind === 'dapp'")
    expect(signingReviewSource).toContain('<DAppRequestHeader')
  })

  test('uses a focused message card and keeps technical signing data under Advanced', () => {
    expect(signingReviewSource).toContain('const isDAppMessage')
    expect(signingReviewSource).toContain('<DAppMessageReview')
    expect(signingReviewSource).toContain('aria-label="Message"')
    expect(signingReviewSource).toContain('<DAppNetworkCard')
    expect(signingReviewSource).toContain('<details className="group">')
    expect(signingReviewSource).toContain("{source.kind === 'wallet' && (")
  })

  test('uses the shared network and transaction cards for dApp approvals', () => {
    expect(approvalPageSource).toContain('<DAppNetworkCard')
    expect(signingReviewSource).toContain('const isDAppTransaction')
    expect(signingReviewSource).toContain('<DAppTransactionReview')
    expect(signingReviewSource).not.toContain('className="divide-y divide-border px-4"')
    expect(approvalPresentationSource).not.toContain(
      'className="divide-y divide-border overflow-hidden rounded-2xl'
    )
  })
})
