import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BUILTIN_EVM_NETWORKS, EVM_NETWORKS } from '../../../src/config/networks.ts'
import { EvmDAppPrivateTransferCoordinator } from '../../../src/background/evm-dapp-private-transfer.ts'

const PEA = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const DESTINATION_HASH = `0x${'ab'.repeat(32)}`
const SOURCE_HASH = `0x${'cd'.repeat(32)}`

function createHarness({
  executionKind = 'evm-signature',
  approved = true,
  network = EVM_NETWORKS.mainnet,
  tokenContract,
  analytics
} = {}) {
  const calls = {
    approvals: [],
    cancelled: [],
    confirmed: [],
    discarded: [],
    events: [],
    preparedCalls: [],
    quotes: [],
    recorded: [],
    reports: 0,
    status: 'completed',
    statusReads: 0
  }
  const tokens = [
    {
      assetId: `nep141:${network.numericChainId}.native.omft.near`,
      blockchain: network.iconChain,
      contractAddress: null,
      decimals: 18,
      icon: null,
      isNative: true,
      price: null,
      priceUpdatedAt: null,
      rheaAddress: 'native',
      rheaChainId: String(network.numericChainId),
      symbol: network.nativeCurrency.symbol,
      tokenListChainId: network.numericChainId
    },
    {
      assetId: `nep141:${network.numericChainId}.token.omft.near`,
      blockchain: network.iconChain,
      contractAddress: '0x3333333333333333333333333333333333333333',
      decimals: 6,
      icon: null,
      isNative: false,
      price: null,
      priceUpdatedAt: null,
      rheaAddress: '0x3333333333333333333333333333333333333333',
      rheaChainId: String(network.numericChainId),
      symbol: 'USDC',
      tokenListChainId: network.numericChainId
    }
  ]
  const prepared = id => ({
    graph: { root: { id } },
    review: {
      payloadFingerprint: { digestHex: id.endsWith('1') ? '11'.repeat(32) : '22'.repeat(32) }
    }
  })
  const storeValues = new Map()
  let now = 1_000
  const service = {
    async listTokens() {
      return { tokens }
    },
    async quote(request) {
      calls.quotes.push(request)
      return {
        quoteHandle: 'rhea-quote:dapp-private',
        estimatedOut: '990',
        minAmountOut: '980',
        router: 'nearintents',
        receivedAt: now,
        expiresAt: now + 30_000
      }
    },
    async prepare() {
      return {
        quoteHandle: 'rhea-quote:dapp-private',
        estimatedOut: '990',
        minAmountOut: '980',
        router: 'nearintents',
        receivedAt: now,
        expiresAt: now + 30_000,
        executionId: 'execution-private',
        amountIn: '1000',
        isCrossChain: false,
        execution: {
          kind: executionKind,
          target:
            executionKind === 'evm-transaction'
              ? '0x4444444444444444444444444444444444444444'
              : null
        }
      }
    },
    async readEvmTransactionPlan() {
      return {
        transaction: {
          to: '0x4444444444444444444444444444444444444444',
          value: '0',
          data: '0x1234'
        },
        approval: {
          transaction: {
            to: '0x3333333333333333333333333333333333333333',
            value: '0',
            data: '0x5678'
          }
        }
      }
    },
    async readEvmSignaturePlan() {
      return { approval: null }
    },
    async recordTransactionSubmission(_quoteHandle, sourceHash) {
      calls.recorded.push(sourceHash)
      return {
        quoteHandle: 'rhea-quote:dapp-private',
        executionId: 'execution-private',
        router: 'nearintents',
        sourceHash,
        orderId: 'order-private',
        statusChainId: '1',
        reportStatus: 'pending'
      }
    },
    async reportSubmission() {
      calls.reports += 1
    },
    async getOrderStatus() {
      calls.statusReads += 1
      return {
        quoteHandle: 'rhea-quote:dapp-private',
        orderId: 'order-private',
        router: 'nearintents',
        status: calls.status,
        destinationHash: calls.status === 'completed' ? DESTINATION_HASH : null
      }
    },
    async discard(handle) {
      calls.discarded.push(handle)
    }
  }
  const coordinator = new EvmDAppPrivateTransferCoordinator({
    analytics,
    network,
    service,
    signatureCoordinator: {
      async prepare(quoteHandle, binding, executionMode) {
        calls.preparedSignature = { quoteHandle, binding, executionMode }
        return {
          quoteHandle,
          payloadFingerprint: '33'.repeat(32)
        }
      },
      async confirm(quoteHandle, fingerprint) {
        calls.confirmed.push({ quoteHandle, fingerprint })
        if (calls.confirmError) throw calls.confirmError
        return {
          submission: {
            quoteHandle,
            executionId: 'execution-private',
            router: 'nearintents',
            sourceHash: SOURCE_HASH,
            orderId: 'order-private',
            statusChainId: String(network.numericChainId),
            reportStatus: 'reported'
          },
          graph: {}
        }
      },
      async cancel(handle) {
        calls.cancelled.push(handle)
      }
    },
    transferController: {
      async prepareContractCall(intent, _feeTier, binding, account) {
        calls.events.push(binding ? 'prepare-route' : 'prepare-approval')
        calls.preparedCalls.push({ intent, binding, account })
        return prepared(`transaction:${calls.preparedCalls.length}`)
      },
      async approveForDApp(transactionId, _fingerprint, authorize) {
        calls.events.push(`approve:${transactionId}`)
        await authorize()
        return {
          graph: {
            root: { id: transactionId },
            segments: [{ role: 'origin', evidence: { transactionHash: SOURCE_HASH } }]
          }
        }
      },
      async reject(transactionId) {
        calls.cancelled.push(transactionId)
      }
    },
    approval: {
      async requestExternalApproval(origin, action, data) {
        calls.approvals.push({ origin, action, data })
        return { approved, requestId: 'approval-one' }
      }
    },
    store: {
      async get(fingerprint) {
        return structuredClone(storeValues.get(fingerprint) ?? null)
      },
      async put(value) {
        storeValues.set(value.fingerprint, structuredClone(value))
      },
      async delete(fingerprint) {
        storeValues.delete(fingerprint)
      }
    },
    now: () => now,
    waitMs: 3,
    pollMs: 1,
    sleep: async milliseconds => {
      now += milliseconds
    }
  })
  const input = {
    origin: 'https://private.example',
    chainId: network.chainId,
    account: {
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      address: PEA,
      addressIndex: 0
    },
    intent: {
      assetId: tokenContract
        ? `${network.chainId}/erc20:${tokenContract}`
        : `${network.chainId}/slip44:${network.nativeCurrency.slip44Reference}`,
      recipient: RECIPIENT,
      amountRaw: '1000'
    },
    ...(tokenContract === undefined ? {} : { tokenContract }),
    tabInfo: { title: 'Private dApp', pageUrl: 'https://private.example/page' },
    ensureIdentity: async () => {
      calls.identityChecks = (calls.identityChecks ?? 0) + 1
    }
  }
  return { calls, coordinator, input, storeValues }
}

