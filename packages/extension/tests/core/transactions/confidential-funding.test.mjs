import { test } from 'node:test'
import { expect } from '@playwright/test'
import { ConfidentialFundingApi } from '../../../src/background/confidential-funding-api.ts'
import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'
import {
  createExternalShieldDepositGraph,
  isExternalShieldDepositAutoHidden,
  shouldAutoRefreshExternalShieldDeposit,
  projectExternalShieldDepositActivityGraph
} from '../../../src/core/services/confidential-funding/confidential-external-deposit.ts'

import {
  aggregateConfidentialSettlement,
  assertDirectConfidentialWithdrawIntentBinding,
  assertConfidentialIntentBinding,
  assertConfidentialQuoteBinding,
  fingerprintConfidentialValue,
  mergeConfidentialWithdrawObservation,
  splitConfidentialFundingAmount
} from '../../../src/core/services/confidential-funding/confidential-funding-model.ts'
import { confidentialPrivateTokenId } from '../../../src/core/services/confidential-funding/confidential-funding-portfolio.ts'
import { getEvmNetworkConfigs } from '../../../src/config/networks.ts'

const apiConfig = {
  oneClickApiUrl: 'https://example.test/1click',
  oneClickDirectApiUrl: 'https://direct.example.test/v0',
  rheaSwapApiUrl: 'https://example.test'
}

