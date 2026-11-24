import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR,
  confidentialQuoteAppFeeUnrepresentable
} from '../../../src/background/confidential-funding-api.ts'
import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import { serializeConfidentialFundingPlan } from '../../../src/background/confidential-funding-store.ts'
import {
  createConfidentialFundingGraph,
  projectConfidentialAppFeeRejection
} from '../../../src/core/services/confidential-funding/index.ts'
import { confidentialPrivateTokenId } from '../../../src/core/services/confidential-funding/confidential-funding-portfolio.ts'
import { parseTransactionGraph } from '../../../src/core/transactions/domain/index.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { getActivityFailureLabel } from '../../../src/popup/services/multichain-activity-presentation.ts'

const scope = { keyDomainId: 'wallet:one', accountId: 'account:one' }
const signerId = '0x1111111111111111111111111111111111111111'
const peaAddress = '0x2222222222222222222222222222222222222222'
const assetId = 'eip155:1/slip44:60'
const protocolAssetId = 'nep141:eth.omft.near'
const APP_FEE_BPS = 50

function quotedFeeRaw(amountRaw, bps = APP_FEE_BPS) {
  return (BigInt(amountRaw) * BigInt(bps)) / 10_000n
}

function appFeeQuote({ amountIn, amountOut, appFees }) {
  return {
    quoteRequest: appFees === undefined ? {} : { appFees },
    quote: { amountIn, amountOut }
  }
}

test('a positive quoted app fee that truncates to 0 raw cannot be represented', () => {
  const fee = [{ recipient: 'platform.near', fee: APP_FEE_BPS }]
  expect(
    confidentialQuoteAppFeeUnrepresentable(
      appFeeQuote({ amountIn: '30', amountOut: '29', appFees: fee })
    )
  ).toBe(true)
  expect(
    confidentialQuoteAppFeeUnrepresentable(
      appFeeQuote({ amountIn: '200', amountOut: '199', appFees: fee })
    )
  ).toBe(false)
  expect(quotedFeeRaw('200')).toBe(1n)
  expect(
    confidentialQuoteAppFeeUnrepresentable(
      appFeeQuote({ amountIn: '10000', amountOut: '10000', appFees: fee })
    )
  ).toBe(true)
  expect(
    confidentialQuoteAppFeeUnrepresentable(
      appFeeQuote({ amountIn: '30', amountOut: '30', appFees: [] })
    )
  ).toBe(false)
  expect(
    confidentialQuoteAppFeeUnrepresentable(appFeeQuote({ amountIn: '30', amountOut: '30' }))
  ).toBe(false)
})

test('APP_FEE_REJECTED_2002 is labeled without changing the stored relay-failed code', () => {
  const graph = createConfidentialFundingGraph({
    planId: 'app-fee-label',
    operation: 'cluster',
    sourceDomain: 'shield',
    destinationDomain: 'private',
    scope,
    source: {
      chainId: 'eip155:1',
      assetId,
      amountRaw: '100',
      address: signerId
    },
    destination: {
      chainId: 'eip155:1',
      assetId,
      expectedAmountRaw: '100',
      address: peaAddress
    },
    withdrawDepositAddresses: ['leg-1.near', 'leg-2.near'],
    requiresDeposit: false,
    signedWithdrawFingerprint: 'a'.repeat(64),
    now: 1_000
  })
  const storedFailure = graph.segments.map(segment => segment.failure?.code)
  const projected = projectConfidentialAppFeeRejection(
    graph,
    {
      network: 'mainnet',
      transactionId: graph.root.id,
      keyDomainId: scope.keyDomainId,
      accountId: scope.accountId,
      errorStatus: 'APP_FEE_REJECTED_2002'
    },
    'mainnet'
  )
  expect(graph.root.intent.shield.errorStatus).toBeUndefined()
  expect(projected.segments.map(segment => segment.failure?.code)).toEqual(storedFailure)
  expect(projected.root.intent.shield.errorStatus).toBe('APP_FEE_REJECTED_2002')
  const parsed = parseTransactionGraph(projected)
  expect(parsed.root.intent.shield.errorStatus).toBe('APP_FEE_REJECTED_2002')
  expect(parsed.segments.map(segment => segment.failure?.code)).toEqual(storedFailure)
  const rejected = structuredClone(graph)
  rejected.root.intent.shield.errorStatus = 'OTHER'
  expect(() => parseTransactionGraph(rejected)).toThrow(/Invalid Shield transfer intent/)

  const snapshot = parsed.root.intent
  expect(getActivityFailureLabel('relay-failed', undefined, 'wallet-v2', snapshot)).toBe(
    'Fee does not match'
  )
  expect(getActivityFailureLabel('relay-failed', undefined, 'wallet-v2', graph.root.intent)).toBe(
    'Relay failed'
  )
  expect(getActivityFailureLabel('relay-failed')).toBe('Relay failed')
})

