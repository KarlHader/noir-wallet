import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BUILTIN_EVM_NETWORKS, EVM_NETWORKS } from '../../../src/config/networks.ts'
import {
  ChromeEvmDAppPrivateTransferStore,
  EvmDAppPrivateTransferCoordinator
} from '../../../src/background/evm-dapp-private-transfer.ts'

const PEA = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const DESTINATION_HASH = `0x${'ab'.repeat(32)}`
const SOURCE_HASH = `0x${'cd'.repeat(32)}`

function createHarness({
  executionKind = 'evm-signature',
  approved = true,
  network = EVM_NETWORKS.mainnet,
  tokenContract,
  analytics,
  store,
  exactOutputApi,
  exactOutputStore,
  pendingSourceStore
} = {}) {
  const calls = {
    approvals: [],
    cancelled: [],
    confirmed: [],
    discarded: [],
    events: [],
    preparedCalls: [],
    quotes: [],
    quoteScopes: [],
    recorded: [],
    reports: 0,
    exactPrepared: 0,
    exactSubmitted: 0,
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
  const exactValues = new Map()
  let now = 1_000
  calls.advanceTime = milliseconds => {
    now += milliseconds
  }
  const service = {
    async listTokens() {
      return { tokens }
    },
    async quote(request, _signal, scope) {
      calls.quotes.push(request)
      calls.quoteScopes.push(scope)
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
    async hasRecordedOrder() {
      return calls.recordedOrderAvailable !== false
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
      async prepare(intent, binding, _fee, _mode, account) {
        calls.exactPrepared += 1
        calls.exactIntent = intent
        calls.exactBinding = binding
        calls.exactAccount = account
        return {
          graph: {
            root: {
              id: 'transaction:evm:exact',
              intent: { feeLimit: { amountRaw: '21000' } }
            }
          },
          review: {
            expiresAt: now + 30_000,
            payloadFingerprint: { digestHex: '44'.repeat(32) }
          }
        }
      },
      async prepareContractCall(intent, _feeTier, binding, account) {
        calls.events.push(binding ? 'prepare-route' : 'prepare-approval')
        if (binding && calls.prepareRouteError) throw calls.prepareRouteError
        calls.preparedCalls.push({ intent, binding, account })
        return prepared(`transaction:${calls.preparedCalls.length}`)
      },
      async approveForDApp(transactionId, _fingerprint, authorize) {
        calls.events.push(`approve:${transactionId}`)
        if (calls.approveError) throw calls.approveError
        await authorize()
        if (transactionId === 'transaction:evm:exact') calls.exactSubmitted += 1
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
    store: store ?? {
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
    ...(exactOutputApi ? { exactOutputApi } : {}),
    exactOutputStore: exactOutputStore ?? {
      async get(fingerprint) {
        return structuredClone(exactValues.get(fingerprint) ?? null)
      },
      async put(value) {
        exactValues.set(value.fingerprint, structuredClone(value))
      },
      async delete(fingerprint) {
        exactValues.delete(fingerprint)
      }
    },
    pendingSourceStore: pendingSourceStore ?? {
      async get() {
        return null
      },
      async getReviewGraph() {
        return null
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

function createExactHarness({
  status = 'SUCCESS',
  output = '1000',
  storeValues = new Map(),
  pendingSourceStore
} = {}) {
  const calls = { quotes: [], statusReads: 0 }
  const exactOutputApi = {
    async quoteExactOutput(input) {
      calls.quotes.push(input)
      return {
        expiresAt: Date.now() + 60_000,
        quote: {
          amountIn: '1020',
          amountOut: output,
          minAmountOut: output,
          depositAddress: '0x4444444444444444444444444444444444444444',
          deadline: new Date(Date.now() + 60_000).toISOString()
        },
        minimumInputRaw: '1010'
      }
    },
    async getOneClickStatus() {
      calls.statusReads += 1
      return {
        status: calls.status ?? status,
        settledAmountOutRaw: calls.settledAmountOutRaw ?? '1000',
        transactionHash: DESTINATION_HASH
      }
    },
    async getStatus() {
      return { transactionHash: DESTINATION_HASH }
    }
  }
  const exactOutputStore = {
    async get(fingerprint) {
      return structuredClone(storeValues.get(fingerprint) ?? null)
    },
    async put(value) {
      storeValues.set(value.fingerprint, structuredClone(value))
    },
    async delete(fingerprint) {
      storeValues.delete(fingerprint)
    }
  }
  return {
    ...createHarness({ exactOutputApi, exactOutputStore, pendingSourceStore }),
    exactCalls: calls,
    exactStoreValues: storeValues
  }
}

test.describe('EVM dApp Private transfer coordinator', () => {
  test('reviews gross sender debit and returns a destination hash only after exact settlement', async () => {
    const h = createExactHarness()
    const prepared = await h.coordinator.prepareExactOutput(h.input)
    expect(prepared.approvalData).toMatchObject({
      amountRaw: '1020',
      estimatedOutputRaw: '1000',
      minimumOutputRaw: '1000',
      networkFeeRaw: '21000',
      approvalRequired: false,
      exactOutput: true
    })
    expect(h.calls.exactIntent).toMatchObject({
      amountRaw: '1020',
      recipient: '0x4444444444444444444444444444444444444444'
    })
    expect(h.calls.exactBinding).toMatchObject({
      userAction: 'transfer',
      refundAddress: PEA,
      destination: { recipient: RECIPIENT, minimumAmountRaw: '1000' }
    })
    expect(h.calls.exactAccount).toMatchObject({ kind: 'pea', address: PEA })
    await expect(prepared.execute()).resolves.toBe(DESTINATION_HASH)
    expect(h.calls.exactSubmitted).toBe(1)
    await expect(h.coordinator.resumePending(h.input)).resolves.toBeNull()
    const nextPayment = await h.coordinator.prepareExactOutput(h.input)
    expect(h.exactCalls.quotes).toHaveLength(2)
    await expect(nextPayment.execute()).resolves.toBe(DESTINATION_HASH)
    expect(h.calls.exactSubmitted).toBe(2)
  })

  test('a completed legacy Private payment does not intercept the next direct or exact-output request', async () => {
    const h = createExactHarness()
    await expect(h.coordinator.send(h.input)).resolves.toBe(DESTINATION_HASH)
    expect(h.storeValues.size).toBe(1)

    const nextPayment = await h.coordinator.prepareExactOutput(h.input)
    expect(h.storeValues.size).toBe(0)
    expect(h.exactCalls.quotes).toHaveLength(1)
    await nextPayment.cancel()
    await expect(h.coordinator.resumePending(h.input)).resolves.toBeNull()
  })

  test('rejects a changed destination amount before preparing or signing', async () => {
    const h = createExactHarness({ output: '999' })
    await expect(h.coordinator.prepareExactOutput(h.input)).rejects.toThrow(/exceeds|match/)
    expect(h.calls.exactPrepared).toBe(0)
    expect(h.calls.exactSubmitted).toBe(0)
  })

  test('cancellation rejects the prepared source and never broadcasts', async () => {
    const h = createExactHarness()
    const prepared = await h.coordinator.prepareExactOutput(h.input)
    await prepared.cancel()
    await expect(prepared.execute()).rejects.toMatchObject({ code: 4001 })
    expect(h.calls.cancelled).toContain('transaction:evm:exact')
    expect(h.calls.exactSubmitted).toBe(0)
    expect(h.exactStoreValues.size).toBe(0)
  })

  test('an expired review cannot debit the Private account', async () => {
    const h = createExactHarness()
    const prepared = await h.coordinator.prepareExactOutput(h.input)
    h.calls.advanceTime(30_000)
    await expect(prepared.execute()).rejects.toThrow(/expired/)
    expect(h.calls.exactSubmitted).toBe(0)
    expect(h.exactStoreValues.size).toBe(0)
  })

  test('cancellation during the identity check prevents source submission', async () => {
    const h = createExactHarness()
    const original = h.input.ensureIdentity
    let checks = 0
    let release
    const held = new Promise(resolve => {
      release = resolve
    })
    const input = {
      ...h.input,
      ensureIdentity: async () => {
        checks += 1
        if (checks === 3) await held
        await original()
      }
    }
    const prepared = await h.coordinator.prepareExactOutput(input)
    const execution = prepared.execute()
    await Promise.resolve()
    await prepared.cancel()
    release()
    await expect(execution).rejects.toMatchObject({ code: 4001 })
    expect(h.calls.exactSubmitted).toBe(0)
    expect(h.exactStoreValues.size).toBe(0)
  })

  test('an ambiguous source submission resumes status without another debit', async () => {
    const h = createExactHarness({ status: 'PENDING_DEPOSIT' })
    const prepared = await h.coordinator.prepareExactOutput(h.input)
    await expect(prepared.execute()).rejects.toMatchObject({ code: -32000 })
    expect(h.calls.exactSubmitted).toBe(1)
    expect(h.exactStoreValues.size).toBe(1)
    h.exactCalls.status = 'SUCCESS'
    await expect(h.coordinator.resumePending(h.input)).resolves.toBe(DESTINATION_HASH)
    expect(h.calls.exactSubmitted).toBe(1)
    expect(h.exactCalls.quotes).toHaveLength(1)
  })

  test('releases an exact-output marker only when the source is proven unsigned', async () => {
    const pendingSourceStore = {
      async get() {
        return {
          phase: 'awaiting-approval',
          scope: { keyDomainId: 'wallet:one', accountId: 'account:one' }
        }
      },
      async getReviewGraph() {
        return {
          root: { id: 'transaction:evm:exact', status: 'prepared' },
          segments: [{ role: 'origin', evidence: {} }]
        }
      }
    }
    const h = createExactHarness({ pendingSourceStore })
    const prepared = await h.coordinator.prepareExactOutput(h.input)
    h.calls.approveError = new Error('Pre-sign approval failed')
    await expect(prepared.execute()).rejects.toThrow('Pre-sign approval failed')
    expect(h.calls.exactSubmitted).toBe(0)
    expect(h.calls.cancelled).toContain('transaction:evm:exact')
    expect(h.exactStoreValues.size).toBe(0)
    await expect(h.coordinator.resumePending(h.input)).resolves.toBeNull()
  })

  test('does not return a hash for a successful status with an unverified amount', async () => {
    const h = createExactHarness()
    h.exactCalls.settledAmountOutRaw = '999'
    const prepared = await h.coordinator.prepareExactOutput(h.input)
    await expect(prepared.execute()).rejects.toThrow(/amount could not be verified/)
    expect(h.exactStoreValues.size).toBe(1)
    expect(h.calls.exactSubmitted).toBe(1)
  })

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
    expect(h.calls.quoteScopes).toEqual([
      {
        walletId: h.input.account.keyDomainId,
        accountId: h.input.account.accountId,
        purpose: 'private-dapp-transfer'
      }
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

  test('releases a request when token approval or route preparation failed before submission', async () => {
    const h = createHarness({
      executionKind: 'evm-transaction',
      tokenContract: '0x3333333333333333333333333333333333333333'
    })
    h.calls.approveError = new Error('Approval declined')
    await expect(h.coordinator.send(h.input)).rejects.toThrow('Approval declined')
    expect(h.storeValues.size).toBe(0)
    h.calls.approveError = null
    h.calls.prepareRouteError = new Error('Route preparation failed')
    await expect(h.coordinator.send(h.input)).rejects.toThrow('Route preparation failed')
    expect(h.storeValues.size).toBe(0)
    h.calls.prepareRouteError = null
    await expect(h.coordinator.send(h.input)).resolves.toBe(DESTINATION_HASH)
    expect(h.calls.quotes).toHaveLength(3)
    expect(h.calls.recorded).toHaveLength(1)
  })

  test('keeps a pending request across worker restarts and the old session deadline', async () => {
    const originalChrome = globalThis.chrome
    const local = new Map()
    const session = new Map()
    const area = values => ({
      get: async key => (key === null ? Object.fromEntries(values) : { [key]: values.get(key) }),
      set: async entries => {
        for (const [key, value] of Object.entries(entries)) values.set(key, value)
      },
      remove: async keys => {
        for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
      }
    })
    globalThis.chrome = { storage: { local: area(local), session: area(session) } }
    try {
      const first = createHarness({ store: new ChromeEvmDAppPrivateTransferStore() })
      first.calls.status = 'processing'
      await expect(first.coordinator.send(first.input)).rejects.toMatchObject({ code: -32000 })
      expect(local.size).toBe(1)
      expect(session.size).toBe(0)

      const resumed = createHarness({ store: new ChromeEvmDAppPrivateTransferStore() })
      resumed.calls.status = 'completed'
      await expect(resumed.coordinator.resumePending(resumed.input)).resolves.toBe(DESTINATION_HASH)
      expect(resumed.calls.quotes).toHaveLength(0)
      expect(resumed.calls.confirmed).toHaveLength(0)
      expect(resumed.calls.statusReads).toBeGreaterThan(0)

      await new ChromeEvmDAppPrivateTransferStore().clearForAccount(
        first.input.account.keyDomainId,
        first.input.account.accountId
      )
      expect(local.size).toBe(0)
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  test('reports an unverified previous submission promptly without starting another payment', async () => {
    const h = createHarness()
    h.calls.status = 'processing'
    await expect(h.coordinator.send(h.input)).rejects.toMatchObject({ code: -32000 })
    h.calls.recordedOrderAvailable = false
    await expect(h.coordinator.send(h.input)).rejects.toThrow(/status is unknown/)
    expect(h.calls.quotes).toHaveLength(1)
    expect(h.calls.confirmed).toHaveLength(1)
    expect(h.storeValues.size).toBe(1)
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
