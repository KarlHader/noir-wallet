import { test } from 'node:test'
import { expect } from '@playwright/test'
import { ConfidentialFundingApi } from '../../../src/background/confidential-funding-api.ts'

import {
  aggregateConfidentialSettlement,
  assertConfidentialIntentBinding,
  assertConfidentialQuoteBinding,
  fingerprintConfidentialValue,
  mergeConfidentialWithdrawObservation,
  splitConfidentialFundingAmount
} from '../../../src/core/services/confidential-funding/confidential-funding-model.ts'

test.describe('confidential funding safety rules', () => {
  test('keeps the destination hash from a pending RHEA order status', async () => {
    const originalFetch = globalThis.fetch
    const hash = `0x${'cd'.repeat(32)}`
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 0, data: { status: 'PROCESSING', toHash: hash } }), {
        status: 200
      })
    try {
      const api = new ConfidentialFundingApi(
        { oneClickApiUrl: 'https://example.test/1click', rheaSwapApiUrl: 'https://example.test' },
        'https://near.example.test',
        'test-token'
      )
      await expect(api.getStatus('deposit-address', '1')).resolves.toMatchObject({
        status: 'PROCESSING',
        transactionHash: hash
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('uses the Noir Swap referral for confidential funding quotes', async () => {
    const originalFetch = globalThis.fetch
    let requestBody
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body)
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            correlationId: 'quote-1',
            quoteRequest: {},
            quote: {
              amountIn: '1000',
              amountOut: '900',
              deadline: new Date(Date.now() + 60_000).toISOString()
            }
          }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(
        {
          oneClickApiUrl: 'https://example.test/1click',
          rheaSwapApiUrl: 'https://example.test'
        },
        'https://near.example.test',
        ''
      )
      await api.quote({
        originAsset: 'nep141:eth.omft.near',
        destinationAsset: 'nep141:usdc.omft.near',
        amountRaw: '1000',
        signerId: '0x1111111111111111111111111111111111111111',
        recipient: '0x2222222222222222222222222222222222222222',
        depositType: 'CONFIDENTIAL_INTENTS',
        refundType: 'CONFIDENTIAL_INTENTS',
        recipientType: 'DESTINATION_CHAIN',
        slippageBps: 50,
        dry: false
      })
      expect(requestBody.referral).toBe('noir_swap')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('splits two or three withdraws within bounds without losing raw units', () => {
    for (const count of [2, 3]) {
      const shares = splitConfidentialFundingAmount('1000000', count, [0, 0.5, 1])
      const equalShare = 1000000n / BigInt(count)
      expect(shares).toHaveLength(count)
      expect(shares.reduce((sum, value) => sum + BigInt(value), 0n)).toBe(1000000n)
      for (const value of shares) {
        expect(BigInt(value)).toBeGreaterThanOrEqual((equalShare * 80n) / 100n)
        expect(BigInt(value)).toBeLessThanOrEqual((equalShare * 120n) / 100n + 1n)
      }
    }
    expect(() => splitConfidentialFundingAmount('1', 2)).toThrow('too small')
    expect(() => splitConfidentialFundingAmount('100', 1)).toThrow('two to five')
  })

  test('does not finalize a mixed batch before every child reaches a terminal state', () => {
    expect(aggregateConfidentialSettlement(['SUCCESS', 'PROCESSING', 'FAILED'])).toBe('confirming')
    expect(aggregateConfidentialSettlement(['SUCCESS', 'REFUNDED', 'FAILED'])).toBe('partial')
    expect(aggregateConfidentialSettlement(['SUCCESS', 'COMPLETED'])).toBe('success')
    expect(aggregateConfidentialSettlement(['REFUNDED', 'REFUNDED'])).toBe('refunded')
    expect(aggregateConfidentialSettlement(['EXPIRED', 'CANCELLED'])).toBe('expired')
  })

  test('keeps child terminal states and evidence stable across stale and conflicting polls', () => {
    for (const status of ['SUCCESS', 'COMPLETED', 'REFUNDED', 'FAILED', 'EXPIRED', 'CANCELLED']) {
      const row = { status, transactionHash: 'original-hash', errorStatus: 'original-reason' }
      expect(mergeConfidentialWithdrawObservation(row, null)).toBe(row)
      expect(
        mergeConfidentialWithdrawObservation(row, {
          status: 'PROCESSING',
          transactionHash: 'stale-hash',
          errorStatus: 'stale-reason'
        })
      ).toBe(row)
      expect(
        mergeConfidentialWithdrawObservation(row, {
          status: ['SUCCESS', 'COMPLETED'].includes(status) ? 'REFUNDED' : 'SUCCESS'
        })
      ).toBe(row)
      expect(
        mergeConfidentialWithdrawObservation(row, {
          status,
          transactionHash: 'replacement-hash',
          errorStatus: 'replacement-reason'
        })
      ).toEqual(row)
    }
    expect(
      mergeConfidentialWithdrawObservation(
        { status: 'SUCCESS' },
        {
          status: 'COMPLETED',
          transactionHash: 'destination-hash'
        }
      )
    ).toEqual({ status: 'SUCCESS', transactionHash: 'destination-hash' })
    expect(
      mergeConfidentialWithdrawObservation(
        { status: 'PROCESSING' },
        {
          status: 'SUCCESS',
          transactionHash: 'destination-hash'
        }
      )
    ).toEqual({ status: 'SUCCESS', transactionHash: 'destination-hash' })
  })

  test('refuses to sign when the generated intent or quote no longer matches the frozen plan', () => {
    const deadline = new Date(Date.now() + 60_000).toISOString()
    const quote = {
      correlationId: 'quote-1',
      quoteRequest: {
        swapType: 'EXACT_INPUT',
        confidentiality: 'basic',
        originAsset: 'nep141:eth.omft.near',
        destinationAsset: 'nep141:usdc.omft.near',
        amount: '1000',
        refundTo: '0x1111111111111111111111111111111111111111',
        depositType: 'CONFIDENTIAL_INTENTS',
        refundType: 'CONFIDENTIAL_INTENTS',
        recipientType: 'DESTINATION_CHAIN',
        slippageTolerance: 100,
        recipient: '0x2222222222222222222222222222222222222222'
      },
      quote: {
        amountIn: '1000',
        amountOut: '990',
        minAmountOut: '980',
        depositAddress: 'deposit.near',
        deadline
      }
    }
    const input = {
      intent: {
        standard: 'erc191',
        payload: JSON.stringify({
          signer_id: '0x1111111111111111111111111111111111111111',
          receiver_id: 'deposit.near',
          deadline
        })
      },
      quote,
      signerId: '0x1111111111111111111111111111111111111111',
      sourceAsset: 'nep141:eth.omft.near',
      sourceAmountRaw: '1000',
      destinationAsset: 'nep141:usdc.omft.near',
      destinationAddress: '0x2222222222222222222222222222222222222222'
    }
    const quoteBinding = {
      originAsset: input.sourceAsset,
      destinationAsset: input.destinationAsset,
      amountRaw: input.sourceAmountRaw,
      signerId: input.signerId,
      recipient: input.destinationAddress,
      depositType: 'CONFIDENTIAL_INTENTS',
      refundType: 'CONFIDENTIAL_INTENTS',
      recipientType: 'DESTINATION_CHAIN',
      slippageBps: 100
    }
    expect(() => assertConfidentialQuoteBinding(quote, quoteBinding)).not.toThrow()
    expect(() =>
      assertConfidentialQuoteBinding(quote, { ...quoteBinding, amountRaw: '1001' })
    ).toThrow('requested funding route')
    expect(assertConfidentialIntentBinding(input).standard).toBe('erc191')
    expect(() =>
      assertConfidentialIntentBinding({
        ...input,
        signerId: '0x3333333333333333333333333333333333333333'
      })
    ).toThrow('approved signer')
    expect(() => assertConfidentialIntentBinding({ ...input, sourceAmountRaw: '1001' })).toThrow(
      'approved funding plan'
    )
  })

  test('fingerprints the exact frozen request so a re-quote cannot be replayed as the same batch', async () => {
    const request = {
      signer_id: '0x1111111111111111111111111111111111111111',
      withdraws: [{ sequence: 0, amount: '100', deposit_address: 'deposit-a' }]
    }
    const original = await fingerprintConfidentialValue(request)
    expect(await fingerprintConfidentialValue(request)).toBe(original)
    expect(
      await fingerprintConfidentialValue({
        ...request,
        withdraws: [{ sequence: 0, amount: '100', deposit_address: 'deposit-b' }]
      })
    ).not.toBe(original)
  })
})