function clusterHarness() {
  const plans = new Map()
  const state = {
    now: 1_000,
    signatures: 0,
    intents: 0,
    batchSubmissions: 0,
    allowSigning: false,
    formalKeepsGross: false,
    quoteCalls: [],
    legs: new Map()
  }
  const deadline = new Date(61_000).toISOString()
  const balances = () => [
    {
      tokenId: confidentialPrivateTokenId(protocolAssetId),
      available: '100000',
      source: 'intents'
    }
  ]
  const store = {
    getPlan: async id => structuredClone(plans.get(id) ?? null),
    listPlans: async () => [...plans.values()].map(value => structuredClone(value)),
    listExternalDeposits: async () => [],
    putPlan: async value => {
      plans.set(value.planId, serializeConfidentialFundingPlan(value))
    },
    deletePlan: async id => {
      plans.delete(id)
    },
    getSession: async () => ({
      accessToken: 'session',
      refreshToken: 'refresh',
      expiresAt: 1_000_000,
      refreshExpiresAt: 2_000_000
    }),
    getBalanceSnapshot: async () => ({ balances: balances(), fresh: true, updatedAt: state.now }),
    putBalances: async () => {},
    getHistorySession: async () => ({
      token: 'wallet-history-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      queryAddress: signerId,
      principalType: 'wallet',
      mcaAccountId: null
    }),
    putHistorySession: async () => {}
  }
  const api = {
    getStatus: async () => ({ status: 'PROCESSING' }),
    getBalances: async () => balances(),
    quote: async input => {
      state.quoteCalls.push(input)
      const amount = BigInt(input.amountRaw)
      const fee = quotedFeeRaw(input.amountRaw)
      const amountOut =
        !input.dry && state.formalKeepsGross
          ? input.amountRaw
          : fee > 0n
            ? (amount - fee).toString()
            : (amount - 1n).toString()
      const depositAddress = `leg-${state.quoteCalls.length}.near`
      state.legs.set(depositAddress, input.amountRaw)
      return {
        correlationId: `quote-${state.quoteCalls.length}`,
        quoteRequest: {
          swapType: 'EXACT_INPUT',
          confidentiality: 'basic',
          originAsset: input.originAsset,
          destinationAsset: input.destinationAsset,
          amount: input.amountRaw,
          refundTo: input.refundTo ?? input.signerId,
          depositType: input.depositType,
          refundType: input.refundType,
          recipient: input.recipient,
          recipientType: input.recipientType,
          slippageTolerance: input.slippageBps,
          deadline,
          dry: input.dry,
          appFees: [{ recipient: 'platform.near', fee: APP_FEE_BPS }]
        },
        quote: {
          amountIn: input.amountRaw,
          amountOut,
          minAmountOut: amountOut,
          depositAddress,
          deadline,
          timeEstimate: 12
        }
      }
    },
    generateIntent: async input => {
      const nonce = Buffer.alloc(32, state.intents + 1).toString('base64')
      const amountRaw = state.legs.get(input.depositAddress)
      state.intents += 1
      return {
        intent: {
          standard: 'erc191',
          payload: JSON.stringify({
            verifying_contract: 'intents.far',
            signer_id: signerId,
            deadline,
            nonce,
            intents: [
              {
                intent: 'transfer',
                receiver_id: input.depositAddress,
                tokens: { [confidentialPrivateTokenId(protocolAssetId)]: amountRaw }
              }
            ]
          })
        },
        correlationId: `intent-${state.intents}`
      }
    },
    submitWithdraws: async () => {
      state.batchSubmissions += 1
      return { orderId: 'order-cluster' }
    },
    getPrivateOrders: async () => ({ orders: [], hasNextPage: false }),
    getPrivateOrderDetails: async () => []
  }
  const signer = {
    resolveIdentity: async chainId => ({
      address: signerId,
      peaAddress,
      addressIndex: 0,
      context: { chainAccount: { scope: { ...scope, chainId } } }
    }),
    signMessage: async input => {
      state.signatures += 1
      if (!state.allowSigning) throw new Error('unexpected signature')
      return { standard: 'erc191', payload: input.payload, signature: 'test-signature' }
    }
  }
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    api,
    store,
    signer,
    repository: new InMemoryTransactionRepository(),
    assets: {
      get: () => ({
        asset: { id: assetId, chainId: 'eip155:1', kind: 'native', namespace: 'slip44' },
        metadata: { symbol: 'ETH', decimals: 18 }
      }),
      list: () => []
    },
    evmNetworks: [],
    assetMappings: [{ assetId, protocolAssetId }],
    now: () => state.now,
    createId: () => `fee-${plans.size}`,
    scheduleMonitoring: async () => {}
  })
  const request = amountRaw => ({
    network: 'mainnet',
    ...scope,
    operation: 'cluster',
    sourceDomain: 'shield',
    destinationDomain: 'private',
    source: {
      chainId: 'eip155:1',
      chainName: 'eth',
      assetId,
      protocolAssetId,
      amountRaw
    },
    destination: { chainId: 'eip155:1', chainName: 'eth', assetId, protocolAssetId },
    slippageBps: 100
  })
  return { coordinator, state, request }
}