test.describe('EVM dApp Private transfer coordinator', () => {
  test('submits signature execution through Confidential and returns the real destination hash', async () => {
    const h = createHarness()

    await expect(h.coordinator.send(h.input)).resolves.toBe(DESTINATION_HASH)

    expect(h.calls.quotes).toEqual([
      expect.objectContaining({
        fromChain: '1',
        toChain: '1',
        sender: PEA,
        recipient: RECIPIENT,
        amountIn: '1000',
        confidentiality: 'basic'
      })
    ])
    expect(h.calls.preparedSignature.binding.isCrossChain).toBe(true)
    expect(h.calls.preparedSignature.executionMode).toBe('private')
    expect(h.calls.approvals[0]).toEqual(
      expect.objectContaining({
        action: 'evmPrivateTransfer',
        data: expect.objectContaining({
          sourceAddress: PEA,
          recipient: RECIPIENT,
          router: 'nearintents'
        })
      })
    )
    expect(h.calls.confirmed).toHaveLength(1)
  })

  test('executes an exact token approval before the bound route transaction', async () => {
    const token = '0x3333333333333333333333333333333333333333'
    const h = createHarness({ executionKind: 'evm-transaction', tokenContract: token })

    await expect(h.coordinator.send(h.input)).resolves.toBe(DESTINATION_HASH)

    expect(h.calls.preparedCalls).toHaveLength(2)
    expect(h.calls.events).toEqual([
      'prepare-approval',
      'approve:transaction:1',
      'prepare-route',
      'approve:transaction:2'
    ])
    expect(h.calls.preparedCalls[0].binding).toBeUndefined()
    expect(h.calls.preparedCalls[0].account).toEqual(
      expect.objectContaining({ kind: 'pea', address: PEA })
    )
    expect(h.calls.preparedCalls[1].binding).toEqual(
      expect.objectContaining({
        sender: PEA,
        isCrossChain: true,
        destination: expect.objectContaining({ recipient: RECIPIENT })
      })
    )
    expect(h.calls.recorded).toEqual([SOURCE_HASH])
    expect(h.calls.reports).toBe(1)
    expect(h.calls.approvals[0].data.approvalRequired).toBe(true)
  })

  test('binds native and dynamic token routes across Ethereum, Base, and Polygon', async () => {
    const token = '0x3333333333333333333333333333333333333333'
    const networks = BUILTIN_EVM_NETWORKS.mainnet.filter(candidate =>
      [1, 8453, 137].includes(candidate.numericChainId)
    )

    for (const network of networks) {
      for (const tokenContract of [undefined, token]) {
        const h = createHarness({ network, tokenContract })
        await expect(h.coordinator.send(h.input)).resolves.toBe(DESTINATION_HASH)
        expect(h.calls.quotes[0]).toEqual(
          expect.objectContaining({
            fromChain: String(network.numericChainId),
            toChain: String(network.numericChainId),
            sender: PEA,
            recipient: RECIPIENT,
            tokenIn: expect.objectContaining({ chain: String(network.numericChainId) }),
            tokenOut: expect.objectContaining({ chain: String(network.numericChainId) }),
            confidentiality: 'basic'
          })
        )
      }
    }
  })

  test('rejects unknown tokens without approval or a direct transfer fallback', async () => {
    const h = createHarness({ tokenContract: '0x9999999999999999999999999999999999999999' })

    await expect(h.coordinator.send(h.input)).rejects.toMatchObject({ code: 4200 })
    expect(h.calls.quotes).toHaveLength(0)
    expect(h.calls.approvals).toHaveLength(0)
    expect(h.calls.preparedCalls).toHaveLength(0)
  })

  test('cancels prepared execution when the user rejects the single approval', async () => {
    const h = createHarness({ approved: false })

    await expect(h.coordinator.send(h.input)).rejects.toMatchObject({ code: 4001 })
    expect(h.calls.cancelled).toContain('rhea-quote:dapp-private')
    expect(h.calls.discarded).toEqual(['rhea-quote:dapp-private'])
  })

  test('resumes a submitted request after timeout without quoting or debiting again', async () => {
    const h = createHarness()
    h.calls.status = 'processing'

    await expect(h.coordinator.send(h.input)).rejects.toMatchObject({ code: -32000 })
    expect(h.calls.quotes).toHaveLength(1)
    expect(h.calls.confirmed).toHaveLength(1)
    expect(h.storeValues.size).toBe(1)

    h.calls.status = 'completed'
    await expect(h.coordinator.send(h.input)).resolves.toBe(DESTINATION_HASH)
    expect(h.calls.quotes).toHaveLength(1)
    expect(h.calls.confirmed).toHaveLength(1)
  })

  test('reports only observed terminal private failures without waiting for analytics', async () => {
    const events = []
    const analytics = (name, options) => {
      events.push({ name, options })
      return new Promise(() => {})
    }
    const pending = createHarness({ analytics })
    pending.calls.status = 'processing'
    await expect(pending.coordinator.send(pending.input)).rejects.toMatchObject({ code: -32000 })
    const rejected = createHarness({ analytics, approved: false })
    await expect(rejected.coordinator.send(rejected.input)).rejects.toMatchObject({ code: 4001 })
    expect(events).toEqual([])
    for (const status of ['failed', 'refunded', 'expired']) {
      const h = createHarness({ analytics })
      h.calls.status = status
      await expect(h.coordinator.send(h.input)).rejects.toThrow(status)
    }
    expect(events.map(event => event.name)).toEqual(Array(3).fill('dapp_transaction_failed'))
    expect(events[0].options).toMatchObject({ chain: 'evm', extra: { funding_source: 'private' } })
    expect(JSON.stringify(events)).not.toMatch(
      /private.example|1111111111111111111111111111111111111111|1000/
    )
  })

  test('retains the request fingerprint after an ambiguous signing response', async () => {
    const h = createHarness()
    h.calls.confirmError = new Error('Provider response was lost')

    await expect(h.coordinator.send(h.input)).rejects.toThrow('response was lost')
    expect(h.storeValues.size).toBe(1)
    expect(h.calls.discarded).toHaveLength(0)

    h.calls.confirmError = null
    await expect(h.coordinator.send(h.input)).resolves.toBe(DESTINATION_HASH)
    expect(h.calls.quotes).toHaveLength(1)
    expect(h.calls.confirmed).toHaveLength(1)
  })
})
