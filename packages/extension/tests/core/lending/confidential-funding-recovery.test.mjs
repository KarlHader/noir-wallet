import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import { ConfidentialFundingApiError } from '../../../src/background/confidential-funding-api.ts'
import { serializeConfidentialFundingPlan } from '../../../src/background/confidential-funding-store.ts'
import {
  createConfidentialFundingGraph,
  fingerprintConfidentialValue
} from '../../../src/core/services/confidential-funding/index.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'
import { parseTransactionGraph } from '../../../src/core/transactions/domain/index.ts'

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

async function harness(phase = 'submitting') {
  const withdraws = [0, 1, 2].map(sequence => ({
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
    from_amount: '3000',
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
    ...scope,
    phase,
    source: {
      chainId: 'eip155:1',
      chainName: 'eth',
      assetId: 'eip155:1/slip44:60',
      protocolAssetId: 'nep141:eth.omft.near',
      amountRaw: '3000',
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
    requiresDeposit: false,
    confidentialBaselineRaw: '3000',
    approvalFingerprint: 'a'.repeat(64),
    approvalExpiresAt: 50_000,
    expectedOutputRaw: '2970',
    minimumOutputRaw: '2940',
    splitSourceAmounts: ['1000', '1000', '1000'],
    withdraws,
    requestFingerprint: await fingerprintConfidentialValue(frozenRequest),
    ...(phase === 'submitting'
      ? {
          frozenRequest
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
    statuses:
      phase === 'processing'
        ? ['PROCESSING', 'PROCESSING', 'PROCESSING']
        : ['PENDING_DEPOSIT', 'PENDING_DEPOSIT', 'PENDING_DEPOSIT'],
    session: {
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: 1_000_000,
      refreshExpiresAt: 2_000_000
    },
    submitError: null,
    statusError: null,
    processingHashes: new Set(),
    identityAccount: scope.accountId
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
    async getSession() {
      return state.session
    },
    async putSession(_network, _domain, _account, session) {
      state.session = session
    },
    async deleteSession() {
      state.session = null
    },
    async putBalances() {}
  }
  const api = {
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
      if (payload !== 'authorize-session') {
        state.intentSignatures += 1
        throw new Error('Recovery must not re-sign withdraws')
      }
      state.authSignatures += 1
      return { standard: 'erc191', payload, signature: 'auth-signature' }
    }
  }
  const repository = new SignedTransactionRepository()
  const graph = createConfidentialFundingGraph({
    planId: initial.planId,
    scope,
    source: initial.source,
    destination: { ...initial.destination, expectedAmountRaw: initial.expectedOutputRaw },
    withdrawDepositAddresses: withdraws.map(row => row.depositAddress),
    requiresDeposit: false,
    signedWithdrawFingerprint: initial.requestFingerprint,
    now
  })
  await repository.create({
    ...graph,
    segments: graph.segments.map(segment =>
      segment.role === 'relay' || segment.role === 'destination'
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

test.describe('confidential funding persisted recovery', () => {
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
      expect(result.phase).toBe(modified ? 'submitting' : 'expired')
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
})
