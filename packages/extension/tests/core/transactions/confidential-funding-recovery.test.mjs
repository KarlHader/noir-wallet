import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import { ConfidentialFundingApiError } from '../../../src/background/confidential-funding-api.ts'
import { serializeConfidentialFundingPlan } from '../../../src/background/confidential-funding-store.ts'
import {
  createConfidentialFundingGraph,
  fingerprintConfidentialValue,
  fingerprintDirectConfidentialApproval
} from '../../../src/core/services/confidential-funding/index.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { createEvmTransferGraph } from '../../../src/infrastructure/chains/evm/evm-transaction-graph.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'
import { parseTransactionGraph } from '../../../src/core/transactions/domain/index.ts'
import { confidentialPrivateTokenId } from '../../../src/core/services/confidential-funding/confidential-funding-portfolio.ts'
import { ZCASH_CHAIN_IDS } from '../../../src/core/chains/registry/chain-ids.ts'
import { createConfidentialFundingClient } from '../../../src/popup/services/confidential-funding-client.ts'
import { getActivityAction } from '../../../src/popup/services/activity-action-label.ts'
import {
  getActivityDetailTitle,
  getActivityRouteTitle
} from '../../../src/popup/services/multichain-activity-presentation.ts'

const scope = { keyDomainId: 'wallet:one', accountId: 'account:one' }
const signerId = '0x1111111111111111111111111111111111111111'
const peaAddress = '0x2222222222222222222222222222222222222222'
const now = 1_000

class SignedTransactionRepository extends InMemoryTransactionRepository {
  async create(graph) {
    assertPersistableTransactionGraph(parseTransactionGraph(graph))
    return super.create(graph)
  }
}

async function harness(
  phase = 'submitting',
  direct = false,
  cluster = false,
  depositBacked = false
) {
  const depositTransactionHash = `0x${'ab'.repeat(32)}`
  const withdraws = (direct ? [0] : [0, 1, 2]).map(sequence => ({
    sequence,
    sourceAmountRaw: '1000',
    amountRaw: '990',
    depositAddress: `deposit-${sequence}.near`,
    destinationAddress: peaAddress,
    destinationChain: 'eth',
    token: 'nep141:eth.omft.near',
    deadline: 60_000,
    status: phase === 'processing' ? 'PROCESSING' : 'SIGNED',
    signedPayload: { standard: 'erc191', payload: `frozen-${sequence}`, signature: 'signature' }
  }))
  const frozenRequest = {
    from_amount: direct ? '1000' : '3000',
    from_chain: 'eth',
    from_token: 'nep141:eth.omft.near',
    mode: 'TRANSFER',
    signer_id: signerId,
    withdraws: withdraws.map(row => ({
      amount: row.amountRaw,
      deposit_address: row.depositAddress,
      destination_address: peaAddress,
      destination_chain: 'eth',
      execution_type: 'CONFIDENTIAL_1CLICK',
      sequence: row.sequence,
      signed_payload: row.signedPayload,
      token: row.token
    }))
  }
  const plans = new Map()
  const initial = {
    schemaVersion: 1,
    planId: 'recovery-one',
    transactionId: 'tx:confidential:recovery-one',
    network: 'mainnet',
    ...(cluster
      ? {
          operation: 'cluster',
          sourceDomain: depositBacked ? 'public' : 'shield',
          destinationDomain: 'private'
        }
      : direct
        ? {
            operation: 'withdraw',
            sourceDomain: 'shield',
            destinationDomain: 'private'
          }
        : {}),
    ...scope,
    phase,
    source: {
      chainId: 'eip155:1',
      chainName: 'eth',
      assetId: 'eip155:1/slip44:60',
      protocolAssetId: 'nep141:eth.omft.near',
      amountRaw: direct ? '1000' : '3000',
      address: signerId
    },
    destination: {
      chainId: 'eip155:1',
      chainName: 'eth',
      assetId: 'eip155:1/slip44:60',
      protocolAssetId: 'nep141:eth.omft.near',
      address: peaAddress
    },
    signerId,
    addressIndex: 0,
    slippageBps: 100,
    requiresDeposit: depositBacked,
    confidentialBaselineRaw: direct ? '1000' : '3000',
    ...(depositBacked
      ? {
          depositQuote: {
            correlationId: 'deposit-quote',
            quoteRequest: {},
            quote: {
              amountIn: '3000',
              amountOut: '3000',
              minAmountOut: '3000',
              depositAddress: 'origin-deposit.near',
              deadline: new Date(60_000).toISOString()
            }
          },
          preparedDeposit: {
            commandId: 'origin-command',
            payloadFingerprint: 'b'.repeat(64),
            expiresAt: 60_000,
            preparedTransfer: {},
            transactionHash: depositTransactionHash
          }
        }
      : {}),
    approvalFingerprint: 'a'.repeat(64),
    approvalExpiresAt: 50_000,
    expectedOutputRaw: direct ? '990' : '2970',
    minimumOutputRaw: direct ? '980' : '2940',
    splitSourceAmounts: direct ? ['1000'] : ['1000', '1000', '1000'],
    withdraws,
    requestFingerprint: await fingerprintConfidentialValue(frozenRequest),
    ...(phase === 'submitting' || cluster
      ? {
          frozenRequest,
          ...(phase === 'processing' ? { orderId: 'order-one' } : {})
        }
      : { orderId: 'order-one' }),
    createdAt: now,
    updatedAt: now
  }
  plans.set(initial.planId, structuredClone(initial))
  const state = {
    now,
    submissions: [],
    intentSignatures: 0,
    authSignatures: 0,
    monitoring: 0,
    refreshes: 0,
    refreshTargets: [],
    statusRequests: [],
    originStatus: 'FAILED',
    statuses: withdraws.map(() => (phase === 'processing' ? 'PROCESSING' : 'PENDING_DEPOSIT')),
    settledOutputs: new Map(),
    session: {
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: 1_000_000,
      refreshExpiresAt: 2_000_000
    },
    submitError: null,
    statusError: null,
    switchAccountAfterStatus: false,
    processingHashes: new Set(),
    identityAccount: scope.accountId,
    batchSubmissions: 0,
    acceptedOrder: null,
    historySignatures: 0,
    historyAuthError: null,
    depositSignatures: 0,
    cancelledDeposits: 0,
    historyToken: {
      token: 'wallet-history-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      queryAddress: signerId,
      principalType: 'wallet',
      mcaAccountId: null
    }
  }
  const store = {
    async getPlan(id) {
      return structuredClone(plans.get(id) ?? null)
    },
    async putPlan(plan) {
      plans.set(plan.planId, serializeConfidentialFundingPlan(plan))
    },
    async listPlans() {
      return [...plans.values()].map(plan => structuredClone(plan))
    },
    async listExternalDeposits() {
      return []
    },
    async getSession() {
      return state.session
    },
    async putSession(_network, _domain, _account, session) {
      state.session = session
    },
    async deleteSession() {
      state.session = null
    },
    async putBalances() {},
    async getHistorySession() {
      return state.historyToken
    },
    async putHistorySession(_network, _domain, _account, token) {
      state.historyToken = token
    },
    async deleteHistorySession() {
      state.historyToken = null
    }
  }
  const api = {
    async submitWithdraws() {
      state.batchSubmissions += 1
      if (state.submitError) throw state.submitError
      return { orderId: 'order-one' }
    },
    async getPrivateOrders() {
      return { orders: state.acceptedOrder ? [state.acceptedOrder] : [], hasNextPage: false }
    },
    async getPrivateOrderDetails() {
      return state.acceptedOrder ? [state.acceptedOrder] : []
    },
    async createOrderAuthChallenge() {
      if (state.historyAuthError) throw state.historyAuthError
      return { message: 'history-challenge' }
    },
    async authenticateOrderChallenge() {
      return {
        token: 'renewed-history-token',
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        queryAddress: signerId,
        principalType: 'wallet',
        mcaAccountId: null
      }
    },
    async submitIntent(signedData) {
      state.submissions.push(structuredClone(signedData))
      if (state.submitError) throw state.submitError
      const sequence = Number(signedData.payload.split('-').at(-1))
      return { intentHash: `intent-${sequence}`, correlationId: `submit-${sequence}` }
    },
    async getStatus(address) {
      state.statusRequests.push(address)
      if (state.statusError) throw state.statusError
      if (address === 'origin-deposit.near') return { status: state.originStatus }
      const sequence = initial.withdraws.find(row => row.depositAddress === address).sequence
      const status = state.statuses[sequence]
      if (state.switchAccountAfterStatus) {
        state.identityAccount = 'other-account'
        state.switchAccountAfterStatus = false
      }
      if (status === null) throw new ConfidentialFundingApiError('unavailable', 503, false)
      return {
        status,
        ...(status === 'SUCCESS' && state.settledOutputs.has(sequence)
          ? { settledAmountOutRaw: state.settledOutputs.get(sequence) }
          : {}),
        ...(status === 'SUCCESS' || state.processingHashes.has(sequence)
          ? { transactionHash: `hash-${sequence}` }
          : {})
      }
    },
    async getBalances() {
      return []
    },
    async createAuthPayload() {
      return { payload: 'authorize-session' }
    },
    async authenticate() {
      return { accessToken: 'new-token', expiresAt: 1_000_000, refreshExpiresAt: 2_000_000 }
    }
  }
  const signer = {
    async resolveIdentity() {
      return {
        address: signerId,
        peaAddress,
        addressIndex: 0,
        context: {
          chainAccount: {
            scope: { ...scope, accountId: state.identityAccount, chainId: 'eip155:1' }
          }
        }
      }
    },
    async signMessage({ payload }) {
      if (payload === 'history-challenge') {
        state.historySignatures += 1
        return { standard: 'erc191', payload, signature: 'history-signature' }
      }
      if (payload !== 'authorize-session') {
        state.intentSignatures += 1
        throw new Error('Recovery must not re-sign withdraws')
      }
      state.authSignatures += 1
      return { standard: 'erc191', payload, signature: 'auth-signature' }
    },
    async confirmTransaction() {
      state.depositSignatures += 1
      throw new Error('Unexpected deposit signature')
    },
    async cancelTransaction() {
      state.cancelledDeposits += 1
    }
  }
  const repository = new SignedTransactionRepository()
  const graph = createConfidentialFundingGraph({
    planId: initial.planId,
    ...(cluster
      ? {
          operation: 'cluster',
          sourceDomain: depositBacked ? 'public' : 'shield',
          destinationDomain: 'private'
        }
      : direct
        ? {
            operation: 'withdraw',
            sourceDomain: 'shield',
            destinationDomain: 'private'
          }
        : {}),
    scope,
    source: {
      ...initial.source,
      ...(depositBacked ? { transactionHash: depositTransactionHash } : {})
    },
    destination: { ...initial.destination, expectedAmountRaw: initial.expectedOutputRaw },
    withdrawDepositAddresses: withdraws.map(row => row.depositAddress),
    requiresDeposit: depositBacked,
    signedWithdrawFingerprint: initial.requestFingerprint,
    now
  })
  await repository.create({
    ...graph,
    root: depositBacked ? { ...graph.root, status: 'confirming' } : graph.root,
    segments: graph.segments.map(segment =>
      depositBacked && segment.role === 'origin'
        ? { ...segment, status: 'final' }
        : segment.role === 'relay' || segment.role === 'destination'
          ? { ...segment, status: 'confirming' }
          : segment
    )
  })
  const restart = () =>
    new ConfidentialFundingCoordinator({
      network: 'mainnet',
      api,
      store,
      signer,
      repository,
      assets: { list: () => [] },
      evmNetworks: [],
      assetMappings: [],
      now: () => state.now,
      scheduleMonitoring: async () => {
        state.monitoring += 1
      },
      refreshPortfolio: async target => {
        state.refreshes += 1
        state.refreshTargets.push(target ?? null)
      }
    })
  return { initial, state, store, repository, restart }
}

