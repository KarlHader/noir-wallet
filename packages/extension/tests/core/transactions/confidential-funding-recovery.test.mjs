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
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'
import { parseTransactionGraph } from '../../../src/core/transactions/domain/index.ts'
import { confidentialPrivateTokenId } from '../../../src/core/services/confidential-funding/confidential-funding-portfolio.ts'
import { ZCASH_CHAIN_IDS } from '../../../src/core/chains/registry/chain-ids.ts'

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
    statuses: withdraws.map(() => (phase === 'processing' ? 'PROCESSING' : 'PENDING_DEPOSIT')),
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
      if (state.statusError) throw state.statusError
      const sequence = initial.withdraws.find(row => row.depositAddress === address).sequence
      const status = state.statuses[sequence]
      if (state.switchAccountAfterStatus) {
        state.identityAccount = 'other-account'
        state.switchAccountAfterStatus = false
      }
      if (status === null) throw new ConfidentialFundingApiError('unavailable', 503, false)
      return {
        status,
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
      refreshPortfolio: async () => {
        state.refreshes += 1
      }
    })
  return { initial, state, store, repository, restart }
}

function directPreparationHarness(protocolTokens) {
  const plans = new Map()
  const state = {
    now: 1_000,
    signatures: 0,
    identityChains: [],
    signingChains: [],
    formalQuotes: 0,
    formalQuoteAppFees: undefined,
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
    putBalances: async () => {}
  }
  const signer = {
    resolveIdentity: async chainId => {
      state.identityChains.push(chainId)
      return {
        address: signerId,
        peaAddress,
        addressIndex: 0,
        context: { chainAccount: { scope: { ...scope, chainId } } }
      }
    },
    signMessage: async input => {
      state.signatures += 1
      state.signingChains.push(input.chainId)
      throw new Error('unexpected signature')
    }
  }
  const api = {
    getBalances: async () => [
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
    ],
    quote: async input => {
      state.lastQuoteRequest = input
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
          refundTo: input.signerId,
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
          deadline: state.lastQuoteDeadline
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
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    api,
    store,
    signer,
    repository: new InMemoryTransactionRepository(),
    assets: { get: id => ({ metadata: { decimals: id === zcashAssetId ? 8 : 18 } }) },
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
    await expect(
      h.coordinator.prepare({
        ...withdraw,
        destination: { ...withdraw.destination, ...source }
      })
    ).rejects.toThrow('EVM signing chain')
    h.state.formalQuoteAppFees = [{ recipient: 'platform.near', fee: 50 }]
    await expect(h.coordinator.confirm(review.planId, review.payloadFingerprint)).rejects.toThrow(
      'unexpected signature'
    )
    expect(h.state.signingChains).toEqual(['eip155:1'])
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
    ).rejects.toThrow('EVM signing chain')
  })
  test('rejects a Shield source whose catalog precision changed before preparation', async () => {
    const h = directPreparationHarness([
      { assetId: 'nep141:eth.omft.near', blockchain: 'eth', decimals: 6 }
    ])
    await expect(h.coordinator.prepare(h.request('60'))).rejects.toThrow('asset catalog changed')
    expect(h.state.formalQuotes).toBe(0)
    expect(h.plans.size).toBe(0)
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
    const state = { prepared: null, broadcasts: 0 }
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
      getStatus: async () => ({ status: 'PROCESSING' }),
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
    const coordinator = new ConfidentialFundingCoordinator({
      network: 'mainnet',
      api,
      store,
      signer,
      repository: new InMemoryTransactionRepository(),
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
    const review = await coordinator.prepare({
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
    })
    const stored = await store.getPlan(review.planId)
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
    expect((await coordinator.confirm(review.planId, review.payloadFingerprint)).phase).toBe(
      'deposit-confirming'
    )
    expect(state.broadcasts).toBe(1)
  })

  test('reserves Shield funds across concurrent prepares and releases cancelled or expired reviews', async () => {
    const h = directPreparationHarness()
    const attempts = await Promise.allSettled([
      h.coordinator.prepare(h.request('60')),
      h.coordinator.prepare(h.request('50'))
    ])
    expect(attempts.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(attempts[1].reason.message).toContain('insufficient')
    const first = attempts[0].value
    await h.coordinator.cancel(first.planId)
    const second = await h.coordinator.prepare(h.request('50'))
    expect(second.withdrawCount).toBe(1)
    h.state.now = second.expiresAt + 1
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
    h.state.statuses = ['SUCCESS', 'PROCESSING', 'PROCESSING']
    expect((await h.restart().continuePlan(h.initial.planId)).phase).toBe('processing')
    h.state.statuses = ['PROCESSING', 'SUCCESS', null]
    const intermediate = await h.restart().continuePlan(h.initial.planId)
    expect(intermediate.withdraws.map(row => row.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'PROCESSING'
    ])
    expect(intermediate.withdraws[0].transactionHash).toBe('hash-0')
    h.state.statuses = ['FAILED', 'PROCESSING', 'SUCCESS']
    const ready = await h.restart().continuePlan(h.initial.planId)
    expect(ready.phase).toBe('ready')
    expect(ready.withdraws.map(row => row.transactionHash)).toEqual(['hash-0', 'hash-1', 'hash-2'])
    const graph = await h.repository.get(scope, h.initial.transactionId)
    expect(graph.root.status).toBe('final')
    expect(
      graph.segments.filter(row => row.role === 'destination').every(row => row.status === 'final')
    ).toBe(true)
    expect(h.state.refreshes).toBe(1)
    await h.restart().resumeAll()
    expect(h.state.refreshes).toBe(1)
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
    expect(h.state.refreshes).toBe(1)
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