test('does not submit a cluster whose quoted fee rounds to 0 raw', async () => {
  const { coordinator, state, request } = clusterHarness()
  await expect(coordinator.preview(request('100'))).rejects.toThrow(
    CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR
  )
  expect(state.quoteCalls).toHaveLength(5)
  expect(state.quoteCalls.every(quote => quotedFeeRaw(quote.amountRaw) === 0n)).toBe(true)
  expect(state.batchSubmissions).toBe(0)
  expect(state.signatures).toBe(0)

  state.quoteCalls.length = 0
  const retried = await coordinator.preview(request('500'))
  expect(state.quoteCalls).toHaveLength(5)
  expect(state.quoteCalls.slice(0, 3).some(quote => quotedFeeRaw(quote.amountRaw) === 0n)).toBe(
    true
  )
  expect(state.quoteCalls.slice(3).every(quote => quotedFeeRaw(quote.amountRaw) >= 1n)).toBe(true)
  expect(state.quoteCalls.slice(3).reduce((sum, quote) => sum + BigInt(quote.amountRaw), 0n)).toBe(
    500n
  )
  expect(retried.amountOutRaw).toBe('498')
  expect(state.batchSubmissions).toBe(0)
})

test('submits a cluster only when every leg can represent the quoted fee', async () => {
  const rejected = clusterHarness()
  rejected.state.formalKeepsGross = true
  const rejectedReview = await rejected.coordinator.prepare(rejected.request('3000'))
  expect(rejected.state.quoteCalls.every(quote => quote.dry)).toBe(true)
  expect(rejected.state.quoteCalls.every(quote => quotedFeeRaw(quote.amountRaw) >= 1n)).toBe(true)
  await expect(
    rejected.coordinator.confirm(rejectedReview.planId, rejectedReview.payloadFingerprint)
  ).rejects.toThrow(CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR)
  expect(rejected.state.batchSubmissions).toBe(0)
  expect(rejected.state.signatures).toBe(0)
  expect(rejected.state.intents).toBe(0)

  const accepted = clusterHarness()
  accepted.state.allowSigning = true
  const review = await accepted.coordinator.prepare(accepted.request('3000'))
  const confirmed = await accepted.coordinator.confirm(review.planId, review.payloadFingerprint)
  await accepted.coordinator.continuePlan(confirmed.planId)
  expect(accepted.state.quoteCalls.filter(quote => !quote.dry)).toHaveLength(3)
  expect(
    accepted.state.quoteCalls
      .filter(quote => !quote.dry)
      .every(quote => quotedFeeRaw(quote.amountRaw) >= 1n)
  ).toBe(true)
  expect(accepted.state.intents).toBe(3)
  expect(accepted.state.signatures).toBe(3)
  expect(accepted.state.batchSubmissions).toBe(1)
})

test('previews a representable 50 bps fee on a 10^21-scale amount', async () => {
  const { coordinator, state, request } = clusterHarness()
  const amountRaw = (10n ** 21n).toString()
  const preview = await coordinator.preview(request(amountRaw))
  expect(state.quoteCalls).toHaveLength(3)
  expect(state.quoteCalls.every(quote => quote.dry)).toBe(true)
  expect(state.quoteCalls.every(quote => quotedFeeRaw(quote.amountRaw) >= 1n)).toBe(true)
  expect(state.quoteCalls.reduce((sum, quote) => sum + BigInt(quote.amountRaw), 0n)).toBe(
    BigInt(amountRaw)
  )
  expect(BigInt(preview.amountOutRaw) < BigInt(amountRaw)).toBe(true)
  expect(state.batchSubmissions).toBe(0)
  expect(state.signatures).toBe(0)
})
