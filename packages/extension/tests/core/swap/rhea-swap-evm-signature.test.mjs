import { test } from 'node:test'
import { expect } from '@playwright/test'
import { privateKeyToAccount } from 'viem/accounts'

import { RheaSwapEvmSignatureCoordinator } from '../../../src/background/rhea-swap-evm-signature.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'

const sender = '0x1111111111111111111111111111111111111111'
const privateSender = '0x2222222222222222222222222222222222222222'
const fingerprint = 'a'.repeat(64)
const ledgerAccount = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const wrongLedgerAccount = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const ledgerPublicKey = `0x04${'12'.repeat(64)}`

function ledgerTypedData(signingAddress = ledgerAccount.address) {
  return {
    domain: { name: 'RHEA', version: '1', chainId: 1, verifyingContract: signingAddress },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      Order: [
        { name: 'maker', type: 'address' },
        { name: 'amount', type: 'uint256' }
      ]
    },
    primaryType: 'Order',
    message: { maker: signingAddress, amount: '1000' }
  }
}

function binding(signingAddress = sender) {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:signature-one',
    executionId: 'execution-one',
    router: 'one-inch',
    sourceTarget: signingAddress,
    sender: signingAddress,
    originAmountRaw: '1000',
    expiresAt: 5_000,
    isCrossChain: true,
    origin: {
      chainId: 'eip155:1',
      assetId: 'eip155:1/slip44:60',
      protocolChainId: '1',
      protocolAssetId: 'native'
    },
    destination: {
      chainId: 'zcash:mainnet',
      assetId: 'zcash:mainnet/slip44:133',
      protocolChainId: 'zcash',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '900',
      minimumAmountRaw: '850'
    }
  }
}

function activeContext(signingAddress = sender, ledger = false) {
  return {
    generationId: 'generation-one',
    keyDomainSource: ledger ? { kind: 'hardware', vendor: 'ledger' } : { kind: 'mnemonic' },
    chainAccount: {
      id: 'chain-account-one',
      scope: {
        keyDomainId: 'wallet:one',
        accountId: 'account:one',
        chainId: 'eip155:1'
      },
      derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
      identity: { kind: 'account-identifier', value: signingAddress }
    }
  }
}

function createPendingStore() {
  const values = new Map()
  return {
    values,
    async get(handle) {
      return values.get(handle) ?? null
    },
    async list() {
      return [...values.values()]
    },
    async put(value) {
      values.set(value.quoteHandle, value)
    },
    async delete(handle) {
      values.delete(handle)
    }
  }
}