test.describe('confidential funding safety rules', () => {
  test('external Shield deposit is account-bound, idempotent and recovers from status without local signing', async () => {
    const address = '0x1111111111111111111111111111111111111111'
    const refundAddress = '0x2222222222222222222222222222222222222222'
    const source = {
      chainId: 'eip155:8453',
      chainName: 'Base',
      assetId: 'eip155:8453/slip44:60',
      protocolAssetId: 'nep141:base.omft.near',
      amountRaw: '1000'
    }
    const records = new Map()
    const repository = new InMemoryTransactionRepository()
    let quoteCalls = 0
    let catalogBlockchain = 'base'
    let balanceReads = 0
    let simulateConcurrentBalanceReads = false
    let concurrentBalanceRead = 0
    let cachedBalance
    let signingCalls = 0
    let serviceStatus = 'PENDING_DEPOSIT'
    let depositedAmountRaw
    let now = 1_000
    let statusCalls = 0
    let monitoringCalls = 0
    const coordinatorOptions = {
      network: 'mainnet',
      api: {
        async quote(request) {
          quoteCalls += 1
          return {
            correlationId: 'external-quote',
            quoteRequest: {
              swapType: 'EXACT_INPUT',
              confidentiality: 'basic',
              originAsset: request.originAsset,
              destinationAsset: request.destinationAsset,
              amount: request.amountRaw,
              refundTo: request.refundTo,
              depositType: request.depositType,
              refundType: request.refundType,
              recipient: request.recipient,
              recipientType: request.recipientType,
              slippageTolerance: request.slippageBps
            },
            quote: {
              amountIn: '1000',
              amountOut: '990',
              minAmountOut: '980',
              depositAddress: '0x3333333333333333333333333333333333333333',
              depositMemo: 'memo-1',
              deadline: new Date(60_000).toISOString()
            }
          }
        },
        async getOneClickStatus(_address, memo) {
          statusCalls += 1
          expect(memo).toBe('memo-1')
          return {
            status: serviceStatus,
            ...(depositedAmountRaw !== undefined ? { depositedAmountRaw } : {}),
            ...(serviceStatus === 'SUCCESS' ? { settledAmountOutRaw: '987' } : {})
          }
        },
        async getBalances() {
          balanceReads += 1
          if (simulateConcurrentBalanceReads) {
            const read = ++concurrentBalanceRead
            await new Promise(resolve => setTimeout(resolve, read === 1 ? 15 : 0))
            return [{ tokenId: source.protocolAssetId, available: String(read), source: 'intents' }]
          }
          return []
        }
      },
      store: {
        async getExternalDeposit(id) {
          return records.get(id) ?? null
        },
        async listExternalDeposits() {
          return [...records.values()]
        },
        async listPlans() {
          return []
        },
        async putExternalDeposit(record) {
          records.set(record.depositId, structuredClone(record))
        },
        async withExternalDepositScope(_scope, operation) {
          return operation()
        },
        async getSession() {
          return { accessToken: 'synthetic', expiresAt: now + 1_000_000 }
        },
        async putBalances(_network, _domain, _account, balances) {
          cachedBalance = balances
        }
      },
      signer: {
        async resolveIdentity() {
          return {
            address,
            addressIndex: 0,
            peaAddress: refundAddress,
            context: {
              chainAccount: {
                scope: {
                  keyDomainId: 'wallet:one',
                  accountId: 'account:one',
                  chainId: 'eip155:8453'
                }
              }
            }
          }
        },
        async signMessage() {
          signingCalls += 1
          throw new Error('Unexpected signing')
        },
        async prepareTransaction() {
          signingCalls += 1
          throw new Error('Unexpected signing')
        }
      },
      repository,
      assets: { get: () => ({ asset: {}, metadata: { symbol: 'ETH', decimals: 18 } }) },
      protocolTokens: [{ assetId: source.protocolAssetId, blockchain: 'base', decimals: 18 }],
      getProtocolTokens: () => [
        { assetId: source.protocolAssetId, blockchain: catalogBlockchain, decimals: 18 }
      ],
      evmNetworks: getEvmNetworkConfigs('mainnet').filter(
        network => network.chainId === source.chainId
      ),
      assetMappings: [{ assetId: source.assetId, protocolAssetId: source.protocolAssetId }],
      now: () => now,
      createId: () => 'external-one',
      scheduleMonitoring: async () => {
        monitoringCalls += 1
      }
    }
    const coordinator = new ConfidentialFundingCoordinator(coordinatorOptions)
    const request = {
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source,
      refundAddress,
      requestId: 'create-one'
    }
    const created = await coordinator.createExternalDeposit(request)
    const pendingGraph = createExternalShieldDepositGraph(created)
    expect(() => assertPersistableTransactionGraph(pendingGraph)).not.toThrow()
    expect(() =>
      assertPersistableTransactionGraph({
        ...pendingGraph,
        root: {
          ...pendingGraph.root,
          intent: { ...pendingGraph.root.intent, direction: 'outgoing' }
        }
      })
    ).toThrow('signed transaction graph')
    const failedGraph = {
      root: {
        ...pendingGraph.root,
        status: 'failed',
        failure: { code: 'relay-failed', occurredAt: 2_000 }
      },
      segments: pendingGraph.segments.map(segment => ({
        ...segment,
        status: 'failed',
        failure: { code: 'relay-failed', occurredAt: 2_000 }
      }))
    }
    const refundedView = projectExternalShieldDepositActivityGraph(failedGraph, {
      ...created,
      phase: 'refunded',
      updatedAt: 3_000
    })
    expect(failedGraph.root.failure.code).toBe('relay-failed')
    expect(refundedView.root.failure.code).toBe('refunded')
    expect(refundedView.segments.every(segment => segment.failure.code === 'refunded')).toBe(true)
    expect(
      projectExternalShieldDepositActivityGraph(failedGraph, {
        ...created,
        accountId: 'other',
        phase: 'refunded'
      })
    ).toBe(failedGraph)
    expect(created.depositAddress).toBe('0x3333333333333333333333333333333333333333')
    expect(created.depositMemo).toBe('memo-1')
    records.set(created.depositId, {
      ...records.get(created.depositId),
      source: Object.fromEntries(Object.entries(source).reverse())
    })
    expect((await coordinator.createExternalDeposit(request)).depositId).toBe(created.depositId)
    catalogBlockchain = 'eth'
    await expect(
      coordinator.createExternalDeposit({
        ...request,
        requestId: 'wrong-source-network',
        source
      })
    ).rejects.toThrow('asset catalog changed')
    catalogBlockchain = 'base'
    expect(quoteCalls).toBe(1)
    await expect(
      coordinator.createExternalDeposit({ ...request, accountId: 'other' })
    ).rejects.toThrow('Account changed')
    await expect(
      coordinator.createExternalDeposit({ ...request, refundAddress: address })
    ).rejects.toThrow('request ID was reused')
    const unfunded = await coordinator.refreshExternalDeposit(created.depositId)
    now += 3 * 60 * 60 * 1000
    expect(shouldAutoRefreshExternalShieldDeposit(unfunded, now - 1)).toBe(true)
    const beforePause = { statusCalls, monitoringCalls }
    await new ConfidentialFundingCoordinator(coordinatorOptions).resumeAll()
    expect({ statusCalls, monitoringCalls }).toEqual(beforePause)
    expect(await coordinator.getExternalDeposit(created.depositId)).toEqual(unfunded)
    expect(
      isExternalShieldDepositAutoHidden(unfunded, created.createdAt + 24 * 60 * 60 * 1000 - 1)
    ).toBe(false)
    now = created.createdAt + 24 * 60 * 60 * 1000
    expect(isExternalShieldDepositAutoHidden(unfunded, now)).toBe(true)

    // A manual refresh can discover late funding even after automatic monitoring stops.
    serviceStatus = 'INCOMPLETE_DEPOSIT'
    const fundedWithoutAmount = await coordinator.refreshExternalDeposit(created.depositId)
    expect(fundedWithoutAmount.fundingObservedAt).toBe(now)
    expect(monitoringCalls).toBeGreaterThan(beforePause.monitoringCalls)
    serviceStatus = 'EXPIRED'
    now += 24 * 60 * 60 * 1000
    await new ConfidentialFundingCoordinator(coordinatorOptions).resumeAll()
    const expiredPartial = await coordinator.getExternalDeposit(created.depositId)
    expect(expiredPartial.providerStatus).toBe('EXPIRED')
    expect(expiredPartial.fundingObservedAt).toBe(fundedWithoutAmount.fundingObservedAt)
    expect(isExternalShieldDepositAutoHidden(expiredPartial, now)).toBe(false)
    const beforeRecovery = statusCalls
    await new ConfidentialFundingCoordinator(coordinatorOptions).resumeAll()
    expect(statusCalls).toBe(beforeRecovery + 1)
    serviceStatus = 'INCOMPLETE_DEPOSIT'
    depositedAmountRaw = '400'
    expect((await coordinator.refreshExternalDeposit(created.depositId)).depositedAmountRaw).toBe(
      '400'
    )
    depositedAmountRaw = '200'
    expect((await coordinator.refreshExternalDeposit(created.depositId)).depositedAmountRaw).toBe(
      '400'
    )
    serviceStatus = 'PROCESSING'
    expect((await coordinator.refreshExternalDeposit(created.depositId)).phase).toBe('processing')
    serviceStatus = 'INCOMPLETE_DEPOSIT'
    depositedAmountRaw = '500'
    const processingPartial = await coordinator.refreshExternalDeposit(created.depositId)
    expect(processingPartial.phase).toBe('processing')
    expect(processingPartial.depositedAmountRaw).toBe('500')
    serviceStatus = 'SUCCESS'
    depositedAmountRaw = '1000'
    expect((await coordinator.refreshExternalDeposit(created.depositId)).phase).toBe('ready')
    expect(balanceReads).toBe(1)
    const graph = await repository.get(
      { keyDomainId: 'wallet:one', accountId: 'account:one' },
      created.transactionId
    )
    expect(graph.root.status).toBe('final')
    expect(graph.root.intent.counterAmount.amountRaw).toBe('990')
    expect(graph.segments.find(segment => segment.role === 'destination').evidence).toMatchObject({
      settledAmount: { assetId: source.assetId, amountRaw: '987' }
    })
    expect((await coordinator.getExternalDeposit(created.depositId)).settledOutputRaw).toBe('987')
    expect((await coordinator.getExternalDeposit(created.depositId)).depositedAmountRaw).toBe(
      '1000'
    )
    expect((await coordinator.refreshExternalDeposit(created.depositId)).phase).toBe('ready')
    expect(balanceReads).toBe(1)
    expect(signingCalls).toBe(0)

    for (const [depositId, phase] of [
      ['refund-recovery', 'refunded'],
      ['failure-recovery', 'failed'],
      ['ready-recovery', 'ready']
    ]) {
      const interrupted = {
        ...created,
        depositId,
        transactionId: `tx:confidential-external:${depositId}`,
        phase,
        ...(phase === 'ready' ? { settledOutputRaw: '987', balanceRefreshedAt: 1_000 } : {})
      }
      records.set(depositId, interrupted)
      await repository.create(createExternalShieldDepositGraph(interrupted))
    }
    await coordinator.resumeAll()
    for (const [depositId, expectedStatus] of [
      ['refund-recovery', 'failed'],
      ['failure-recovery', 'failed'],
      ['ready-recovery', 'final']
    ]) {
      const recovered = await repository.get(
        { keyDomainId: 'wallet:one', accountId: 'account:one' },
        `tx:confidential-external:${depositId}`
      )
      expect(recovered.root.status).toBe(expectedStatus)
    }
    const refundGraph = await repository.get(
      { keyDomainId: 'wallet:one', accountId: 'account:one' },
      'tx:confidential-external:refund-recovery'
    )
    expect(refundGraph.root.failure.code).toBe('refunded')
    const readyGraph = await repository.get(
      { keyDomainId: 'wallet:one', accountId: 'account:one' },
      'tx:confidential-external:ready-recovery'
    )
    expect(
      readyGraph.segments.find(segment => segment.role === 'destination').evidence
    ).toMatchObject({
      settledAmount: { amountRaw: '987' }
    })
    for (const depositId of ['balance-recovery-one', 'balance-recovery-two']) {
      const pendingBalance = {
        ...created,
        depositId,
        transactionId: `tx:confidential-external:${depositId}`,
        phase: 'ready',
        settledOutputRaw: '987'
      }
      records.set(depositId, pendingBalance)
      await repository.create(createExternalShieldDepositGraph(pendingBalance))
    }
    simulateConcurrentBalanceReads = true
    await Promise.all([
      coordinator.refreshExternalDeposit('balance-recovery-one'),
      coordinator.refreshExternalDeposit('balance-recovery-two')
    ])
    expect(cachedBalance).toEqual([
      { tokenId: source.protocolAssetId, available: '2', source: 'intents' }
    ])
  })
  test('does not turn a malformed balance response into a confirmed zero', async () => {
    const originalFetch = globalThis.fetch
    const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', '')
    let request
    globalThis.fetch = async (url, init) => {
      request = { url, init }
      return new Response(
        JSON.stringify({
          balances: [{ tokenId: 'nep141:eth.omft.near', available: 'unknown' }]
        }),
        { status: 200 }
      )
    }
    try {
      await expect(api.getBalances('session')).rejects.toThrow('balance row is invalid')
      expect(request.url).toBe('https://direct.example.test/v0/account/balances')
      expect(request.init.headers.Authorization).toBe('Bearer session')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('keeps the destination hash from a pending RHEA order status', async () => {
    const originalFetch = globalThis.fetch
    const hash = `0x${'cd'.repeat(32)}`
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 0, data: { status: 'PROCESSING', toHash: hash } }), {
        status: 200
      })
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'test-token')
      await expect(api.getStatus('deposit-address', '1')).resolves.toMatchObject({
        status: 'PROCESSING',
        transactionHash: hash
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('accepts a pending internal swap status and rejects a mismatched echoed quote', async () => {
    const originalFetch = globalThis.fetch
    let echoedAddress = 'deposit-one'
    let echoedMemo
    globalThis.fetch = async url => {
      expect(url).toBe(
        `https://example.test/1click/status?depositAddress=deposit-one${echoedMemo ? '&depositMemo=+memo-1+' : ''}`
      )
      return new Response(
        JSON.stringify({
          status: 'PENDING_DEPOSIT',
          quoteResponse: {
            quote: {
              depositAddress: echoedAddress,
              ...(echoedMemo ? { depositMemo: echoedMemo } : {})
            }
          },
          swapDetails: { depositedAmount: '400' }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', '')
      await expect(api.getOneClickStatus('deposit-one')).resolves.toMatchObject({
        status: 'PENDING_DEPOSIT',
        depositedAmountRaw: '400'
      })
      echoedMemo = ' memo-1 '
      await expect(api.getOneClickStatus('deposit-one', ' memo-1 ')).resolves.toMatchObject({
        status: 'PENDING_DEPOSIT'
      })
      echoedMemo = 'different'
      await expect(api.getOneClickStatus('deposit-one', ' memo-1 ')).rejects.toThrow(
        'memo does not match'
      )
      echoedMemo = undefined
      echoedAddress = 'deposit-other'
      await expect(api.getOneClickStatus('deposit-one')).rejects.toThrow('does not match')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('binds confidential quote fees to the current application config', async () => {
    const originalFetch = globalThis.fetch
    let feeConfig = {
      appId: 'ak_test',
      confidentialAppFeeBps: 0,
      confidentialAppFeeRecipient: '',
      confidentialPlatformFeeBps: 50,
      confidentialPlatformFeeRecipient: 'platform.near'
    }
    let echoedFees
    const quoteRequests = []
    let feeReads = 0
    let providerFee = { recipient: 'provider.near', fee: 20 }
    globalThis.fetch = async (url, init) => {
      if (url === 'https://example.test/api/swap/confidential-app-fee') {
        feeReads += 1
        expect(init.headers.Authorization).toBe('Bearer swap-jwt')
        return new Response(JSON.stringify({ code: 0, data: feeConfig }), { status: 200 })
      }
      expect(url).toBe('https://example.test/1click/quote')
      const requestBody = JSON.parse(init.body)
      quoteRequests.push(requestBody)
      const responseFees =
        requestBody.depositType === 'CONFIDENTIAL_INTENTS'
          ? requestBody.appFees
            ? (echoedFees ?? [...requestBody.appFees, ...(providerFee ? [providerFee] : [])])
            : providerFee
              ? [providerFee]
              : []
          : undefined
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            correlationId: 'quote-1',
            quoteRequest: {
              ...requestBody,
              ...(responseFees !== undefined ? { appFees: responseFees } : {})
            },
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
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      const withdrawal = {
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
      }
      const quotedWithdrawal = await api.quote(withdrawal)
      expect(quoteRequests[0].dry).toBe(true)
      expect(quoteRequests[0].appFees).toBeUndefined()
      expect(quoteRequests[1].referral).toBe('noir_swap')
      expect(quoteRequests[1].appFees).toEqual([{ recipient: 'platform.near', fee: 50 }])
      expect(quotedWithdrawal.quoteRequest.appFees).toEqual([
        { recipient: 'platform.near', fee: 50 },
        providerFee
      ])
      expect(feeReads).toBe(1)
      await api.quote({
        ...withdrawal,
        depositType: 'ORIGIN_CHAIN',
        recipientType: 'CONFIDENTIAL_INTENTS'
      })
      expect(quoteRequests[2].appFees).toBeUndefined()
      expect(feeReads).toBe(1)
      await api.quote({
        ...withdrawal,
        recipient: withdrawal.signerId,
        recipientType: 'CONFIDENTIAL_INTENTS',
        dry: true
      })
      expect(quoteRequests[4]).toMatchObject({
        swapType: 'EXACT_INPUT',
        depositType: 'CONFIDENTIAL_INTENTS',
        recipientType: 'CONFIDENTIAL_INTENTS',
        refundType: 'CONFIDENTIAL_INTENTS',
        recipient: withdrawal.signerId,
        refundTo: withdrawal.signerId,
        appFees: [{ recipient: 'platform.near', fee: 50 }]
      })
      const concurrentApi = new ConfidentialFundingApi(
        apiConfig,
        'https://near.example.test',
        'swap-jwt'
      )
      await Promise.all([concurrentApi.quote(withdrawal), concurrentApi.quote(withdrawal)])
      expect(feeReads).toBe(2)
      echoedFees = [{ recipient: 'platform.near', fee: 2 }]
      await expect(api.quote(withdrawal)).rejects.toThrow('app fees do not match')
      echoedFees = [
        { recipient: 'platform.near', fee: 50 },
        { ...providerFee, recipient: 'other.near' }
      ]
      await expect(api.quote(withdrawal)).rejects.toThrow('app fees do not match')
      echoedFees = undefined
      providerFee = undefined
      const partnerQuote = await api.quote(withdrawal)
      expect(partnerQuote.quoteRequest.appFees).toEqual([{ recipient: 'platform.near', fee: 50 }])
      providerFee = { recipient: 'provider.near', fee: 1 }
      const lowFeeQuote = await api.quote(withdrawal)
      expect(lowFeeQuote.quoteRequest.appFees).toEqual([
        { recipient: 'platform.near', fee: 50 },
        providerFee
      ])
      echoedFees = [
        { recipient: 'platform.near', fee: 50 },
        { recipient: 'provider.near', fee: 2 }
      ]
      await expect(api.quote(withdrawal)).rejects.toThrow('app fees do not match')
      echoedFees = undefined
      providerFee = { recipient: 'provider.near', fee: 21 }
      await expect(api.quote(withdrawal)).rejects.toThrow('provider fee quote is invalid')
      feeConfig = { ...feeConfig, confidentialPlatformFeeBps: 10_001 }
      await expect(
        new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt').quote(
          withdrawal
        )
      ).rejects.toThrow('fee rate is invalid')
      expect(quoteRequests).toHaveLength(20)
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

  test('binds the only Shield withdraw action to the approved receiver, asset, and amount', () => {
    const deadline = new Date(Date.now() + 60_000).toISOString()
    const sourceAsset = 'nep141:eth.omft.near'
    const destinationAsset = 'nep141:usdc.omft.near'
    const signerId = '0x1111111111111111111111111111111111111111'
    const destinationAddress = '0x2222222222222222222222222222222222222222'
    const quote = {
      quoteRequest: { originAsset: sourceAsset, destinationAsset, recipient: destinationAddress },
      quote: { amountIn: '1000', depositAddress: 'deposit.near', deadline }
    }
    const payload = {
      verifying_contract: 'intents.far',
      signer_id: signerId,
      deadline,
      nonce: btoa(String.fromCharCode(...new Uint8Array(32))),
      intents: [
        {
          intent: 'transfer',
          receiver_id: 'deposit.near',
          tokens: { [confidentialPrivateTokenId(sourceAsset)]: '1000' }
        }
      ]
    }
    const check = changed =>
      assertDirectConfidentialWithdrawIntentBinding({
        intent: { standard: 'erc191', payload: JSON.stringify(changed) },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      })
    expect(check(payload).standard).toBe('erc191')
    const action = payload.intents[0]
    for (const changed of [
      { ...payload, verifying_contract: 'intents.near' },
      { ...payload, signer_id: destinationAddress },
      { ...payload, intents: [...payload.intents, action] },
      { ...payload, intents: [{ ...action, receiver_id: destinationAddress }] },
      {
        ...payload,
        intents: [{ ...action, tokens: { [confidentialPrivateTokenId(sourceAsset)]: '1001' } }]
      },
      {
        ...payload,
        intents: [{ ...action, tokens: { [confidentialPrivateTokenId(destinationAsset)]: '1000' } }]
      },
      { ...payload, intents: [{ ...action, tokens: { ...action.tokens, extra: '1' } }] },
      { ...payload, intents: [{ ...action, extra: 'value' }] }
    ])
      expect(() => check(changed)).toThrow('Shield withdraw intent')
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

  test('submits signed single and Cluster withdrawals with Swap authorization', async () => {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ code: 0, data: { order_id: 'order-1' } }), {
        status: 200
      })
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      const row = sequence => ({
        amount: '10',
        deposit_address: `deposit-${sequence}`,
        destination_address: '0x2222222222222222222222222222222222222222',
        destination_chain: 'eth',
        execution_type: 'CONFIDENTIAL_1CLICK',
        sequence,
        signed_payload: { standard: 'erc191', payload: '{}', signature: 'secp256k1:signature' },
        token: 'nep141:eth.omft.near'
      })
      await expect(
        api.submitWithdraws({
          from_amount: '20',
          from_chain: 'eth',
          from_token: 'nep141:eth.omft.near',
          mode: 'TRANSFER',
          signer_id: '0x1111111111111111111111111111111111111111',
          withdraws: [row(0), row(1)]
        })
      ).resolves.toEqual({ orderId: 'order-1' })
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://example.test/v3/private/withdraws')
      expect(calls[0].init.headers.Authorization).toBe('Bearer swap-jwt')
      expect(JSON.parse(calls[0].init.body)).toMatchObject({
        signer_chain_family: 'evm',
        withdraws: [{ sequence: 0 }, { sequence: 1 }]
      })
      await expect(
        api.submitWithdraws({
          from_amount: '10',
          from_chain: 'eth',
          from_token: 'nep141:eth.omft.near',
          mode: 'SWAP',
          signer_id: '0x1111111111111111111111111111111111111111',
          withdraws: [row(0)]
        })
      ).resolves.toEqual({ orderId: 'order-1' })
      expect(calls).toHaveLength(2)
      expect(JSON.parse(calls[1].init.body)).toMatchObject({
        mode: 'SWAP',
        signer_chain_family: 'evm',
        withdraws: [{ sequence: 0 }]
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('preserves a private batch business rejection code', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 2002, msg: 'app fee does not match' }), { status: 200 })
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      await expect(api.submitWithdraws({ withdraws: [{}, {}] })).rejects.toMatchObject({
        status: 200,
        businessCode: 2002,
        ambiguous: false
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects malformed or mismatched private withdrawal history', async () => {
    const originalFetch = globalThis.fetch
    const signerId = '0x1111111111111111111111111111111111111111'
    const row = {
      transaction_type: 'WITHDRAW',
      sequence: 0,
      amount: '10',
      deposit_address: 'deposit-0',
      destination_address: '0x2222222222222222222222222222222222222222',
      destination_chain: 'eth',
      token: 'nep141:eth.omft.near',
      status: 'PENDING',
      scheduled_at: 12345,
      payload_deadline: 99999
    }
    let signer = signerId
    let includeUnrelatedDeposit = false
    let requestHeaders
    globalThis.fetch = async (_url, init) => {
      requestHeaders = init.headers
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            list: [
              ...(includeUnrelatedDeposit
                ? [
                    {
                      order: { order_id: 'other-order', signer_id: signer, status: 'PENDING' },
                      transactions: [
                        { transaction_type: 'DEPOSIT', amount: '10', status: 'PENDING' }
                      ]
                    }
                  ]
                : []),
              {
                order: { order_id: 'order-1', signer_id: signer, status: 'PENDING' },
                transactions: [row]
              }
            ],
            has_next_page: false
          }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      await expect(
        api.getPrivateOrders({ walletToken: 'wallet-jwt', signerId })
      ).resolves.toMatchObject({
        orders: [{ transactions: [{ sequence: 0, scheduledAt: 12345, deadline: 99999 }] }]
      })
      expect(requestHeaders.Authentication).toBe('wallet-jwt')
      expect(requestHeaders.Authorization).toBeUndefined()
      includeUnrelatedDeposit = true
      const page = await api.getPrivateOrders({ walletToken: 'wallet-jwt', signerId })
      expect(page.orders).toHaveLength(2)
      expect(page.orders[0].transactions[0]).toMatchObject({
        transactionType: 'DEPOSIT',
        depositAddress: ''
      })
      expect(page.orders[0].transactions[0].sequence).toBeUndefined()
      signer = '0x3333333333333333333333333333333333333333'
      await expect(api.getPrivateOrders({ walletToken: 'wallet-jwt', signerId })).rejects.toThrow(
        'signer does not match'
      )
      signer = signerId
      row.deposit_address = ''
      await expect(api.getPrivateOrders({ walletToken: 'wallet-jwt', signerId })).rejects.toThrow(
        'deposit address is missing'
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('binds wallet history authorization to a read-only SIWE challenge', async () => {
    const originalFetch = globalThis.fetch
    const walletAddress = '0x1111111111111111111111111111111111111111'
    const challengeId = 'challenge-1'
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const issuedAt = new Date().toISOString()
    const requestOrigin = `chrome-extension://${'a'.repeat(32)}`
    let messageOrigin = requestOrigin
    const message = scope =>
      `${new URL(messageOrigin).host} wants you to sign in with your Ethereum account:\n${walletAddress}\n\n` +
      `Authorize read-only access to confidential Unified Swap history.\n\n` +
      `URI: ${messageOrigin}\nVersion: 1\nChain ID: 1\nNonce: 12345678\n` +
      `Issued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nRequest ID: ${challengeId}\nResources:\n` +
      `- ${scope}\n- urn:rhea:wallet:evm:${walletAddress}\n- urn:rhea:app:ak_test`
    let scope = 'urn:rhea:swap:history:confidential:read'
    let queryAddress = walletAddress
    let proof
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/challenge')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              challengeId,
              expiresAt,
              chainFamily: 'evm',
              chainId: '1',
              address: walletAddress,
              walletAddress,
              identityKey: walletAddress,
              principalType: 'wallet',
              queryAddress,
              mcaAccountId: null,
              signingMethod: 'personal_sign',
              signingInput: { message: message(scope) }
            }
          }),
          { status: 200 }
        )
      }
      proof = JSON.parse(init.body).proof
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            token: 'wallet-jwt',
            tokenType: 'Bearer',
            expiresAt,
            scope: 'swap:history:confidential:read',
            principalType: 'wallet',
            queryAddress: walletAddress,
            mcaAccountId: null
          }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(
        apiConfig,
        'https://near.example.test',
        'swap-jwt',
        requestOrigin
      )
      const challenge = await api.createOrderAuthChallenge({ walletAddress, chainId: '1' })
      await expect(
        api.authenticateOrderChallenge(challenge, {
          standard: 'erc191',
          payload: challenge.message,
          signature: `secp256k1:${'1'.repeat(65)}`
        })
      ).resolves.toMatchObject({ token: 'wallet-jwt' })
      expect(proof.signature).toBe(`0x${'00'.repeat(64)}1b`)
      for (const wrongOrigin of [
        `chrome-extension://${'b'.repeat(32)}`,
        'https://x.rhea.finance'
      ]) {
        messageOrigin = wrongOrigin
        await expect(api.createOrderAuthChallenge({ walletAddress, chainId: '1' })).rejects.toThrow(
          'not read-only'
        )
      }
      messageOrigin = requestOrigin
      scope = 'urn:rhea:swap:withdraw:write'
      await expect(api.createOrderAuthChallenge({ walletAddress, chainId: '1' })).rejects.toThrow(
        'not read-only'
      )
      scope = 'urn:rhea:swap:history:confidential:read'
      queryAddress = '0x3333333333333333333333333333333333333333'
      await expect(api.createOrderAuthChallenge({ walletAddress, chainId: '1' })).rejects.toThrow(
        'does not match account'
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