function directPreparationHarness(protocolTokens, getNativeZecActiveAccount) {
  const plans = new Map()
  const state = {
    now: 1_000,
    signatures: 0,
    preparedDeposits: 0,
    allowSigning: false,
    identityChains: [],
    signingChains: [],
    formalQuotes: 0,
    formalQuoteAppFees: undefined,
    identityAccount: scope.accountId,
    quoteCalls: [],
    quoteOverride: undefined,
    settlementStatus: undefined,
    lastQuoteAmountRaw: undefined,
    lastQuoteDeadline: undefined,
    session: {
      accessToken: 'session',
      refreshToken: 'refresh',
      expiresAt: 1_000_000,
      refreshExpiresAt: 2_000_000
    }
  }
  const assetId = 'eip155:1/slip44:60'
  const protocolAssetId = 'nep141:eth.omft.near'
  const swapDestinationAssetId = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const swapDestinationProtocolId =
    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'
  const zcashAssetId = `${ZCASH_CHAIN_IDS.mainnet}/slip44:133`
  const zcashProtocolId = 'nep141:zec.omft.near'
  const nativeAsset = {
    asset: { id: assetId, chainId: 'eip155:1', kind: 'native', namespace: 'slip44' },
    metadata: { symbol: 'ETH', decimals: 18 },
    verification: 'verified'
  }
  const balances = [
    {
      tokenId: confidentialPrivateTokenId(protocolAssetId),
      available: '100',
      source: 'intents'
    },
    {
      tokenId: confidentialPrivateTokenId(zcashProtocolId),
      available: '140000',
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
    getSession: async () => state.session,
    getBalanceSnapshot: async () => ({ balances, fresh: true, updatedAt: state.now }),
    putBalances: async () => {}
  }
  const signer = {
    resolveIdentity: async chainId => {
      state.identityChains.push(chainId)
      return {
        address: signerId,
        peaAddress,
        addressIndex: 0,
        context: {
          chainAccount: { scope: { ...scope, accountId: state.identityAccount, chainId } }
        }
      }
    },
    prepareTransaction: async () => {
      state.preparedDeposits += 1
      return {
        commandId: `deposit-${state.preparedDeposits}`,
        payloadFingerprint: 'a'.repeat(64),
        expiresAt: state.now + 60_000
      }
    },
    cancelTransaction: async () => {},
    signMessage: async input => {
      state.signatures += 1
      state.signingChains.push(input.chainId)
      if (state.allowSigning)
        return { standard: 'erc191', payload: input.payload, signature: 'test-signature' }
      throw new Error('unexpected signature')
    }
  }
  const api = {
    getStatus: async () => state.settlementStatus ?? { status: 'PROCESSING' },
    getBalances: async () => balances,
    quote: async input => {
      state.lastQuoteRequest = input
      state.quoteCalls.push(input)
      if (!input.dry) {
        state.formalQuotes += 1
        if (input.recipientType !== 'CONFIDENTIAL_INTENTS' && !state.formalQuoteAppFees) {
          throw new Error('formal quote unavailable in this test')
        }
      }
      state.lastQuoteAmountRaw = input.amountRaw
      state.lastQuoteDeadline = new Date(state.now + 60_000).toISOString()
      return {
        correlationId: 'quote-one',
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
          deadline: state.lastQuoteDeadline,
          dry: input.dry,
          ...(input.dry
            ? { appFees: [{ recipient: 'platform.near', fee: 50 }] }
            : {
                appFees: state.formalQuoteAppFees ?? [{ recipient: 'platform.near', fee: 50 }]
              })
        },
        quote: {
          amountIn: input.amountRaw,
          amountOut: input.amountRaw,
          minAmountOut: input.amountRaw,
          depositAddress: 'deposit.near',
          deadline: state.lastQuoteDeadline,
          ...(state.quoteOverride?.(input) ?? {})
        }
      }
    },
    generateIntent: async () => ({
      intent: {
        standard: 'erc191',
        payload: JSON.stringify({
          verifying_contract: 'intents.far',
          signer_id: signerId,
          deadline: state.lastQuoteDeadline,
          nonce: Buffer.alloc(32, 1).toString('base64'),
          intents: [
            {
              intent: 'transfer',
              receiver_id: 'deposit.near',
              tokens: {
                [confidentialPrivateTokenId(state.lastQuoteRequest.originAsset)]:
                  state.lastQuoteAmountRaw
              }
            }
          ]
        })
      },
      correlationId: 'intent-one'
    })
  }
  const repository = new InMemoryTransactionRepository()
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    getNativeZecActiveAccount,
    api,
    store,
    signer,
    repository,
    assets: {
      get: id =>
        id === assetId
          ? nativeAsset
          : {
              asset: { id, chainId: id.split('/')[0] },
              metadata: { decimals: id === zcashAssetId ? 8 : 18 }
            },
      list: () => [nativeAsset]
    },
    evmNetworks: [],
    ...(protocolTokens ? { protocolTokens } : {}),
    assetMappings: [
      { assetId, protocolAssetId },
      { assetId: swapDestinationAssetId, protocolAssetId: swapDestinationProtocolId },
      { assetId: zcashAssetId, protocolAssetId: zcashProtocolId }
    ],
    now: () => state.now,
    createId: () => `direct-${plans.size}-${state.now}`,
    scheduleMonitoring: async () => {}
  })
  const request = (amountRaw, accountId = scope.accountId) => ({
    network: 'mainnet',
    keyDomainId: scope.keyDomainId,
    accountId,
    operation: 'withdraw',
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
  return {
    coordinator,
    repository,
    state,
    plans,
    request,
    swapDestinationAssetId,
    swapDestinationProtocolId,
    zcashAssetId,
    zcashProtocolId
  }
}

test.describe('confidential funding persisted recovery', () => {
  test('spends a mapped Confidential ZEC balance through an EVM signer without enabling Zcash on-chain sends', async () => {
    const h = directPreparationHarness([
      { assetId: 'nep141:eth.omft.near', blockchain: 'eth', decimals: 18 },
      { assetId: 'nep141:zec.omft.near', blockchain: 'zec', decimals: 8 }
    ])
    const source = {
      chainId: ZCASH_CHAIN_IDS.mainnet,
      chainName: 'zec',
      assetId: h.zcashAssetId,
      protocolAssetId: h.zcashProtocolId,
      amountRaw: '100000'
    }
    const recipient = '0x3333333333333333333333333333333333333333'
    const withdraw = {
      ...h.request('100000'),
      source,
      destinationDomain: 'public',
      externalRecipient: recipient
    }
    const review = await h.coordinator.prepare(withdraw)
    expect(review).toMatchObject({ sourceAmountRaw: '100000', destinationAddress: recipient })
    expect(h.state.lastQuoteRequest).toMatchObject({
      originAsset: h.zcashProtocolId,
      destinationAsset: 'nep141:eth.omft.near',
      amountRaw: '100000',
      signerId,
      recipient,
      depositType: 'CONFIDENTIAL_INTENTS'
    })
    expect(h.state.identityChains).toEqual(['eip155:1', 'eip155:1'])
    await expect(
      h.coordinator.prepare({ ...withdraw, source: { ...source, amountRaw: '50000' } })
    ).rejects.toThrow('insufficient')
    await expect(
      h.coordinator.prepare({
        ...withdraw,
        sourceDomain: 'public',
        source: { ...source, amountRaw: '1000' }
      })
    ).rejects.toThrow('EVM signing chain')
    const zecDestination = {
      chainId: source.chainId,
      chainName: source.chainName,
      assetId: source.assetId,
      protocolAssetId: source.protocolAssetId
    }
    await expect(
      h.coordinator.prepare({ ...withdraw, destination: zecDestination })
    ).rejects.toThrow('request is invalid')
    h.state.formalQuoteAppFees = [{ recipient: 'platform.near', fee: 50 }]
    await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'unexpected signature'
    )
    expect(h.state.signingChains).toEqual(['eip155:1'])
    const zecRecipient = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F'
    const zecReview = await h.coordinator.prepare({
      ...withdraw,
      destination: zecDestination,
      externalRecipient: zecRecipient
    })
    expect(zecReview.destinationAddress).toBe(zecRecipient)
    expect(h.state.lastQuoteRequest).toMatchObject({
      destinationAsset: h.zcashProtocolId,
      recipient: zecRecipient,
      recipientType: 'DESTINATION_CHAIN'
    })
    expect(h.state.identityChains.slice(-2)).toEqual(['eip155:1', 'eip155:1'])
  })

  test('binds Confidential ZEC Move to the current account native receive address and reviewed purpose', async () => {
    const transparent = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F'
    const unified =
      'u1nvgt6yr35mhc9wdf4wckvl38476vqy96dx3cwkfdwy4jet9300l5v8l2yg27ql7w9qwm0lf8kncnj9nus4mgete06j3cu3mhrqvstg6swvdya6xgzwhh6a9xxdhxkavvvmztqeuaurjtqfk3dzetuzgnu0zjvmdpe8ehvj53sy6yhzxj'
    let active = {
      network: 'mainnet',
      walletId: scope.keyDomainId,
      accountId: scope.accountId,
      refundAddresses: [transparent, unified]
    }
    const h = directPreparationHarness(undefined, () => active)
    const zec = {
      chainId: ZCASH_CHAIN_IDS.mainnet,
      chainName: 'zec',
      assetId: h.zcashAssetId,
      protocolAssetId: h.zcashProtocolId
    }
    const request = {
      ...h.request('10000'),
      purpose: 'move',
      source: { ...zec, amountRaw: '10000' },
      destination: zec,
      destinationDomain: 'public',
      externalRecipient: transparent
    }
    for (const invalid of [
      { externalRecipient: signerId },
      { accountId: 'account:other' },
      { destination: h.request('10').destination },
      { purpose: 'send' }
    ]) {
      await expect(h.coordinator.prepare({ ...request, ...invalid })).rejects.toThrow(
        'ZEC transfers must use a receive address from the current account'
      )
    }
    expect(h.state.quoteCalls).toHaveLength(0)
    for (const recipient of [transparent, unified]) {
      const review = await h.coordinator.prepare({ ...request, externalRecipient: recipient })
      expect(review).toMatchObject({ purpose: 'move', destinationAddress: recipient })
      const stored = await h.coordinator.getPlan(review.planId)
      const client = createConfidentialFundingClient(async message => ({
        success: true,
        result: message.type === 'PREPARE_CONFIDENTIAL_FUNDING' ? review : stored
      }))
      await expect(client.prepare(request)).resolves.toMatchObject({
        purpose: 'move',
        destinationAddress: recipient
      })
      await expect(client.get(review.planId)).resolves.toMatchObject({
        purpose: 'move',
        externalRecipient: recipient
      })
      expect(serializeConfidentialFundingPlan(stored)).toMatchObject({
        purpose: 'move',
        externalRecipient: recipient
      })
      active = { ...active, accountId: 'account:other' }
      await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
        'ZEC transfers must use a receive address from the current account'
      )
      active = { ...active, accountId: scope.accountId }
      h.plans.set(review.planId, { ...stored, purpose: undefined })
      await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
        'approval content changed'
      )
      h.plans.set(review.planId, stored)
      await h.coordinator.cancel(review.planId)
    }
    expect(h.state.signatures).toBe(0)
    const review = await h.coordinator.prepare(request)
    h.state.allowSigning = true
    h.state.formalQuoteAppFees = [{ recipient: 'platform.near', fee: 50 }]
    await h.coordinator.confirm(review.planId, review.payloadFingerprint)
    h.state.settlementStatus = {
      status: 'SUCCESS',
      transactionHash: '1'.repeat(64),
      settledAmountOutRaw: '11000'
    }
    await h.coordinator.continuePlan(review.planId)
    const graph = await h.repository.get(scope, review.transactionId)
    expect(graph.root.intent).toMatchObject({
      direction: 'self',
      shield: { operation: 'withdraw', sourceDomain: 'shield', destinationDomain: 'public' },
      recipient: { address: transparent },
      primaryAmount: { assetId: h.zcashAssetId, amountRaw: '10000' }
    })
    expect(graph.segments.find(segment => segment.role === 'destination').evidence).toMatchObject({
      settledAmount: { assetId: h.zcashAssetId, amountRaw: '11000' }
    })
  })

  test('binds a Confidential swap withdrawal to the current account native ZEC recipient', async () => {
    const recipient = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F'
    let active = {
      network: 'mainnet',
      walletId: scope.keyDomainId,
      accountId: scope.accountId,
      refundAddresses: [recipient]
    }
    const h = directPreparationHarness(undefined, () => active)
    const request = {
      ...h.request('50'),
      purpose: 'native-zec-swap',
      destinationDomain: 'public',
      destination: {
        chainId: ZCASH_CHAIN_IDS.mainnet,
        chainName: 'zec',
        assetId: h.zcashAssetId,
        protocolAssetId: h.zcashProtocolId
      },
      externalRecipient: recipient
    }
    await expect(
      h.coordinator.prepare({
        ...request,
        externalRecipient: 't1aJHc8RvkGgoLqtVfuVX8VT2TcqjJrUKUP'
      })
    ).rejects.toThrow('Native ZEC swap must receive into the current account')
    expect(h.state.quoteCalls).toHaveLength(0)
    h.state.formalQuoteAppFees = [{ recipient: 'platform.near', fee: 50 }]
    const review = await h.coordinator.prepare(request)
    expect(review).toMatchObject({
      purpose: 'native-zec-swap',
      operation: 'withdraw',
      destinationAddress: recipient,
      slippageBps: 100
    })
    expect(h.state.lastQuoteRequest).toMatchObject({
      originAsset: 'nep141:eth.omft.near',
      destinationAsset: h.zcashProtocolId,
      recipient,
      recipientType: 'DESTINATION_CHAIN'
    })
    expect(h.state.formalQuotes).toBe(1)
    expect(h.state.lastQuoteRequest.dry).toBe(false)
    active = { ...active, accountId: 'account:other' }
    await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'Native ZEC swap must receive into the current account'
    )
    active = { ...active, accountId: scope.accountId }
    h.state.allowSigning = true
    const plan = await h.coordinator.confirm(review.planId, review.payloadFingerprint)
    expect(h.state.formalQuotes).toBe(1)
    expect(plan.frozenRequest).toMatchObject({
      mode: 'SWAP',
      from_token: 'nep141:eth.omft.near',
      withdraws: [{ destination_address: recipient, token: h.zcashProtocolId }]
    })
    const graph = await h.repository.get(scope, review.transactionId)
    expect(graph.root.kind).toBe('swap')
    expect(graph.root.intent).toMatchObject({
      direction: 'self',
      shield: { operation: 'swap', sourceDomain: 'shield', destinationDomain: 'public' },
      recipient: { address: recipient }
    })
    expect(graph.segments.find(segment => segment.role === 'destination').target).toMatchObject({
      kind: 'onchain',
      chainId: ZCASH_CHAIN_IDS.mainnet
    })
    const activity = {
      ...graph.root,
      source: 'wallet-v2',
      snapshot: graph.root.intent,
      segments: graph.segments
    }
    expect(getActivityRouteTitle(activity, {})).toBe('Swap')
    expect(getActivityDetailTitle(activity)).toBe('Shield Swap')
    expect(getActivityAction(activity, { viewedDomain: 'shield' })).toEqual({
      label: 'Swap',
      side: 'none'
    })
    expect(
      getActivityAction(
        activity,
        { viewedDomain: 'shield', shieldProvider: 'near-confidential' },
        {
          destinationFundingSource: 'transparent'
        }
      )
    ).toEqual({ label: 'Swap', side: 'none' })
    expect(getActivityAction(activity, { viewedDomain: 'public' })).toEqual({
      label: 'Receive',
      side: 'destination'
    })
  })

  test('quotes a Confidential ZEC to EVM swap and an EVM to Confidential ZEC swap', async () => {
    const h = directPreparationHarness([
      { assetId: 'nep141:eth.omft.near', blockchain: 'eth', decimals: 18 },
      { assetId: 'nep141:zec.omft.near', blockchain: 'zec', decimals: 8 }
    ])
    const zec = {
      chainId: ZCASH_CHAIN_IDS.mainnet,
      chainName: 'zec',
      assetId: h.zcashAssetId,
      protocolAssetId: h.zcashProtocolId
    }
    const outgoing = await h.coordinator.prepare({
      ...h.request('100000'),
      operation: 'swap',
      destinationDomain: 'shield',
      source: { ...zec, amountRaw: '100000' }
    })
    expect(outgoing).toMatchObject({ operation: 'swap', sourceAmountRaw: '100000' })
    expect(h.state.lastQuoteRequest).toMatchObject({
      originAsset: h.zcashProtocolId,
      destinationAsset: 'nep141:eth.omft.near',
      recipientType: 'CONFIDENTIAL_INTENTS'
    })
    const incoming = await h.coordinator.prepare({
      ...h.request('50'),
      operation: 'swap',
      destinationDomain: 'shield',
      destination: zec
    })
    expect(incoming).toMatchObject({ operation: 'swap', sourceAmountRaw: '50' })
    expect(h.state.lastQuoteRequest).toMatchObject({
      originAsset: 'nep141:eth.omft.near',
      destinationAsset: h.zcashProtocolId,
      recipientType: 'CONFIDENTIAL_INTENTS'
    })
    expect(h.state.identityChains).toEqual(Array(4).fill('eip155:1'))
    await expect(
      h.coordinator.confirm(incoming.planId, incoming.payloadFingerprint)
    ).rejects.toThrow('unexpected signature')
    expect(h.state.signingChains).toEqual(['eip155:1'])
    await expect(
      h.coordinator.prepare({
        ...h.request('10'),
        operation: 'swap',
        destinationDomain: 'shield',
        source: { ...zec, amountRaw: '10' },
        destination: zec
      })
    ).rejects.toThrow('route is invalid')
  })
  test('rejects a Shield source whose catalog precision changed before preparation', async () => {
    const h = directPreparationHarness([
      { assetId: 'nep141:eth.omft.near', blockchain: 'eth', decimals: 6 }
    ])
    await expect(h.coordinator.prepare(h.request('60'))).rejects.toThrow('asset catalog changed')
    expect(h.state.formalQuotes).toBe(0)
    expect(h.plans.size).toBe(0)
  })

  test('previews Shield sends and swaps without creating plans, reserving balances, or signing', async () => {
    const h = directPreparationHarness()
    const send = h.request('60')
    const sendPreview = await h.coordinator.preview(send)
    expect(sendPreview).toMatchObject({
      amountOutRaw: '60',
      minimumOutputRaw: '60',
      appFeeBps: 50,
      expiresAt: h.state.now + 60_000
    })
    expect(h.state.lastQuoteRequest).toMatchObject({
      dry: true,
      recipientType: 'DESTINATION_CHAIN'
    })

    const swap = {
      ...send,
      operation: 'swap',
      destinationDomain: 'shield',
      destination: {
        chainId: 'eip155:1',
        chainName: 'eth',
        assetId: h.swapDestinationAssetId,
        protocolAssetId: h.swapDestinationProtocolId
      }
    }
    await h.coordinator.preview(swap)
    expect(h.state.lastQuoteRequest).toMatchObject({
      dry: true,
      recipientType: 'CONFIDENTIAL_INTENTS',
      recipient: signerId
    })
    expect(h.plans.size).toBe(0)
    expect(h.state.formalQuotes).toBe(0)
    expect(h.state.signatures).toBe(0)

    await expect(h.coordinator.preview(h.request('60', 'account:other'))).rejects.toThrow(
      'account or network changed'
    )
    h.state.session.expiresAt = h.state.now + 60_000
    await expect(h.coordinator.preview(send)).rejects.toThrow('Refresh Shield balances')
    expect(h.plans.size).toBe(0)
    expect(h.state.formalQuotes).toBe(0)
    expect(h.state.signatures).toBe(0)
  })

  test('previews Cluster from dry deposit and split quotes without preparing or reserving funds', async () => {
    const h = directPreparationHarness()
    h.state.quoteOverride = input =>
      input.depositType === 'ORIGIN_CHAIN'
        ? {
            amountOut: '57',
            minAmountOut: '56',
            deadline: new Date(h.state.now + 30_000).toISOString(),
            timeEstimate: 8
          }
        : {
            amountOut: (BigInt(input.amountRaw) - 1n).toString(),
            minAmountOut: (BigInt(input.amountRaw) - 2n).toString(),
            timeEstimate: 17
          }
    const cluster = {
      ...h.request('60'),
      operation: 'cluster',
      sourceDomain: 'public'
    }
    const session = h.state.session
    h.state.session = null
    const preview = await h.coordinator.preview(cluster)
    expect(preview).toEqual({
      amountOutRaw: '54',
      minimumOutputRaw: '51',
      expiresAt: h.state.now + 30_000,
      timeEstimateSeconds: 25
    })
    expect(h.state.quoteCalls).toHaveLength(4)
    expect(h.state.quoteCalls.every(quote => quote.dry)).toBe(true)
    expect(h.state.quoteCalls[0]).toMatchObject({
      amountRaw: '60',
      depositType: 'ORIGIN_CHAIN',
      recipientType: 'CONFIDENTIAL_INTENTS',
      referral: 'noir_receive'
    })
    expect(h.state.quoteCalls.slice(1)).toHaveLength(3)
    expect(h.state.quoteCalls.slice(1).every(quote => quote.referral === 'noir_send')).toBe(true)
    expect(
      h.state.quoteCalls.slice(1).reduce((sum, quote) => sum + BigInt(quote.amountRaw), 0n)
    ).toBe(57n)
    expect(h.state.formalQuotes).toBe(0)
    expect(h.state.signatures).toBe(0)
    expect(h.plans.size).toBe(0)

    h.state.quoteCalls.length = 0
    const shieldCluster = { ...cluster, sourceDomain: 'shield' }
    await expect(h.coordinator.preview(shieldCluster)).rejects.toThrow(/Refresh Shield balances/)
    h.state.session = session
    const shieldPreview = await h.coordinator.preview(shieldCluster)
    expect(shieldPreview).toMatchObject({
      amountOutRaw: '57',
      minimumOutputRaw: '54',
      timeEstimateSeconds: 17
    })
    expect(h.state.quoteCalls).toHaveLength(3)
    expect(h.state.quoteCalls.every(quote => quote.dry)).toBe(true)
    expect(h.plans.size).toBe(0)

    h.state.quoteOverride = input => ({
      ...(input.depositType === 'ORIGIN_CHAIN'
        ? {
            depositAddress: input.dry ? '' : '0x3333333333333333333333333333333333333333',
            timeEstimate: 8
          }
        : { timeEstimate: 17 })
    })
    const rpc = {
      assertExpectedChain: async () => {},
      getPendingNonce: async () => '0',
      getNativeBalance: async () => '1000000000000000000',
      getMaximumPriorityFeePerGas: async () => '1000000000',
      getLatestBlockFee: async () => ({ baseFeePerGas: '1000000000', blockNumber: '1' }),
      simulateCall: async () => '0x',
      estimateGas: async () => '21000'
    }
    h.coordinator.rpcByChain.set('eip155:1', rpc)
    h.state.session = null
    const privateCluster = { ...cluster, sourceDomain: 'private', destinationDomain: 'public' }
    const fees = await Promise.all([
      h.coordinator.preview(privateCluster, true),
      h.coordinator.preview(privateCluster, true)
    ])
    expect(fees[0]).toMatchObject({ symbol: 'ETH', decimals: 18 })
    expect(BigInt(fees[0].raw)).toBeGreaterThan(0n)
    expect(fees[1]).toEqual(fees[0])
    expect(h.state.formalQuotes).toBe(1)
    expect(h.state.preparedDeposits).toBe(0)
    expect(h.plans.size).toBe(0)

    h.coordinator.rpcByChain.set('eip155:1', {
      ...rpc,
      estimateGas: async () => {
        throw new Error('RPC unavailable')
      }
    })
    expect(await h.coordinator.preview(privateCluster, true)).toBeNull()
    const noRpcPreview = await h.coordinator.preview(privateCluster)
    expect(noRpcPreview).toMatchObject({
      amountOutRaw: '60',
      minimumOutputRaw: '60',
      timeEstimateSeconds: 25
    })

    h.coordinator.rpcByChain.set('eip155:1', rpc)
    const changedAmount = {
      ...privateCluster,
      source: { ...privateCluster.source, amountRaw: '63' }
    }
    const changedReview = await h.coordinator.prepare(changedAmount)
    expect(changedReview.sourceAmountRaw).toBe('63')
    expect(h.state.formalQuotes).toBe(2)
    const review = await h.coordinator.prepare({ ...privateCluster, dedupKey: 'review-cluster' })
    expect(review.sourceNetworkFee).toEqual(fees[0])
    expect(h.state.formalQuotes).toBe(2)
    await h.coordinator.cancel(changedReview.planId)
    await h.coordinator.cancel(review.planId)
    await h.coordinator.preview(privateCluster, true)
    h.state.now += 60_001
    const freshReview = await h.coordinator.prepare(privateCluster)
    expect(h.state.formalQuotes).toBe(4)
    await h.coordinator.cancel(freshReview.planId)

    h.state.quoteOverride = input =>
      input.depositType === 'ORIGIN_CHAIN' ? { timeEstimate: 8 } : {}
    const missingTimePreview = await h.coordinator.preview(privateCluster)
    expect(missingTimePreview.timeEstimateSeconds).toBeUndefined()

    await expect(h.coordinator.preview({ ...cluster, accountId: 'account:other' })).rejects.toThrow(
      'account or network changed'
    )
    h.state.quoteOverride = input => {
      if (input.depositType === 'CONFIDENTIAL_INTENTS') h.state.identityAccount = 'account:other'
      return {}
    }
    await expect(h.coordinator.preview(cluster)).rejects.toThrow('same Account')
    expect(h.plans.size).toBe(0)
    expect(h.state.signatures).toBe(0)
  })

  test('binds a Shield swap preview and reserves its source balance', async () => {
    const h = directPreparationHarness()
    const request = {
      ...h.request('60'),
      operation: 'swap',
      destinationDomain: 'shield',
      destination: {
        chainId: 'eip155:1',
        chainName: 'eth',
        assetId: h.swapDestinationAssetId,
        protocolAssetId: h.swapDestinationProtocolId
      }
    }
    const review = await h.coordinator.prepare(request)
    expect(review).toMatchObject({
      operation: 'swap',
      sourceDomain: 'shield',
      destinationDomain: 'shield',
      sourceAmountRaw: '60',
      slippageBps: 100,
      withdrawCount: 1
    })
    expect(review.sourceAddress.toLowerCase()).toBe(signerId)
    expect(review.destinationAddress.toLowerCase()).toBe(signerId)
    const stored = await h.coordinator.getPlan(review.planId)
    expect(stored.swapQuote.quoteRequest).toMatchObject({
      dry: false,
      originAsset: request.source.protocolAssetId,
      destinationAsset: h.swapDestinationProtocolId,
      recipientType: 'CONFIDENTIAL_INTENTS',
      refundType: 'CONFIDENTIAL_INTENTS',
      recipient: signerId,
      refundTo: signerId
    })
    await expect(h.coordinator.prepare(h.request('50'))).rejects.toThrow('insufficient')
    const graph = createConfidentialFundingGraph({
      planId: stored.planId,
      operation: 'swap',
      sourceDomain: 'shield',
      destinationDomain: 'shield',
      scope,
      source: stored.source,
      destination: { ...stored.destination, expectedAmountRaw: stored.expectedOutputRaw },
      withdrawDepositAddresses: [null],
      requiresDeposit: false,
      signedWithdrawFingerprint: 'a'.repeat(64),
      now: stored.createdAt
    })
    expect(graph.root.kind).toBe('swap')
    const activity = {
      ...graph.root,
      source: 'wallet-v2',
      snapshot: graph.root.intent,
      segments: graph.segments
    }
    expect(getActivityRouteTitle(activity, {})).toBe('Swap')
    expect(getActivityAction(activity, { viewedDomain: 'shield' })).toEqual({
      label: 'Swap',
      side: 'none'
    })
    expect(
      getActivityAction(activity, {
        viewedDomain: 'shield',
        shieldProvider: 'near-confidential'
      })
    ).toEqual({ label: 'Swap', side: 'none' })
    expect(graph.segments.find(segment => segment.role === 'destination').target.kind).toBe(
      'protocol'
    )
    expect(() =>
      serializeConfidentialFundingPlan({
        ...stored,
        withdraws: [
          {
            ...stored.withdraws[0],
            signedPayload: { standard: 'erc191', payload: '{}', signature: 'signature' }
          }
        ]
      })
    ).toThrow('bindings are invalid')
    h.plans.set(review.planId, {
      ...stored,
      swapQuote: {
        ...stored.swapQuote,
        quoteRequest: { ...stored.swapQuote.quoteRequest, destinationAsset: 'different' }
      }
    })
    await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'approval content changed'
    )
  })

  test('uses the reviewed formal Shield swap quote without repricing at confirmation', async () => {
    const h = directPreparationHarness()
    const request = {
      ...h.request('60'),
      operation: 'swap',
      destinationDomain: 'shield',
      destination: {
        chainId: 'eip155:1',
        chainName: 'eth',
        assetId: h.swapDestinationAssetId,
        protocolAssetId: h.swapDestinationProtocolId
      }
    }
    const review = await h.coordinator.prepare(request)
    expect(review.quoteAppFeeBps).toBe(50)
    h.state.formalQuoteAppFees = [
      { recipient: 'platform.near', fee: 50 },
      { recipient: 'provider.near', fee: 20 }
    ]
    await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'unexpected signature'
    )
    expect(h.state.formalQuotes).toBe(1)
    expect(h.state.signatures).toBe(1)
  })

  test('ignores formal quote metadata when direct Shield withdrawal fees are unchanged', async () => {
    const h = directPreparationHarness()
    const review = await h.coordinator.prepare(h.request('60'))
    h.state.formalQuoteAppFees = [
      { recipient: 'platform.near', fee: 50, limitOrderId: 'quote-specific' }
    ]
    await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'unexpected signature'
    )
    expect(h.state.formalQuotes).toBe(1)
    expect(h.state.signatures).toBe(1)
  })

  test('binds a direct Shield withdrawal fee to its review before signing', async () => {
    const h = directPreparationHarness()
    const review = await h.coordinator.prepare(h.request('60'))
    const stored = await h.coordinator.getPlan(review.planId)
    expect(stored.reviewedAppFeesFingerprint).toMatch(/^[0-9a-f]{64}$/)
    h.state.formalQuoteAppFees = [
      { recipient: 'platform.near', fee: 50 },
      { recipient: 'provider.near', fee: 20 }
    ]
    await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'Shield withdraw fees changed'
    )
    expect(h.state.formalQuotes).toBe(1)
    expect(h.state.signatures).toBe(0)
  })

  test('binds an external Shield withdrawal recipient through review and storage', async () => {
    const h = directPreparationHarness()
    const externalRecipient = '0x3333333333333333333333333333333333333333'
    const request = {
      ...h.request('10'),
      destinationDomain: 'public',
      externalRecipient
    }
    const review = await h.coordinator.prepare(request)
    expect(review.destinationAddress).toBe(externalRecipient)
    expect(review.externalRecipient).toBe(externalRecipient)
    const stored = await h.coordinator.getPlan(review.planId)
    expect(stored.externalRecipient).toBe(externalRecipient)
    expect(stored.withdraws[0].destinationAddress).toBe(externalRecipient)
    expect(stored.destination.address).toBe(externalRecipient)
    const graph = createConfidentialFundingGraph({
      planId: stored.planId,
      operation: 'withdraw',
      sourceDomain: 'shield',
      destinationDomain: 'public',
      scope,
      source: stored.source,
      destination: { ...stored.destination, expectedAmountRaw: stored.expectedOutputRaw },
      externalRecipient: true,
      withdrawDepositAddresses: [null],
      requiresDeposit: false,
      signedWithdrawFingerprint: 'a'.repeat(64),
      now: stored.createdAt
    })
    expect(graph.root.intent.direction).toBe('outgoing')
    expect(graph.root.intent.recipient.address).toBe(externalRecipient)
    expect(() =>
      serializeConfidentialFundingPlan({
        ...stored,
        externalRecipient: signerId
      })
    ).toThrow('bindings are invalid')
    h.plans.set(review.planId, { ...stored, externalRecipient: signerId })
    await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'approval content changed'
    )
    await expect(
      h.coordinator.prepare({ ...request, externalRecipient: 'not-an-address' })
    ).rejects.toThrow('request is invalid')
    await expect(
      h.coordinator.prepare({ ...request, externalRecipient: `0x${'0'.repeat(40)}` })
    ).rejects.toThrow('request is invalid')
  })

  test('releases unsigned direct withdraws interrupted before signing, even without a session', async () => {
    for (const phase of ['authorized', 'signing-withdraws', 'needs-auth']) {
      const h = directPreparationHarness()
      const request = h.request('10')
      const review = await h.coordinator.prepare(request)
      const prepared = await h.coordinator.getPlan(review.planId)
      h.plans.set(
        review.planId,
        serializeConfidentialFundingPlan({
          ...prepared,
          phase,
          ...(phase === 'needs-auth' ? { resumePhase: 'signing-withdraws' } : {})
        })
      )
      const session = h.state.session
      h.state.session = null
      await h.coordinator.resumeAll()
      const interrupted = await h.coordinator.getPlan(review.planId)
      expect(interrupted.phase).toBe('failed')
      expect(interrupted.errorStatus).toBe('WITHDRAW_SIGNING_INTERRUPTED')
      expect(h.state.signatures).toBe(0)
      h.state.session = session
      const replacement = await h.coordinator.prepare(request)
      expect(replacement.planId).not.toBe(review.planId)
      expect(replacement.withdrawCount).toBe(1)
    }
  })

  test('confirms the same Private to Shield review after JSON storage reorders prepared transaction keys', async () => {
    const plans = new Map()
    const assetId = 'eip155:1/slip44:60'
    const protocolAssetId = 'nep141:eth.omft.near'
    const depositAddress = '0x3333333333333333333333333333333333333333'
    const transactionHash = `0x${'ab'.repeat(32)}`
    const state = { prepared: null, broadcasts: 0, depositStatus: 'PROCESSING' }
    const reverseKeys = (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value
    const store = {
      getPlan: async id => structuredClone(plans.get(id) ?? null),
      listPlans: async () => [...plans.values()].map(value => structuredClone(value)),
      putPlan: async value => {
        plans.set(
          value.planId,
          serializeConfidentialFundingPlan(JSON.parse(JSON.stringify(value, reverseKeys)))
        )
      },
      deletePlan: async id => {
        plans.delete(id)
      },
      getSession: async () => ({
        accessToken: 'session',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 600_000,
        refreshExpiresAt: Date.now() + 1_200_000
      }),
      putBalances: async () => {}
    }
    const asset = {
      asset: { id: assetId, chainId: 'eip155:1', kind: 'native', namespace: 'slip44' },
      metadata: { symbol: 'ETH', decimals: 18 },
      verification: 'verified'
    }
    const signer = {
      resolveIdentity: async () => ({
        address: signerId,
        peaAddress,
        addressIndex: 0,
        context: { chainAccount: { scope: { ...scope, chainId: 'eip155:1' } } }
      }),
      prepareTransaction: async ({ prepared }) => {
        state.prepared = prepared
        return {
          commandId: 'command-one',
          payloadFingerprint: 'a'.repeat(64),
          expiresAt: Date.now() + 600_000
        }
      },
      confirmTransaction: async () => ({ rawTransaction: '0xdeadbeef', transactionHash })
    }
    const api = {
      getBalances: async () => [],
      getStatus: async () => ({
        status: state.depositStatus,
        ...(state.depositStatus === 'SUCCESS' ? { settledAmountOutRaw: '1000' } : {})
      }),
      quote: async input => ({
        correlationId: 'quote-one',
        quoteRequest: {
          swapType: 'EXACT_INPUT',
          confidentiality: 'basic',
          originAsset: input.originAsset,
          destinationAsset: input.destinationAsset,
          amount: input.amountRaw,
          refundTo: input.refundTo,
          depositType: input.depositType,
          refundType: input.refundType,
          recipient: input.recipient,
          recipientType: input.recipientType,
          slippageTolerance: input.slippageBps
        },
        quote: {
          amountIn: input.amountRaw,
          amountOut: input.amountRaw,
          minAmountOut: input.amountRaw,
          depositAddress,
          deadline: new Date(Date.now() + 300_000).toISOString()
        }
      })
    }
    const repository = new InMemoryTransactionRepository()
    const coordinator = new ConfidentialFundingCoordinator({
      network: 'mainnet',
      api,
      store,
      signer,
      repository,
      assets: { get: () => asset, list: () => [asset] },
      evmNetworks: [],
      assetMappings: [{ assetId, protocolAssetId }],
      scheduleMonitoring: async () => {}
    })
    coordinator.rpcByChain.set('eip155:1', {
      assertExpectedChain: async () => {},
      getPendingNonce: async () => '0',
      getNativeBalance: async () => '1000000000000000000',
      simulateCall: async () => '0x',
      estimateGas: async () => '21000',
      getMaximumPriorityFeePerGas: async () => '1000000000',
      getLatestBlockFee: async () => ({ blockNumber: '1', baseFeePerGas: '1000000000' }),
      broadcastRawTransaction: async () => {
        state.broadcasts += 1
        return transactionHash
      }
    })
    const request = {
      network: 'mainnet',
      ...scope,
      operation: 'deposit',
      sourceDomain: 'private',
      destinationDomain: 'shield',
      source: {
        chainId: 'eip155:1',
        chainName: 'eth',
        assetId,
        protocolAssetId,
        amountRaw: '1000'
      },
      destination: { chainId: 'eip155:1', chainName: 'eth', assetId, protocolAssetId },
      slippageBps: 100
    }
    const review = await coordinator.prepare(request)
    const stored = await store.getPlan(review.planId)
    const customReview = await coordinator.prepare({
      ...request,
      feeSelection: {
        kind: 'custom',
        gasLimit: '25000',
        maxFeePerGasWei: '4000000000',
        maxPriorityFeePerGasWei: '1500000000'
      }
    })
    const customPlan = await store.getPlan(customReview.planId)
    expect(customReview.planId).not.toBe(review.planId)
    expect(customReview.payloadFingerprint).not.toBe(review.payloadFingerprint)
    expect(customReview.sourceEvmFee).toMatchObject({
      transactionType: 'eip1559',
      gasLimit: '25000',
      maxFeePerGasWei: '4000000000',
      maxPriorityFeePerGasWei: '1500000000'
    })
    expect(customPlan.preparedDeposit.preparedTransfer.transaction).toMatchObject({
      gasLimit: '25000',
      maxFeePerGas: '4000000000',
      maxPriorityFeePerGas: '1500000000'
    })
    await expect(
      coordinator.confirm(customReview.planId, review.payloadFingerprint)
    ).rejects.toThrow('approval')
    expect(state.broadcasts).toBe(0)
    expect(state.prepared.from.toLowerCase()).toBe(peaAddress)
    expect(stored.depositQuote.quoteRequest.refundTo).toBe(peaAddress)
    expect(JSON.stringify(stored.preparedDeposit.preparedTransfer)).not.toBe(
      JSON.stringify(state.prepared)
    )
    await store.putPlan({
      ...stored,
      source: { ...stored.source, amountRaw: '1001' }
    })
    await expect(coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'approval content changed'
    )
    expect(state.broadcasts).toBe(0)
    await store.putPlan(stored)
    await repository.create(
      createConfidentialFundingGraph({
        planId: review.planId,
        operation: 'deposit',
        sourceDomain: 'private',
        destinationDomain: 'shield',
        scope,
        source: { ...stored.source, transactionHash },
        destination: { ...stored.destination, expectedAmountRaw: stored.expectedOutputRaw },
        withdrawDepositAddresses: [],
        requiresDeposit: true,
        now: stored.createdAt
      })
    )
    expect((await coordinator.confirm(review.planId, review.payloadFingerprint)).phase).toBe(
      'deposit-confirming'
    )
    expect(state.broadcasts).toBe(1)
    await coordinator.continuePlan(review.planId)
    const backfilled = await repository.get(scope, stored.transactionId)
    expect(backfilled.root.intent.sender.address.toLowerCase()).toBe(peaAddress)
    expect(backfilled.root.intent.evm).toMatchObject({
      nonce: stored.preparedDeposit.preparedTransfer.transaction.nonce,
      unsignedTransaction: stored.preparedDeposit.preparedTransfer.transaction
    })
    expect(backfilled.segments[0].evidence.externalReference).toBe(
      `evm-nonce:${stored.preparedDeposit.preparedTransfer.transaction.nonce}`
    )
    await expect(coordinator.assertSpeedUpAllowed(backfilled)).resolves.toBeUndefined()
    const pendingPlan = await store.getPlan(review.planId)
    await store.putPlan({
      ...pendingPlan,
      depositQuote: {
        ...pendingPlan.depositQuote,
        quote: {
          ...pendingPlan.depositQuote.quote,
          deadline: new Date(Date.now() - 1_000).toISOString()
        }
      }
    })
    await expect(coordinator.assertSpeedUpAllowed(backfilled)).rejects.toThrow(
      'can no longer be sped up'
    )
    await store.putPlan(pendingPlan)
    expect(
      (
        await repository.backfillConfidentialEvmOrigin({
          scope,
          transactionId: stored.transactionId,
          expectedRootRevision: backfilled.root.revision,
          transactionHash,
          legacySenderAddress: stored.source.address,
          preparedTransfer: stored.preparedDeposit.preparedTransfer,
          observedAt: Date.now()
        })
      ).status
    ).toBe('unchanged')
    expect(
      (
        await repository.backfillConfidentialEvmOrigin({
          scope,
          transactionId: stored.transactionId,
          expectedRootRevision: backfilled.root.revision,
          transactionHash: `0x${'cd'.repeat(32)}`,
          legacySenderAddress: stored.source.address,
          preparedTransfer: stored.preparedDeposit.preparedTransfer,
          observedAt: Date.now()
        })
      ).status
    ).toBe('binding-conflict')
    expect(
      (
        await repository.backfillConfidentialEvmOrigin({
          scope: { ...scope, accountId: 'account:other' },
          transactionId: stored.transactionId,
          expectedRootRevision: backfilled.root.revision,
          transactionHash,
          legacySenderAddress: stored.source.address,
          preparedTransfer: stored.preparedDeposit.preparedTransfer,
          observedAt: Date.now()
        })
      ).status
    ).toBe('not-found')
    expect(
      (
        await repository.backfillConfidentialEvmOrigin({
          scope,
          transactionId: stored.transactionId,
          expectedRootRevision: backfilled.root.revision - 1,
          transactionHash,
          legacySenderAddress: stored.source.address,
          preparedTransfer: stored.preparedDeposit.preparedTransfer,
          observedAt: Date.now()
        })
      ).status
    ).toBe('revision-conflict')
    const cancelledAt = Date.now()
    const cancellation = await repository.applySegmentEvent({
      scope,
      transactionId: stored.transactionId,
      segmentId: backfilled.segments[0].id,
      event: {
        id: 'event:confidential:cancelled-origin',
        status: 'failed',
        cause: 'reconciliation',
        observedAt: cancelledAt,
        failure: { code: 'cancelled', occurredAt: cancelledAt }
      },
      expectedRootRevision: backfilled.root.revision,
      expectedSegmentRevision: backfilled.segments[0].revision
    })
    expect(cancellation.status).toBe('applied')
    expect(cancellation.graph.root.status).toBe('failed')
    expect((await coordinator.continuePlan(review.planId)).phase).toBe('cancelled')
    expect(state.broadcasts).toBe(1)
    expect(
      (await coordinator.confirm(customReview.planId, customReview.payloadFingerprint)).phase
    ).toBe('deposit-confirming')
    await coordinator.continuePlan(customPlan.planId)
    const created = await repository.get(scope, customPlan.transactionId)
    expect(created.root.intent.sender.address.toLowerCase()).toBe(peaAddress)
    expect(created.root.intent.evm.unsignedTransaction).toEqual(
      customPlan.preparedDeposit.preparedTransfer.transaction
    )
    const replacementHash = `0x${'ef'.repeat(32)}`
    const finalizedAt = Date.now()
    await repository.applySegmentEvent({
      scope,
      transactionId: customPlan.transactionId,
      segmentId: created.segments[0].id,
      event: {
        id: 'event:confidential:speedup-origin',
        status: 'final',
        cause: 'progress',
        observedAt: finalizedAt,
        evidence: { replacementTransactionHash: replacementHash }
      },
      expectedRootRevision: created.root.revision,
      expectedSegmentRevision: created.segments[0].revision
    })
    state.depositStatus = 'SUCCESS'
    expect((await coordinator.continuePlan(customPlan.planId)).phase).toBe('deposit-confirming')
    const replacementTransactionId = 'tx:confidential-speedup:one'
    const replacementSegmentId = 'segment:confidential-speedup:one:origin'
    const originalPrepared = customPlan.preparedDeposit.preparedTransfer
    const replacementPrepared = {
      ...originalPrepared,
      transaction: {
        ...originalPrepared.transaction,
        maxFeePerGas: (BigInt(originalPrepared.transaction.maxFeePerGas) + 1n).toString(),
        maxPriorityFeePerGas: (
          BigInt(originalPrepared.transaction.maxPriorityFeePerGas) + 1n
        ).toString()
      }
    }
    const replacementGraph = createEvmTransferGraph({
      prepared: replacementPrepared,
      scope,
      transactionId: replacementTransactionId,
      segmentId: replacementSegmentId,
      assets: { get: () => asset, list: () => [asset] }
    })
    await repository.create({
      ...replacementGraph,
      root: {
        ...replacementGraph.root,
        kind: created.root.kind,
        intent: {
          ...created.root.intent,
          feeLimit: replacementGraph.root.intent.feeLimit,
          evm: replacementGraph.root.intent.evm
        },
        relation: { kind: 'replacement-of', transactionId: customPlan.transactionId },
        status: 'final'
      },
      segments: replacementGraph.segments.map(segment => ({
        ...segment,
        status: 'final',
        evidence: { transactionHash: replacementHash }
      }))
    })
    expect((await coordinator.continuePlan(customPlan.planId)).phase).toBe('ready')
    expect(state.broadcasts).toBe(2)
  })

  test('reserves Shield funds across concurrent prepares and releases cancelled or expired reviews', async () => {
    const h = directPreparationHarness()
    const model = { scope: { network: 'mainnet', ...scope }, chains: [], assets: [] }
    const sourceAsset = async () =>
      (await h.coordinator.enrichPortfolio(model, false)).confidential.assets.find(
        asset => asset.protocolAssetId === h.request('1').source.protocolAssetId
      )
    const attempts = await Promise.allSettled([
      h.coordinator.prepare(h.request('60')),
      h.coordinator.prepare(h.request('50'))
    ])
    expect(attempts.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(attempts[1].reason.message).toContain('insufficient')
    const first = attempts[0].value
    expect(await sourceAsset()).toMatchObject({ availableRaw: '100', spendableRaw: '40' })
    const remaining = await h.coordinator.prepare(h.request((await sourceAsset()).spendableRaw))
    expect(await sourceAsset()).toMatchObject({ availableRaw: '100', spendableRaw: '0' })
    await h.coordinator.cancel(remaining.planId)
    await h.coordinator.cancel(first.planId)
    expect(await sourceAsset()).toMatchObject({ availableRaw: '100', spendableRaw: '100' })
    const second = await h.coordinator.prepare(h.request('50'))
    expect(second.withdrawCount).toBe(1)
    h.state.now = second.expiresAt + 1
    expect(await sourceAsset()).toMatchObject({ availableRaw: '100', spendableRaw: '100' })
    const third = await h.coordinator.prepare(h.request('60'))
    expect(third.withdrawCount).toBe(1)
    expect(h.plans.has(second.planId)).toBe(false)
    expect(h.state.signatures).toBe(0)
  })

  test('reserves a credited Cluster deposit while its Shield withdraws are queued', async () => {
    const h = directPreparationHarness()
    const review = await h.coordinator.prepare(h.request('10'))
    const base = await h.coordinator.getPlan(review.planId)
    await h.coordinator.cancel(review.planId)
    const cluster = serializeConfidentialFundingPlan({
      ...base,
      planId: 'credited-cluster',
      operation: 'cluster',
      sourceDomain: 'public',
      destinationDomain: 'private',
      phase: 'signing-withdraws',
      source: { ...base.source, amountRaw: '60' },
      requiresDeposit: true,
      depositQuote: { quote: { amountOut: '60' } },
      preparedDeposit: { commandId: 'signed-source' },
      splitSourceAmounts: ['20', '20', '20'],
      withdraws: [0, 1, 2].map(sequence => ({
        ...base.withdraws[0],
        sequence,
        sourceAmountRaw: '20',
        amountRaw: '20'
      }))
    })
    h.plans.set(cluster.planId, cluster)
    await expect(h.coordinator.prepare(h.request('50'))).rejects.toThrow('insufficient')
    expect((await h.coordinator.prepare(h.request('40'))).sourceAmountRaw).toBe('40')
  })

  test('rejects a changed Account and makes cancel and confirm mutually exclusive', async () => {
    const h = directPreparationHarness()
    await expect(h.coordinator.prepare(h.request('10', 'account:other'))).rejects.toThrow(
      'account or network changed'
    )
    expect(h.plans.size).toBe(0)
    const first = await h.coordinator.prepare(h.request('10'))
    const cancelling = h.coordinator.cancel(first.planId)
    await expect(h.coordinator.confirm(first.planId, first.payloadFingerprint)).rejects.toThrow(
      'being cancelled'
    )
    await cancelling
    expect(h.plans.size).toBe(0)
    const second = await h.coordinator.prepare(h.request('10'))
    const confirming = h.coordinator.confirm(second.planId, second.payloadFingerprint)
    await expect(h.coordinator.cancel(second.planId)).rejects.toThrow('in progress')
    await expect(confirming).rejects.toThrow('formal quote unavailable')
    expect((await h.coordinator.getPlan(second.planId)).phase).toBe('failed')
    expect(h.state.formalQuotes).toBe(1)
    expect(h.state.signatures).toBe(0)
  })

  test('settles a refunded Shield deposit after its on-chain origin is final', async () => {
    const planId = 'refunded-direct-deposit'
    const transactionId = `tx:confidential:${planId}`
    const depositAddress = '0x3333333333333333333333333333333333333333'
    const transactionHash = `0x${'ab'.repeat(32)}`
    let plan = serializeConfidentialFundingPlan({
      schemaVersion: 1,
      planId,
      transactionId,
      network: 'mainnet',
      ...scope,
      operation: 'deposit',
      sourceDomain: 'public',
      destinationDomain: 'shield',
      phase: 'deposit-confirming',
      source: {
        chainId: 'eip155:1',
        chainName: 'eth',
        assetId: 'eip155:1/slip44:60',
        protocolAssetId: 'nep141:eth.omft.near',
        amountRaw: '1000',
        address: signerId
      },
      destination: {
        chainId: 'eip155:1',
        chainName: 'eth',
        assetId: 'eip155:1/slip44:60',
        protocolAssetId: 'nep141:eth.omft.near',
        address: signerId
      },
      signerId,
      addressIndex: 0,
      slippageBps: 100,
      requiresDeposit: true,
      confidentialBaselineRaw: '0',
      depositQuote: {
        correlationId: 'quote-one',
        quoteRequest: {},
        quote: {
          amountIn: '1000',
          amountOut: '990',
          minAmountOut: '980',
          depositAddress,
          deadline: new Date(60_000).toISOString()
        }
      },
      preparedDeposit: {
        commandId: 'command-one',
        payloadFingerprint: 'a'.repeat(64),
        expiresAt: 60_000,
        preparedTransfer: {}
      },
      approvalFingerprint: 'b'.repeat(64),
      approvalExpiresAt: 60_000,
      expectedOutputRaw: '990',
      minimumOutputRaw: '980',
      splitSourceAmounts: [],
      withdraws: [],
      createdAt: now,
      updatedAt: now
    })
    const repository = new SignedTransactionRepository()
    const graph = createConfidentialFundingGraph({
      planId,
      operation: 'deposit',
      sourceDomain: 'public',
      destinationDomain: 'shield',
      scope,
      source: { ...plan.source, transactionHash },
      destination: { ...plan.destination, expectedAmountRaw: plan.expectedOutputRaw },
      withdrawDepositAddresses: [],
      requiresDeposit: true,
      now
    })
    await repository.create({
      ...graph,
      root: { ...graph.root, status: 'confirming' },
      segments: graph.segments.map(segment =>
        segment.role === 'origin'
          ? { ...segment, status: 'final' }
          : segment.role === 'relay'
            ? { ...segment, status: 'confirming' }
            : segment
      )
    })
    const coordinator = new ConfidentialFundingCoordinator({
      network: 'mainnet',
      api: {
        getStatus: async () => ({ status: 'REFUNDED' }),
        getBalances: async () => []
      },
      store: {
        getPlan: async () => structuredClone(plan),
        putPlan: async next => {
          plan = serializeConfidentialFundingPlan(next)
        },
        getSession: async () => ({
          accessToken: 'session',
          refreshToken: 'refresh',
          expiresAt: 1_000_000,
          refreshExpiresAt: 2_000_000
        }),
        putBalances: async () => {}
      },
      signer: {},
      repository,
      assets: {},
      evmNetworks: [],
      assetMappings: [],
      now: () => now,
      scheduleMonitoring: async () => {}
    })
    expect((await coordinator.continuePlan(planId)).phase).toBe('refunded')
    const settled = await repository.get(scope, transactionId)
    expect(settled.root.status).toBe('failed')
    expect(settled.segments.find(segment => segment.role === 'origin').status).toBe('final')
    expect(settled.segments.find(segment => segment.role === 'relay').status).toBe('failed')
  })

  test('recovers one approved Shield withdraw without signing again or expanding the amount', async () => {
    const h = await harness('submitting', true)
    const resumed = await h.restart().continuePlan(h.initial.planId)
    expect(resumed.operation).toBe('withdraw')
    expect(resumed.phase).toBe('processing')
    expect(resumed.withdraws).toHaveLength(1)
    expect(h.state.submissions).toEqual([h.initial.frozenRequest.withdraws[0].signed_payload])
    expect(h.state.intentSignatures).toBe(0)
    expect(() =>
      serializeConfidentialFundingPlan({
        ...h.initial,
        sourceDomain: 'public'
      })
    ).toThrow('bindings are invalid')
    expect(() =>
      serializeConfidentialFundingPlan({
        ...h.initial,
        withdraws: [...h.initial.withdraws, h.initial.withdraws[0]]
      })
    ).toThrow('bindings are invalid')
  })
  test('submits the original signed intents when storage changes nested object key order', async () => {
    const h = await harness()
    const reordered = JSON.parse(
      JSON.stringify(h.initial.frozenRequest, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value
      )
    )
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(h.initial.frozenRequest))
    await h.store.putPlan({ ...h.initial, frozenRequest: reordered })
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('processing')
    expect(h.state.submissions).toEqual(
      h.initial.frozenRequest.withdraws.map(row => row.signed_payload)
    )
    expect(h.state.intentSignatures).toBe(0)
  })

  test('clears optional signing and resume fields through JSON persistence without corrupting plan bindings', async () => {
    const h = await harness()
    const resumed = serializeConfidentialFundingPlan({
      ...h.initial,
      resumePhase: undefined,
      preparedDeposit: undefined,
      depositQuote: undefined
    })
    expect(Object.hasOwn(resumed, 'resumePhase')).toBe(false)
    expect(resumed.frozenRequest).toEqual(h.initial.frozenRequest)
    const accepted = serializeConfidentialFundingPlan({
      ...resumed,
      phase: 'processing',
      orderId: 'order-one',
      frozenRequest: undefined,
      withdraws: resumed.withdraws.map(({ signedPayload, ...row }) => ({
        ...row,
        status: 'PROCESSING'
      }))
    })
    expect(Object.hasOwn(accepted, 'frozenRequest')).toBe(false)
    expect(accepted.withdraws.every(row => !Object.hasOwn(row, 'signedPayload'))).toBe(true)
    expect(serializeConfidentialFundingPlan(accepted)).toEqual(accepted)
  })

  test('requires frozen signed evidence bound to the confidential origin before persistence', async () => {
    const h = await harness()
    const valid = await h.repository.get(scope, h.initial.transactionId)
    expect(() => assertPersistableTransactionGraph(valid)).not.toThrow()
    for (const mutation of [
      { evidence: undefined },
      { evidence: { externalReference: h.initial.planId } },
      { target: { kind: 'protocol', provider: 'Unknown', account: signerId } },
      { target: { kind: 'protocol', provider: 'Confidential Intents', account: peaAddress } }
    ]) {
      const invalid = parseTransactionGraph({
        ...valid,
        segments: valid.segments.map(segment =>
          segment.role === 'origin' ? { ...segment, ...mutation } : segment
        )
      })
      expect(() => assertPersistableTransactionGraph(invalid)).toThrow(
        'signed origin transaction evidence'
      )
    }
    expect(() =>
      createConfidentialFundingGraph({
        planId: h.initial.planId,
        scope,
        source: h.initial.source,
        destination: { ...h.initial.destination, expectedAmountRaw: h.initial.expectedOutputRaw },
        withdrawDepositAddresses: h.initial.withdraws.map(row => row.depositAddress),
        requiresDeposit: false,
        now
      })
    ).toThrow('frozen signed withdraw batch')
  })

  test('leaves preview withdraw references unbound until formal quotes are frozen', () => {
    const graph = createConfidentialFundingGraph({
      planId: 'pending-deposit',
      scope,
      source: {
        chainId: 'eip155:1',
        assetId: 'eip155:1/slip44:60',
        amountRaw: '3000',
        address: signerId
      },
      destination: {
        chainId: 'eip155:1',
        assetId: 'eip155:1/slip44:60',
        expectedAmountRaw: '2970',
        address: peaAddress
      },
      withdrawDepositAddresses: [null, null, null],
      requiresDeposit: true,
      now
    })

    expect(
      graph.segments
        .filter(segment => segment.role === 'destination')
        .map(segment => segment.evidence)
    ).toEqual([undefined, undefined, undefined])
  })

  test('recovers an accepted timed-out intent without resubmitting it after expiry', async () => {
    const h = await harness()
    h.state.submitError = new ConfidentialFundingApiError('timeout', null, true)
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('submitting')
    expect((await h.store.getPlan(h.initial.planId)).frozenRequest).toEqual(h.initial.frozenRequest)
    h.state.statuses[0] = 'PROCESSING'
    h.state.now = 70_000
    const uncertain = await h.restart().continuePlan(h.initial.planId)
    expect(uncertain.phase).toBe('submitting')
    expect(uncertain.frozenRequest).toEqual(h.initial.frozenRequest)
    h.state.statuses = ['PROCESSING', 'EXPIRED', 'EXPIRED']
    const recovered = await h.restart().continuePlan(h.initial.planId)
    expect(recovered.phase).toBe('processing')
    expect(recovered.frozenRequest).toBeUndefined()
    expect(recovered.withdraws.every(row => !row.signedPayload)).toBe(true)
    expect(recovered.withdraws.map(row => row.status)).toEqual(['PROCESSING', 'EXPIRED', 'EXPIRED'])
    expect(h.state.submissions).toHaveLength(1)
    expect(h.state.intentSignatures).toBe(0)
  })

  test('replays exact frozen intents and deduplicates concurrent continuation', async () => {
    const h = await harness()
    h.state.submitError = new ConfidentialFundingApiError('unavailable', 503, true)
    await h.restart().continuePlan(h.initial.planId)
    h.state.submitError = null
    const coordinator = h.restart()
    await Promise.all([
      coordinator.continuePlan(h.initial.planId),
      coordinator.continuePlan(h.initial.planId)
    ])
    expect(h.state.submissions).toEqual([
      h.initial.frozenRequest.withdraws[0].signed_payload,
      ...h.initial.frozenRequest.withdraws.map(row => row.signed_payload)
    ])
    expect(h.state.intentSignatures).toBe(0)
  })

  test('does not replay an unaccepted expired batch or a modified frozen request', async () => {
    for (const modified of [false, true]) {
      const h = await harness()
      if (modified) {
        const changed = structuredClone(h.initial)
        changed.withdraws[0].signedPayload.signature = 'modified-signature'
        changed.frozenRequest.withdraws[0].signed_payload.signature = 'modified-signature'
        await h.store.putPlan({
          ...changed
        })
      } else h.state.now = 70_000
      const result = await h.restart().continuePlan(h.initial.planId)
      expect(result.phase).toBe('submitting')
      if (!modified) expect(result.frozenRequest).toEqual(h.initial.frozenRequest)
      if (modified) expect(result.errorStatus).toBe('LOCAL_PROCESSING_FAILED')
      expect(h.state.submissions).toHaveLength(0)
      expect(h.state.intentSignatures).toBe(0)
    }
  })

  test('keeps an explicit submit rejection recoverable instead of reporting lost funds', async () => {
    const h = await harness()
    h.state.submitError = new ConfidentialFundingApiError('rejected', 400, false)
    const pending = await h.restart().continuePlan(h.initial.planId)
    expect(pending.phase).toBe('submitting')
    expect(pending.errorStatus).toBe('SERVICE_400')
    expect(h.state.monitoring).toBe(0)
    await h.restart().resumeAll()
    expect(h.state.submissions).toHaveLength(2)
  })

  test('checks a blocked direct withdraw without changing its signed intent or duplicating an accepted submission', async () => {
    const h = await harness('submitting', true)
    const coordinator = h.restart()
    h.state.submitError = new ConfidentialFundingApiError('rejected', 400, false)
    const pending = await coordinator.continuePlan(h.initial.planId)
    expect(pending).toMatchObject({
      operation: 'withdraw',
      phase: 'submitting',
      errorStatus: 'SERVICE_400',
      frozenRequest: h.initial.frozenRequest
    })
    expect(h.state.monitoring).toBe(0)
    await coordinator.resumeAll()
    expect(h.state.submissions).toHaveLength(1)
    expect((await h.store.getPlan(pending.planId)).frozenRequest).toEqual(h.initial.frozenRequest)

    h.state.identityAccount = 'other-account'
    await expect(coordinator.checkSubmission(pending.planId)).rejects.toThrow()
    expect(h.state.submissions).toHaveLength(1)
    h.state.identityAccount = scope.accountId

    const stillPending = await coordinator.checkSubmission(pending.planId)
    expect(stillPending.phase).toBe('submitting')
    expect(stillPending.errorStatus).toBe('SERVICE_400')
    expect(stillPending.frozenRequest).toEqual(h.initial.frozenRequest)
    expect(h.state.monitoring).toBe(0)
    expect(h.state.submissions).toHaveLength(2)
    expect(h.state.submissions[1]).toEqual(h.state.submissions[0])

    h.state.submitError = null
    h.state.statuses[0] = 'PROCESSING'
    const recovered = await coordinator.checkSubmission(pending.planId)
    expect(recovered.phase).toBe('processing')
    expect(recovered.errorStatus).toBeUndefined()
    expect(recovered.frozenRequest).toBeUndefined()
    expect(h.state.submissions).toHaveLength(2)
    expect(h.state.intentSignatures).toBe(0)
    expect(h.state.monitoring).toBeGreaterThan(0)
    await expect(coordinator.checkSubmission(pending.planId)).rejects.toThrow(
      'does not need a submission check'
    )
    expect(h.state.submissions).toHaveLength(2)
  })

  test('does not resubmit a blocked direct withdraw when history cannot be read', async () => {
    const h = await harness('submitting', true)
    const coordinator = h.restart()
    h.state.submitError = new ConfidentialFundingApiError('rejected', 400, false)
    await coordinator.continuePlan(h.initial.planId)
    h.state.statusError = new ConfidentialFundingApiError('unavailable', 503, true)

    await expect(coordinator.checkSubmission(h.initial.planId)).rejects.toThrow(
      'Transfer status is unavailable'
    )
    const pending = await h.store.getPlan(h.initial.planId)
    expect(pending.phase).toBe('submitting')
    expect(pending.errorStatus).toBe('SERVICE_400')
    expect(pending.frozenRequest).toEqual(h.initial.frozenRequest)
    expect(h.state.submissions).toHaveLength(1)
    expect(h.state.monitoring).toBe(0)
  })

  test('rechecks the account immediately before retrying a blocked direct withdraw', async () => {
    const h = await harness('submitting', true)
    const coordinator = h.restart()
    h.state.submitError = new ConfidentialFundingApiError('rejected', 400, false)
    await coordinator.continuePlan(h.initial.planId)
    h.state.switchAccountAfterStatus = true

    const result = await coordinator.checkSubmission(h.initial.planId)
    expect(result.phase).toBe('needs-auth')
    expect(h.state.submissions).toHaveLength(1)
    expect(h.state.intentSignatures).toBe(0)
  })

  test('does not reschedule a blocked direct withdraw after its signed deadline', async () => {
    const h = await harness('submitting', true)
    const coordinator = h.restart()
    h.state.submitError = new ConfidentialFundingApiError('rejected', 400, false)
    await coordinator.continuePlan(h.initial.planId)
    h.state.now = 70_000

    const pending = await coordinator.continuePlan(h.initial.planId)
    expect(pending.phase).toBe('submitting')
    expect(pending.errorStatus).toBe('SERVICE_400')
    expect(h.state.monitoring).toBe(0)
    expect(h.state.submissions).toHaveLength(1)
    await coordinator.checkSubmission(h.initial.planId)
    expect(h.state.monitoring).toBe(0)
    expect(h.state.submissions).toHaveLength(1)
  })

  for (const status of [401, 403]) {
    test(`pauses backend ${status} for explicit authorization and resumes the same signed batch`, async () => {
      const h = await harness()
      h.state.submitError = new ConfidentialFundingApiError('unauthorized', status, false)
      const paused = await h.restart().continuePlan(h.initial.planId)
      expect(paused.phase).toBe('needs-auth')
      expect(paused.resumePhase).toBe('submitting')
      expect(h.state.session).toBeNull()
      h.state.session = {
        accessToken: 'unrelated-session',
        expiresAt: 1_000_000,
        refreshExpiresAt: 2_000_000
      }
      await h.restart().resumeAll()
      expect((await h.store.getPlan(h.initial.planId)).phase).toBe('needs-auth')
      expect(h.state.submissions).toHaveLength(1)
      h.state.session = null
      h.state.submitError = null
      const coordinator = h.restart()
      await coordinator.confirm(h.initial.planId, h.initial.approvalFingerprint)
      const resumed = await coordinator.continuePlan(h.initial.planId)
      expect(resumed.phase).toBe('processing')
      expect(h.state.submissions).toEqual([
        h.initial.frozenRequest.withdraws[0].signed_payload,
        ...h.initial.frozenRequest.withdraws.map(row => row.signed_payload)
      ])
      expect(h.state.authSignatures).toBe(1)
      expect(h.state.intentSignatures).toBe(0)
    })
  }

  test('resumes settlement monitoring after authorization without creating another batch', async () => {
    const h = await harness('processing')
    h.state.session = null
    const paused = await h.restart().continuePlan(h.initial.planId)
    expect(paused.phase).toBe('needs-auth')
    expect(paused.resumePhase).toBe('processing')
    const coordinator = h.restart()
    await coordinator.confirm(h.initial.planId, h.initial.approvalFingerprint)
    expect((await coordinator.continuePlan(h.initial.planId)).phase).toBe('processing')
    expect(h.state.submissions).toHaveLength(0)
    expect(h.state.intentSignatures).toBe(0)
  })

  test('settles staggered children monotonically across restart and temporary RPC failure', async () => {
    const h = await harness('processing')
    h.state.settledOutputs = new Map([
      [0, '80'],
      [1, '90'],
      [2, '100']
    ])
    h.state.statuses = ['SUCCESS', 'PROCESSING', 'PROCESSING']
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('processing')
    const confidentialTarget = { ...scope, chainIds: ['eip155:1'], domain: 'confidential' }
    const chainTarget = { ...scope, chainIds: ['eip155:1'], domain: 'chain' }
    expect(h.state.refreshTargets).toEqual([confidentialTarget, chainTarget])
    h.state.statuses = ['PROCESSING', 'SUCCESS', null]
    const intermediate = await h.restart().continuePlan(h.initial.planId)
    expect(intermediate.withdraws.map(row => row.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'PROCESSING'
    ])
    expect(intermediate.withdraws[0].transactionHash).toBe('hash-0')
    expect(h.state.refreshTargets).toEqual([
      confidentialTarget,
      chainTarget,
      confidentialTarget,
      chainTarget
    ])
    h.state.statuses = ['FAILED', 'PROCESSING', 'SUCCESS']
    const ready = await h.restart().continuePlan(h.initial.planId)
    expect(ready.phase).toBe('ready')
    expect(ready.withdraws.map(row => row.transactionHash)).toEqual(['hash-0', 'hash-1', 'hash-2'])
    expect(ready.withdraws.map(row => row.settledOutputRaw)).toEqual(['80', '90', '100'])
    const graph = await h.repository.get(scope, h.initial.transactionId)
    expect(graph.root.status).toBe('final')
    expect(
      graph.segments.filter(row => row.role === 'destination').every(row => row.status === 'final')
    ).toBe(true)
    expect(h.state.refreshes).toBe(6)
    expect(h.state.refreshTargets.slice(-2)).toEqual([
      { ...confidentialTarget, balanceUpdated: true },
      chainTarget
    ])
    await h.restart().resumeAll()
    expect(h.state.refreshes).toBe(6)
  })

  test('reopens a failed Cluster read-only and resumes late refunds after worker restart', async () => {
    const h = await harness('processing', false, true)
    h.state.statuses = ['FAILED', 'FAILED', 'FAILED']
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('failed')
    h.state.historyToken = null
    h.state.session = null
    const reopened = await h.restart().getPlan(h.initial.planId)
    expect(reopened.phase).toBe('failed')
    const checked = h.state.statusRequests.length
    await Promise.all([h.restart().getPlan(h.initial.planId), h.restart().resumeAll()])
    expect(h.state.statusRequests.length).toBe(checked)
    h.state.now += 60_000
    h.state.statuses = ['REFUNDED', 'REFUNDED', 'REFUNDED']
    await h.restart().resumeAll()
    const refunded = await h.store.getPlan(h.initial.planId)
    expect(refunded.phase).toBe('refunded')
    expect(refunded.withdraws.map(row => row.status)).toEqual(['REFUNDED', 'REFUNDED', 'REFUNDED'])
    expect((await h.repository.get(scope, h.initial.transactionId)).root.status).toBe('failed')
    h.state.now += 60_000
    const settledChecks = h.state.statusRequests.length
    await h.restart().resumeAll()
    expect(h.state.statusRequests.length).toBe(settledChecks)
    expect(h.state.batchSubmissions).toBe(0)
    expect(h.state.submissions).toEqual([])
    expect(h.state.intentSignatures + h.state.authSignatures + h.state.historySignatures).toBe(0)
  })

  test('tracks a funded origin refund without sending prepared Cluster children', async () => {
    const h = await harness('failed', false, true, true)
    const coordinator = h.restart()
    // A credited/uncertain origin is not proof that a later refund cannot occur.
    h.state.originStatus = 'SUCCESS'
    expect((await coordinator.getPlan(h.initial.planId)).phase).toBe('failed')
    h.state.now += 60_000
    h.state.statusError = new ConfidentialFundingApiError('unavailable', 503, false)
    await h.restart().resumeAll()
    expect((await h.store.getPlan(h.initial.planId)).phase).toBe('failed')
    const checked = h.state.statusRequests.length
    await h.restart().resumeAll()
    expect(h.state.statusRequests.length).toBe(checked)
    h.state.now += 60_000
    h.state.statusError = null
    h.state.originStatus = 'REFUNDED'
    const refunded = await h.restart().getPlan(h.initial.planId)
    expect(refunded.phase).toBe('refunded')
    expect(refunded.withdraws.every(row => row.status === 'SIGNED')).toBe(true)
    expect(h.state.statusRequests.every(address => address === 'origin-deposit.near')).toBe(true)
    expect(h.state.batchSubmissions).toBe(0)
    expect(h.state.submissions).toEqual([])
    expect(
      h.state.depositSignatures +
        h.state.intentSignatures +
        h.state.authSignatures +
        h.state.historySignatures
    ).toBe(0)
  })

  test('keeps a destination hash visible while a confidential withdraw is processing', async () => {
    const h = await harness('processing')
    h.state.processingHashes.add(0)
    const pending = await h.restart().continuePlan(h.initial.planId)
    expect(pending.phase).toBe('processing')
    expect(pending.withdraws[0].transactionHash).toBe('hash-0')
    const graph = await h.repository.get(scope, h.initial.transactionId)
    expect(graph.segments.find(segment => segment.id.endsWith(':withdraw:0'))).toMatchObject({
      status: 'confirming',
      evidence: { transactionHash: 'hash-0' }
    })
  })

  test('only finalizes a partial batch after the remaining children refund or fail', async () => {
    const h = await harness('processing')
    h.state.statuses = ['SUCCESS', 'REFUNDED', 'PROCESSING']
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('processing')
    h.state.statuses = ['PROCESSING', 'PROCESSING', 'FAILED']
    const partial = await h.restart().continuePlan(h.initial.planId)
    expect(partial.phase).toBe('partial')
    expect(partial.withdraws.map(row => row.status)).toEqual(['SUCCESS', 'REFUNDED', 'FAILED'])
    expect(h.state.refreshes).toBe(3)
    expect(h.state.refreshTargets).toEqual([
      { ...scope, chainIds: ['eip155:1'], domain: 'confidential' },
      { ...scope, chainIds: ['eip155:1'], domain: 'chain' },
      { ...scope, chainIds: ['eip155:1'], domain: 'confidential', balanceUpdated: true }
    ])
    expect(h.state.submissions).toHaveLength(0)
  })

  test('continues a frozen batch under its original scope after the active account changes', async () => {
    const h = await harness()
    h.state.identityAccount = 'account:two'
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('processing')
    expect(h.state.submissions).toEqual(
      h.initial.frozenRequest.withdraws.map(row => row.signed_payload)
    )
    expect(h.state.intentSignatures).toBe(0)
  })

  test('never resubmits an attempted Cluster batch and recovers only its complete order', async () => {
    const h = await harness('submitting', false, true)
    h.state.submitError = new ConfidentialFundingApiError('timeout', null, true)
    const order = {
      orderId: 'order-one',
      signerId,
      status: 'SCHEDULED',
      mode: 'TRANSFER',
      fromAmount: '3000',
      fromChain: 'eth',
      fromToken: h.initial.source.protocolAssetId,
      transactions: h.initial.withdraws.map(row => ({
        sequence: row.sequence,
        transactionType: 'WITHDRAW',
        amount: row.amountRaw,
        depositAddress: row.depositAddress,
        destinationAddress: row.destinationAddress,
        destinationChain: row.destinationChain,
        token: row.token,
        status: 'SCHEDULED',
        scheduledAt: 30_000
      }))
    }
    const attempted = await h.restart().continuePlan(h.initial.planId)
    expect(attempted.phase).toBe('submitting')
    expect(attempted.batchSubmissionAttemptedAt).toBe(now)
    expect(h.state.batchSubmissions).toBe(1)

    h.state.acceptedOrder = { ...order, transactions: order.transactions.slice(0, 2) }
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('submitting')
    expect(h.state.batchSubmissions).toBe(1)

    h.state.acceptedOrder = order
    const recovered = await h.restart().continuePlan(h.initial.planId)
    expect(recovered.phase).toBe('processing')
    expect(recovered.orderId).toBe('order-one')
    expect(recovered.withdraws.map(row => row.scheduledAt)).toEqual([30_000, 30_000, 30_000])
    expect(h.state.batchSubmissions).toBe(1)
    expect(h.state.intentSignatures).toBe(0)
  })

  test('finalizes an explicitly rejected Cluster batch without losing its signed evidence', async () => {
    const h = await harness('submitting', false, true, true)
    h.state.submitError = new ConfidentialFundingApiError(
      'app fee does not match',
      200,
      false,
      2002
    )
    const rejected = await h.restart().continuePlan(h.initial.planId)
    expect(rejected.phase).toBe('failed')
    expect(rejected.errorStatus).toBe('APP_FEE_REJECTED_2002')
    expect(rejected.batchSubmissionAttemptedAt).toBe(now)
    expect(rejected.frozenRequest).toEqual(h.initial.frozenRequest)
    expect(rejected.preparedDeposit.transactionHash).toBe(h.initial.preparedDeposit.transactionHash)
    expect(rejected.withdraws.every(row => row.status === 'FAILED' && row.signedPayload)).toBe(true)
    expect(h.state.batchSubmissions).toBe(1)
    expect(h.state.intentSignatures).toBe(0)
    const graph = await h.repository.get(scope, h.initial.transactionId)
    expect(graph.segments.find(row => row.role === 'origin')).toMatchObject({
      status: 'final',
      evidence: { transactionHash: h.initial.preparedDeposit.transactionHash }
    })
    expect(graph.segments.find(row => row.role === 'relay').status).toBe('failed')
    expect(
      graph.segments.filter(row => row.role === 'destination').every(row => row.status === 'failed')
    ).toBe(true)

    const balance = directPreparationHarness()
    balance.plans.set(rejected.planId, rejected)
    expect((await balance.coordinator.prepare(balance.request('100'))).sourceAmountRaw).toBe('100')
    await h.restart().resumeAll()
    expect(h.state.batchSubmissions).toBe(1)
  })

  test('resumes rejection finalization after a graph write interruption without resubmitting', async () => {
    const h = await harness('submitting', false, true)
    h.state.submitError = new ConfidentialFundingApiError(
      'app fee does not match',
      200,
      false,
      2002
    )
    const apply = h.repository.applySegmentEvent.bind(h.repository)
    let writes = 0
    h.repository.applySegmentEvent = async input => {
      writes += 1
      if (writes === 2) throw new Error('storage interrupted')
      return apply(input)
    }
    const interrupted = await h.restart().continuePlan(h.initial.planId)
    expect(interrupted.phase).toBe('submitting')
    expect(interrupted.errorStatus).toBe('APP_FEE_REJECTED_2002')
    expect(interrupted.frozenRequest).toEqual(h.initial.frozenRequest)

    const resumed = await h.restart().continuePlan(h.initial.planId)
    expect(resumed.phase).toBe('failed')
    expect(resumed.withdraws.every(row => row.status === 'FAILED')).toBe(true)
    expect(h.state.batchSubmissions).toBe(1)
    expect(h.state.intentSignatures).toBe(0)
  })

  test('keeps a rejected Cluster batch pending until every graph segment records failure', async () => {
    const h = await harness('submitting', false, true)
    h.state.submitError = new ConfidentialFundingApiError(
      'app fee does not match',
      200,
      false,
      2002
    )
    const apply = h.repository.applySegmentEvent.bind(h.repository)
    h.repository.applySegmentEvent = async () => ({ status: 'revision-conflict' })

    const pending = await h.restart().continuePlan(h.initial.planId)
    expect(pending.phase).toBe('submitting')
    expect(pending.errorStatus).toBe('APP_FEE_REJECTED_2002')
    expect(h.state.batchSubmissions).toBe(1)
    h.repository.applySegmentEvent = apply

    const settled = await h.restart().continuePlan(h.initial.planId)
    expect(settled.phase).toBe('failed')
    expect(h.state.batchSubmissions).toBe(1)
  })

  test('refuses to release a rejected Cluster batch with child execution evidence', async () => {
    for (const evidence of [
      { intentHash: 'intent-one' },
      { transactionHash: 'chain-one' },
      { scheduledAt: 30_000 }
    ]) {
      const h = await harness('submitting', false, true)
      await h.store.putPlan({
        ...h.initial,
        batchSubmissionAttemptedAt: now,
        withdraws: h.initial.withdraws.map((row, index) =>
          index === 0 ? { ...row, ...evidence } : row
        )
      })
      await expect(
        h.restart().finalizeRejectedCluster(h.initial.planId, 'BACKEND_CONFIRMED_REJECTION')
      ).rejects.toThrow('not eligible')
      const retained = await h.store.getPlan(h.initial.planId)
      expect(retained.phase).toBe('submitting')
      expect(retained.errorStatus).toBeUndefined()
      expect(h.state.batchSubmissions).toBe(0)
    }
  })

  test('finishes a backend-confirmed rejection from needs-auth without new authorization', async () => {
    const h = await harness('submitting', false, true)
    await h.store.putPlan({
      ...h.initial,
      phase: 'needs-auth',
      resumePhase: 'submitting',
      batchSubmissionAttemptedAt: now,
      errorStatus: 'BACKEND_CONFIRMED_REJECTION'
    })
    h.state.session = null
    await h.restart().resumeAll()
    const rejected = await h.store.getPlan(h.initial.planId)
    expect(rejected.phase).toBe('failed')
    expect(rejected.errorStatus).toBe('BACKEND_CONFIRMED_REJECTION')
    expect(rejected.frozenRequest).toEqual(h.initial.frozenRequest)
    expect(h.state.batchSubmissions).toBe(0)
    expect(h.state.authSignatures).toBe(0)
    expect(h.state.intentSignatures).toBe(0)
  })

  test('keeps unknown Cluster business errors pending for order history', async () => {
    const h = await harness('submitting', false, true)
    h.state.submitError = new ConfidentialFundingApiError('other rejection', 200, false, 2003)
    const pending = await h.restart().continuePlan(h.initial.planId)
    expect(pending.phase).toBe('submitting')
    expect(pending.batchSubmissionAttemptedAt).toBe(now)
    expect(pending.frozenRequest).toEqual(h.initial.frozenRequest)
    expect(h.state.batchSubmissions).toBe(1)
    expect(h.state.monitoring).toBeGreaterThan(0)
  })

  test('releases an unsent Cluster batch after definite history authentication rejection', async () => {
    const h = await harness('submitting', false, true)
    h.state.historyToken = null
    h.state.historyAuthError = new ConfidentialFundingApiError(
      'Origin must be a valid HTTP origin',
      400,
      false
    )
    const failed = await h.restart().continuePlan(h.initial.planId)
    expect(failed.phase).toBe('failed')
    expect(failed.errorStatus).toBe('HISTORY_AUTH_REJECTED')
    expect(failed.frozenRequest).toBeUndefined()
    expect(failed.requestFingerprint).toBeUndefined()
    expect(failed.withdraws.every(row => row.status === 'FAILED' && !row.signedPayload)).toBe(true)
    expect(failed.batchSubmissionAttemptedAt).toBeUndefined()
    expect(h.state.batchSubmissions).toBe(0)
    expect(h.state.intentSignatures).toBe(0)
    const graph = await h.repository.get(scope, h.initial.transactionId)
    expect(graph.root.status).toBe('failed')
    expect(
      graph.segments.filter(row => row.role === 'destination').every(row => row.status === 'failed')
    ).toBe(true)

    const balance = directPreparationHarness()
    balance.plans.set(failed.planId, failed)
    expect((await balance.coordinator.prepare(balance.request('100'))).sourceAmountRaw).toBe('100')
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('failed')
    expect(h.state.batchSubmissions).toBe(0)
  })

  test('blocks a new deposit-backed Cluster before signing when history authentication fails', async () => {
    const h = await harness('submitting', false, true)
    const { frozenRequest: _frozenRequest, requestFingerprint: _fingerprint, ...base } = h.initial
    const prepared = {
      ...base,
      phase: 'prepared',
      sourceDomain: 'public',
      requiresDeposit: true,
      depositQuote: { quote: { amountOut: '3000' } },
      preparedDeposit: { commandId: 'prepared-deposit' },
      withdraws: base.withdraws.map(({ signedPayload: _signedPayload, ...row }) => ({
        ...row,
        status: 'PREVIEW'
      }))
    }
    prepared.approvalFingerprint = await fingerprintDirectConfidentialApproval({
      network: prepared.network,
      keyDomainId: prepared.keyDomainId,
      accountId: prepared.accountId,
      operation: prepared.operation,
      sourceDomain: prepared.sourceDomain,
      destinationDomain: prepared.destinationDomain,
      source: prepared.source,
      destination: prepared.destination,
      signerId: prepared.signerId,
      addressIndex: prepared.addressIndex,
      slippageBps: prepared.slippageBps,
      expectedOutputRaw: prepared.expectedOutputRaw,
      minimumOutputRaw: prepared.minimumOutputRaw,
      expiresAt: prepared.approvalExpiresAt,
      depositQuote: prepared.depositQuote,
      preparedDeposit: prepared.preparedDeposit,
      withdraws: prepared.withdraws
    })
    await h.store.putPlan(prepared)
    h.state.historyToken = null
    h.state.historyAuthError = new ConfidentialFundingApiError(
      'Origin must be a valid HTTP origin',
      400,
      false
    )
    await expect(
      h.restart().confirm(prepared.planId, prepared.approvalFingerprint)
    ).rejects.toThrow('Origin must be a valid HTTP origin')
    const failed = await h.store.getPlan(prepared.planId)
    expect(failed.phase).toBe('failed')
    expect(failed.errorStatus).toBe('HISTORY_AUTH_REJECTED')
    expect(h.state.depositSignatures).toBe(0)
    expect(h.state.cancelledDeposits).toBe(1)
    expect(h.state.batchSubmissions).toBe(0)
    expect(h.state.intentSignatures).toBe(0)
  })

  test('retains an attempted Cluster batch when history authentication is rejected', async () => {
    const h = await harness('submitting', false, true)
    await h.store.putPlan({ ...h.initial, batchSubmissionAttemptedAt: now })
    h.state.historyToken = null
    h.state.historyAuthError = new ConfidentialFundingApiError(
      'Origin must be a valid HTTP origin',
      400,
      false
    )
    const pending = await h.restart().continuePlan(h.initial.planId)
    expect(pending.phase).toBe('submitting')
    expect(pending.batchSubmissionAttemptedAt).toBe(now)
    expect(pending.frozenRequest).toEqual(h.initial.frozenRequest)
    expect(pending.withdraws.every(row => Boolean(row.signedPayload))).toBe(true)
    expect(h.state.batchSubmissions).toBe(0)
    expect(h.state.monitoring).toBeGreaterThan(0)
  })

  test('does not replace a service-refunded Cluster child with stale 1Click success', async () => {
    const h = await harness('processing', false, true)
    h.state.acceptedOrder = {
      orderId: 'order-one',
      signerId,
      status: 'PARTIAL',
      mode: 'TRANSFER',
      fromAmount: '3000',
      fromChain: 'eth',
      fromToken: h.initial.source.protocolAssetId,
      transactions: h.initial.withdraws.map(row => ({
        sequence: row.sequence,
        transactionType: 'WITHDRAW',
        amount: row.amountRaw,
        depositAddress: row.depositAddress,
        destinationAddress: row.destinationAddress,
        destinationChain: row.destinationChain,
        token: row.token,
        status: row.sequence === 0 ? 'REFUNDED' : 'SCHEDULED'
      }))
    }
    h.state.statuses = ['SUCCESS', 'PROCESSING', 'PROCESSING']
    const plan = await h.restart().continuePlan(h.initial.planId)
    expect(plan.phase).toBe('processing')
    expect(plan.withdraws[0].status).toBe('REFUNDED')
    expect(plan.withdraws[1].status).toBe('PROCESSING')
  })

  test('renews an expired history session to observe a pre-broadcast Cluster failure', async () => {
    const h = await harness('processing', false, true)
    h.state.historyToken = null
    h.state.acceptedOrder = {
      orderId: 'order-one',
      signerId,
      status: 'PARTIAL',
      mode: 'TRANSFER',
      fromAmount: '3000',
      fromChain: 'eth',
      fromToken: h.initial.source.protocolAssetId,
      transactions: h.initial.withdraws.map(row => ({
        sequence: row.sequence,
        transactionType: 'WITHDRAW',
        amount: row.amountRaw,
        depositAddress: row.depositAddress,
        destinationAddress: row.destinationAddress,
        destinationChain: row.destinationChain,
        token: row.token,
        status: row.sequence === 0 ? 'EXPIRED' : 'SCHEDULED'
      }))
    }
    h.state.statuses = ['PENDING_DEPOSIT', 'PROCESSING', 'PROCESSING']
    const plan = await h.restart().continuePlan(h.initial.planId)
    expect(h.state.historySignatures).toBe(1)
    expect(h.state.batchSubmissions).toBe(0)
    expect(plan.withdraws[0].status).toBe('EXPIRED')
    expect(plan.phase).toBe('processing')
  })
})