function createHarness(overrides = {}) {
  let now = 1_000
  const calls = []
  const preparedPayloads = []
  const pending = createPendingStore()
  const repository = new InMemoryTransactionRepository()
  const plan = {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    chainId: 1,
    sender: overrides.sender ?? sender,
    signingScheme: 'eip712',
    typedDataJson: overrides.typedDataJson ?? '{"domain":{},"message":{}}',
    approval: null
  }
  const submission = {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    router: 'one-inch',
    sourceHash: 'order-one',
    orderId: 'order-one',
    statusChainId: '1',
    reportStatus: 'pending'
  }
  const service = {
    async readEvmSignaturePlan() {
      calls.push('read-plan')
      return plan
    },
    async submitSignedOrder() {
      calls.push('submit-order')
      return submission
    },
    async reportSubmission() {
      calls.push('report')
      return submission
    },
    async discard() {
      calls.push('discard')
    },
    ...overrides.service
  }
  const signer = {
    async deriveGlobalPea() {
      calls.push('derive-pea')
      return { address: overrides.peaAddress ?? sender }
    },
    async prepare(_keyDomainId, payload) {
      calls.push('prepare-signature')
      preparedPayloads.push(payload)
      return {
        commandId: 'command-one',
        chainId: 'eip155:1',
        operation: 'message',
        summary: { schema: 'evm.typed-data.v1' },
        payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprint },
        execution: { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    async confirm() {
      calls.push('confirm-signature')
      return {
        kind: 'signature',
        signature: { encoding: 'hex', value: `0x${'ab'.repeat(65)}` },
        publicKey: 'public-key',
        address: overrides.signingAddress ?? sender
      }
    },
    async cancel() {
      calls.push('cancel-signature')
    },
    ...overrides.signer
  }
  let scheduleCount = 0
  let currentContext = activeContext(overrides.sender ?? sender, Boolean(overrides.ledger))
  const options = {
    service,
    signer,
    pending,
    repository,
    loadContext: async () => currentContext,
    ...(overrides.ledger
      ? {
          ledger: {
            resolveAccount: async context => {
              calls.push('resolve-ledger')
              return {
                address: context.chainAccount.identity.value,
                derivationPath: context.chainAccount.derivation.path,
                publicKey: ledgerPublicKey
              }
            },
            requestSignature: async (request, approval) => {
              calls.push('sign-ledger')
              await approval.validate()
              return {
                signatureHex: await ledgerAccount.signTypedData(request.typedData)
              }
            },
            ...overrides.ledger
          }
        }
      : {}),
    scheduleMonitoring: async () => {
      scheduleCount += 1
      calls.push('schedule')
      if (overrides.scheduleMonitoring) await overrides.scheduleMonitoring(scheduleCount)
    },
    now: () => now,
    createId: () => 'stable-one'
  }
  const coordinator = new RheaSwapEvmSignatureCoordinator(options)
  return {
    coordinator,
    options,
    plan,
    calls,
    preparedPayloads,
    pending,
    repository,
    setNow(value) {
      now = value
    },
    setContext(value) {
      currentContext = value
    }
  }
}

test('prepares and confirms an account-bound EIP-712 Swap order', async () => {
  const harness = createHarness()
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())

  expect(review).toMatchObject({
    quoteHandle: binding().quoteHandle,
    chainId: 'eip155:1',
    sender,
    payloadFingerprint: fingerprint
  })

  const result = await harness.coordinator.confirm(binding().quoteHandle, fingerprint)
  expect(result.submission.orderId).toBe('order-one')
  expect(result.graph.root.id).toBe('tx:rhea-order:stable-one')
  expect(result.graph.segments[0]).toMatchObject({
    role: 'origin',
    evidence: { externalReference: 'order-one' }
  })
  expect(harness.calls).toEqual([
    'read-plan',
    'prepare-signature',
    'read-plan',
    'confirm-signature',
    'submit-order',
    'schedule',
    'report'
  ])
  expect(harness.pending.values.size).toBe(0)
})

test('derives and signs an EIP-712 Swap order with the Private Execution Account', async () => {
  const harness = createHarness({
    sender: privateSender,
    peaAddress: privateSender,
    signingAddress: privateSender
  })
  const privateBinding = binding(privateSender)

  const review = await harness.coordinator.prepare(
    privateBinding.quoteHandle,
    privateBinding,
    'private'
  )

  expect(review.sender).toBe(privateSender)
  expect(harness.preparedPayloads).toEqual([
    expect.objectContaining({ kind: 'pea-evm-typed-data', addressIndex: 0 })
  ])
  expect(harness.pending.values.get(privateBinding.quoteHandle)).toMatchObject({
    executionMode: 'private',
    sender: privateSender
  })

  await harness.coordinator.confirm(privateBinding.quoteHandle, fingerprint)
  expect(harness.calls.filter(call => call === 'derive-pea')).toHaveLength(2)
  expect(harness.pending.values.size).toBe(0)
})

test('retains the signed command and reuses the same graph after an interrupted submit path', async () => {
  let submitCount = 0
  const harness = createHarness({
    service: {
      async submitSignedOrder() {
        harness.calls.push('submit-order')
        submitCount += 1
        if (submitCount === 1) throw new Error('network unavailable')
        return {
          quoteHandle: binding().quoteHandle,
          executionId: binding().executionId,
          router: 'one-inch',
          sourceHash: 'order-one',
          orderId: 'order-one',
          statusChainId: '1',
          reportStatus: 'pending'
        }
      }
    }
  })
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(harness.coordinator.confirm(binding().quoteHandle, fingerprint)).rejects.toThrow(
    'network unavailable'
  )

  harness.setNow(6_000)
  const recovered = await harness.coordinator.confirm(binding().quoteHandle, fingerprint)
  expect(recovered.graph.root.id).toBe('tx:rhea-order:stable-one')
  expect(harness.calls.filter(call => call === 'confirm-signature')).toHaveLength(1)
  expect(harness.calls.filter(call => call === 'read-plan')).toHaveLength(2)
})

test('uses stable graph timestamps when monitor scheduling is retried', async () => {
  const harness = createHarness({
    async scheduleMonitoring(attempt) {
      if (attempt === 1) throw new Error('alarm unavailable')
    }
  })
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(harness.coordinator.confirm(binding().quoteHandle, fingerprint)).rejects.toThrow(
    'alarm unavailable'
  )

  harness.setNow(2_000)
  const recovered = await harness.coordinator.confirm(binding().quoteHandle, fingerprint)
  expect(recovered.graph.root.createdAt).toBe(1_000)
  expect(harness.calls.filter(call => call === 'confirm-signature')).toHaveLength(1)
})

test('cancels an unsigned command without submitting an order', async () => {
  const harness = createHarness()
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  await harness.coordinator.cancel(binding().quoteHandle)

  expect(harness.calls).toEqual(['read-plan', 'prepare-signature', 'cancel-signature', 'discard'])
  expect(harness.pending.values.size).toBe(0)
})

test('keeps a signed command recoverable when cancellation races with navigation', async () => {
  const harness = createHarness({
    service: {
      async submitSignedOrder() {
        harness.calls.push('submit-order')
        throw new Error('network unavailable')
      }
    }
  })
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(harness.coordinator.confirm(binding().quoteHandle, fingerprint)).rejects.toThrow(
    'network unavailable'
  )

  await harness.coordinator.cancel(binding().quoteHandle)
  expect(harness.pending.values.size).toBe(1)
  expect(harness.calls).not.toContain('cancel-signature')
  expect(harness.calls).not.toContain('discard')
})

test('Ledger EIP-712 Swap approval resumes with the original expiry and submits an account-bound signature', async () => {
  const typedData = ledgerTypedData()
  const harness = createHarness({
    sender: ledgerAccount.address,
    typedDataJson: JSON.stringify(typedData),
    ledger: {}
  })
  const quote = binding(ledgerAccount.address)
  const review = await harness.coordinator.prepare(quote.quoteHandle, quote)
  expect(review.summary.schema).toBe('evm.typed-data.v1')
  expect(review.expiresAt).toBe(quote.expiresAt)
  expect(harness.pending.values.get(quote.quoteHandle).ledger).toMatchObject({
    generationId: 'generation-one',
    derivationPath: "m/44'/60'/0'/0/0",
    publicKey: ledgerPublicKey
  })

  const restarted = new RheaSwapEvmSignatureCoordinator(harness.options)
  harness.setNow(2_000)
  await expect(restarted.prepare(quote.quoteHandle, quote)).rejects.toThrow('already pending')
  expect(harness.pending.values.get(quote.quoteHandle).expiresAt).toBe(review.expiresAt)
  const result = await restarted.confirm(quote.quoteHandle, review.payloadFingerprint)
  expect(result.submission.orderId).toBe('order-one')
  expect(harness.calls.filter(call => call === 'sign-ledger')).toHaveLength(1)
  expect(harness.calls).not.toContain('prepare-signature')
  expect(harness.pending.values.size).toBe(0)
})

test('Ledger Swap rejects a changed typed payload or account generation before signing', async () => {
  const quote = binding(ledgerAccount.address)
  const harness = createHarness({
    sender: ledgerAccount.address,
    typedDataJson: JSON.stringify(ledgerTypedData()),
    ledger: {}
  })
  const review = await harness.coordinator.prepare(quote.quoteHandle, quote)
  harness.plan.typedDataJson = JSON.stringify({
    ...ledgerTypedData(),
    message: {
      maker: ledgerAccount.address,
      amount: '2000'
    }
  })
  await expect(
    harness.coordinator.confirm(quote.quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow('order changed')
  expect(harness.calls).not.toContain('sign-ledger')

  harness.plan.typedDataJson = JSON.stringify(ledgerTypedData())
  harness.setContext({
    ...activeContext(ledgerAccount.address, true),
    generationId: 'generation-two'
  })
  await expect(
    harness.coordinator.confirm(quote.quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow('Account changed')
  expect(harness.calls).not.toContain('submit-order')
})

test('Ledger Swap rejects the wrong signer and concurrent confirmation', async () => {
  let release
  let started
  const startedPromise = new Promise(resolve => {
    started = resolve
  })
  const barrier = new Promise(resolve => {
    release = resolve
  })
  const quote = binding(ledgerAccount.address)
  const harness = createHarness({
    sender: ledgerAccount.address,
    typedDataJson: JSON.stringify(ledgerTypedData()),
    ledger: {
      async requestSignature(request, approval) {
        started()
        await barrier
        await approval.validate()
        return { signatureHex: await wrongLedgerAccount.signTypedData(request.typedData) }
      }
    }
  })
  const review = await harness.coordinator.prepare(quote.quoteHandle, quote)
  const first = harness.coordinator.confirm(quote.quoteHandle, review.payloadFingerprint)
  await startedPromise
  await expect(
    harness.coordinator.confirm(quote.quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow('already confirming')
  release()
  await expect(first).rejects.toThrow('does not match the approved order')
  expect(harness.calls).not.toContain('submit-order')
})

test('Ledger Swap rechecks the quote after device signing and retries a persisted signature after expiry', async () => {
  const quote = binding(ledgerAccount.address)
  let changeAfterDevice = true
  let submissionCount = 0
  const planReads = []
  const harness = createHarness({
    sender: ledgerAccount.address,
    typedDataJson: JSON.stringify(ledgerTypedData()),
    ledger: {
      async requestSignature(request, approval) {
        await approval.validate()
        const signatureHex = await ledgerAccount.signTypedData(request.typedData)
        if (changeAfterDevice)
          harness.plan.typedDataJson = JSON.stringify({
            ...ledgerTypedData(),
            message: { maker: ledgerAccount.address, amount: '2000' }
          })
        return { signatureHex }
      }
    },
    service: {
      async readEvmSignaturePlan(_handle, allowExpired = false) {
        planReads.push(allowExpired)
        if (harness.expired && !allowExpired) throw new Error('quote expired')
        return harness.plan
      },
      async submitSignedOrder() {
        submissionCount += 1
        if (submissionCount === 1) throw new Error('network unavailable')
        return {
          quoteHandle: quote.quoteHandle,
          executionId: quote.executionId,
          router: 'one-inch',
          sourceHash: 'order-one',
          orderId: 'order-one',
          statusChainId: '1',
          reportStatus: 'pending'
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(quote.quoteHandle, quote)
  await expect(
    harness.coordinator.confirm(quote.quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow('order changed')
  expect(submissionCount).toBe(0)

  harness.plan.typedDataJson = JSON.stringify(ledgerTypedData())
  changeAfterDevice = false
  await expect(
    harness.coordinator.confirm(quote.quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow('network unavailable')
  expect(harness.pending.values.get(quote.quoteHandle).signature).toMatch(/^0x[0-9a-f]{130}$/)
  harness.expired = true
  harness.setNow(review.expiresAt + 1)
  const restarted = new RheaSwapEvmSignatureCoordinator(harness.options)
  const result = await restarted.confirm(quote.quoteHandle, review.payloadFingerprint)
  expect(result.submission.orderId).toBe('order-one')
  expect(planReads.at(-1)).toBe(true)
  expect(submissionCount).toBe(2)
})

test('Ledger Swap rejects unsupported personal schemes and expires restored unsigned approvals', async () => {
  const quote = binding(ledgerAccount.address)
  const harness = createHarness({
    sender: ledgerAccount.address,
    typedDataJson: JSON.stringify(ledgerTypedData()),
    ledger: {}
  })
  harness.plan.signingScheme = 'personal_sign'
  await expect(harness.coordinator.prepare(quote.quoteHandle, quote)).rejects.toThrow(
    'scheme is unsupported'
  )
  harness.plan.signingScheme = 'eip712'
  const review = await harness.coordinator.prepare(quote.quoteHandle, quote)
  harness.setNow(review.expiresAt)
  const restarted = new RheaSwapEvmSignatureCoordinator(harness.options)
  await expect(restarted.confirm(quote.quoteHandle, review.payloadFingerprint)).rejects.toThrow(
    'unavailable or expired'
  )
  expect(harness.calls).not.toContain('sign-ledger')
})
