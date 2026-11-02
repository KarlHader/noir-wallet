import { test } from 'node:test'
import { expect } from '@playwright/test'
import { Buffer } from 'buffer'
import { encodeFunctionData, parseAbi, parseTransaction } from 'viem'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions,
  parseChainId
} from '../../../../src/core/chains/registry/index.ts'
import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import { parseTransactionId } from '../../../../src/core/transactions/domain/index.ts'
import {
  ChromeSessionEvmPendingTransferStore,
  computeEvmSigningPayloadFingerprint,
  EvmTransferOrchestrator,
  assertEvmTransferFresh,
  parsePendingEvmTransfer
} from '../../../../src/infrastructure/chains/evm/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'
import { reportBackgroundSendBroadcast } from '../../../../src/background/analytics/send-broadcast.ts'

const chainId = parseChainId('eip155:1').id
const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledEvmAssetDefinitions('mainnet'))
const customToken = '0x3333333333333333333333333333333333333333'
const customAssets = createAssetRegistry(chains, [
  ...getBundledEvmAssetDefinitions('mainnet'),
  {
    chainId,
    namespace: 'erc20',
    reference: customToken,
    kind: 'token',
    metadata: { name: 'Example Token', symbol: 'USDC', decimals: 18 },
    source: 'user-added',
    verification: 'user-approved'
  }
])
const from = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1'
const recipient = '0x2222222222222222222222222222222222222222'
const rawTransaction =
  '0x02f86b0107843b9aca0085012a05f2008252089422222222222222222222222222222222222222227b80c080a0b3864790b628687b4183843c86fe33325a02749ef708c28741fda66071423046a05d8f511cd36527e24f1f5e2ebfd42cfed9b0d3c4fdfd772e3bac5d9b40bf441b'
const transactionHash = '0xaab6356f54167f2353969e09cccd67316f939a3a118923245b6a015c8b9a701e'
const scope = { keyDomainId: 'key-domain:evm', accountId: 'account:evm:0' }
const account = {
  id: 'chain-account:evm:0',
  scope: { ...scope, chainId },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
  identity: { kind: 'account-identifier', value: from },
  createdAt: 1
}

function sessionStore(options = {}) {
  const values = new Map()
  let setCalls = 0
  let failRemove = options.failRemove === true
  return {
    values,
    setFailRemove: value => {
      failRemove = value
    },
    area: {
      get: async key => {
        if (key === null) {
          return Object.fromEntries(
            [...values.entries()].map(([entryKey, value]) => [entryKey, structuredClone(value)])
          )
        }
        return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}
      },
      set: async entries => {
        setCalls += 1
        if (setCalls === options.failSetCall) throw new Error('session persistence unavailable')
        for (const [key, value] of Object.entries(entries)) {
          values.set(key, structuredClone(value))
        }
      },
      remove: async key => {
        if (failRemove) throw new Error('session cleanup unavailable')
        for (const entryKey of Array.isArray(key) ? key : [key]) values.delete(entryKey)
      }
    }
  }
}

function rpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getNativeBalance: async () => '1000000000000000000000',
    getPendingNonce: async () => '7',
    simulateCall: async () => '0x',
    estimateGas: async () => '21000',
    getMaximumPriorityFeePerGas: async () => '1000000000',
    getLatestBlockFee: async () => ({
      blockNumber: '100',
      baseFeePerGas: '2000000000'
    }),
    broadcastRawTransaction: async () => transactionHash,
    hasTransaction: async () => true,
    getTransactionReceipt: async () => null,
    getFinalizedBlockNumber: async () => '100',
    ...overrides
  }
}

function signer(calls, options = {}) {
  const commandId = parseSigningCommandId('signing-command:evm:transfer')
  return {
    prepare: async (keyDomainId, payload) => {
      calls.push(['prepare', keyDomainId, payload])
      const fingerprint = await computeEvmSigningPayloadFingerprint(payload.transaction)
      const calldataBytes = Uint8Array.from(
        payload.transaction.input
          .slice(2)
          .match(/.{2}/g)
          ?.map(byte => Number.parseInt(byte, 16)) ?? []
      )
      const calldataSha256 = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', calldataBytes))
      ]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
      const hasCalldata = calldataBytes.length > 0
      return {
        commandId,
        chainId,
        operation: 'transaction',
        summary: {
          schema: 'evm.transaction.v1',
          chainId,
          operation: 'transaction',
          review: {
            level: hasCalldata ? 'caution' : 'standard',
            issues: hasCalldata ? [{ code: 'unrecognized-call' }] : []
          },
          fields: {
            transactionType: 'eip1559',
            from,
            to: payload.transaction.to,
            nonce: payload.transaction.nonce,
            valueWei: payload.transaction.value,
            gasLimit: payload.transaction.gasLimit,
            maximumFeeWei: (
              BigInt(payload.transaction.gasLimit) * BigInt(payload.transaction.maxFeePerGas)
            ).toString(),
            gasPriceWei: null,
            maxFeePerGasWei: payload.transaction.maxFeePerGas,
            maxPriorityFeePerGasWei: payload.transaction.maxPriorityFeePerGas,
            accessList: [],
            calldata: {
              encoding: 'hex',
              value: payload.transaction.input,
              byteLength: calldataBytes.length,
              sha256: calldataSha256
            },
            methodSelector: hasCalldata ? payload.transaction.input.slice(0, 10) : null
          }
        },
        payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprint },
        execution: { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    confirm: async (keyDomainId, requestedCommandId) => {
      calls.push(['confirm', keyDomainId, requestedCommandId])
      return {
        kind: 'signed-payload',
        payload: { encoding: 'hex', value: options.rawTransaction ?? rawTransaction },
        transactionId: options.transactionHash ?? transactionHash
      }
    },
    cancel: async (keyDomainId, requestedCommandId) => {
      calls.push(['cancel', keyDomainId, requestedCommandId])
    }
  }
}

function harness(options = {}) {
  const session = sessionStore(options.session)
  const pendingStore = new ChromeSessionEvmPendingTransferStore(session.area)
  const repository = new InMemoryTransactionRepository()
  const calls = []
  let id = 0
  const orchestrator = new EvmTransferOrchestrator({
    repository,
    pendingStore,
    signer: options.signer ?? signer(calls),
    rpc: options.rpc ?? rpc(),
    assets: options.assets ?? assets,
    now: () => 1_000,
    createId: () => `test-${++id}`,
    createExternalRequestId:
      options.createExternalRequestId ?? (() => '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'),
    onPendingBroadcast: options.onPendingBroadcast,
    onBroadcastAccepted: options.onBroadcastAccepted,
    onMonitoringRequired: options.onMonitoringRequired
  })
  return { orchestrator, repository, pendingStore, session, calls }
}

async function keystoneSignatureCborBase64(overrides = {}) {
  const { DataItem, extend } = await import('@keystonehq/bc-ur-registry')
  const decoded = parseTransaction(rawTransaction)
  if (decoded.r === undefined || decoded.s === undefined || decoded.yParity === undefined) {
    throw new Error('The fixed EVM transaction is missing its signature')
  }
  const requestId = (overrides.requestId ?? '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d').replaceAll(
    '-',
    ''
  )
  const signature = Buffer.from(
    `${decoded.r.slice(2)}${decoded.s.slice(2)}${decoded.yParity.toString(16).padStart(2, '0')}`,
    'hex'
  )
  const cbor = extend.encodeDataItem(
    new DataItem({
      1: new DataItem(Buffer.from(requestId, 'hex'), extend.RegistryTypes.UUID.getTag()),
      2: signature,
      3: 'Keystone'
    })
  )
  return Buffer.from(cbor).toString('base64')
}

async function prepare(orchestrator) {
  return orchestrator.prepare({
    chainAccount: account,
    intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' }
  })
}

function localBroadcastGraph(nonce, id = `transaction:evm:local-${nonce}`) {
  const segmentId = `segment:evm:local-${nonce}`
  const hash = `0x${BigInt(nonce + 1)
    .toString(16)
    .padStart(64, '0')}`
  return {
    root: {
      id,
      scope,
      kind: 'transfer',
      status: 'broadcast',
      segmentIds: [segmentId],
      createdAt: 500,
      updatedAt: 500,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'outgoing',
        sender: { chainId, address: from },
        recipient: { chainId, address: recipient },
        evm: {
          schemaVersion: 1,
          nonce: String(nonce),
          maxFeePerGasWei: '5000000000',
          maxPriorityFeePerGasWei: '1000000000',
          gasLimit: '21000'
        }
      }
    },
    segments: [
      {
        id: segmentId,
        transactionId: id,
        role: 'origin',
        target: { kind: 'onchain', chainId },
        status: 'broadcast',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { transactionHash: hash, externalReference: `evm-nonce:${nonce}` },
        createdAt: 500,
        updatedAt: 500,
        revision: 0
      }
    ]
  }
}

function nearIntentsBinding() {
  return {
    schemaVersion: 1,
    provider: 'near-intents',
    kind: 'swap',
    depositAddress: recipient,
    refundAddress: from,
    expiresAt: 4_000,
    origin: {
      chainId,
      assetId: 'eip155:1/slip44:60',
      protocolAssetId: 'nep141:eth.omft.near'
    },
    destination: {
      chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '100',
      minimumAmountRaw: '99'
    }
  }
}

function rheaSwapBinding() {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:evm',
    executionId: 'execution-evm',
    router: 'odos',
    sourceTarget: recipient,
    sender: from,
    originAmountRaw: '123',
    expiresAt: 4_000,
    isCrossChain: true,
    origin: {
      chainId,
      assetId: `eip155:1/erc20:${customToken}`,
      protocolChainId: '1',
      protocolAssetId: customToken
    },
    destination: {
      chainId: 'near:mainnet',
      assetId: 'near:mainnet/slip44:397',
      protocolChainId: 'near',
      protocolAssetId: 'wrap.near',
      recipient: 'alice.near',
      expectedAmountRaw: '100',
      minimumAmountRaw: '99'
    }
  }
}

test('upgrades legacy internal pending records without losing signing or broadcast recovery', async () => {
  const legacySigning = await signer([]).prepare('key-domain:evm', {
    transaction: {
      type: 'eip1559',
      chainId: '1',
      nonce: '7',
      maxFeePerGas: '5000000000',
      maxPriorityFeePerGas: '1000000000',
      gasLimit: '21000',
      to: recipient,
      value: '123',
      input: '0x',
      accessList: []
    }
  })
  const legacyAwaiting = {
    schemaVersion: 1,
    phase: 'awaiting-approval',
    transactionId: 'transaction:evm:legacy-awaiting',
    segmentId: 'segment:evm:legacy-awaiting',
    scope,
    prepared: {
      kind: 'native-transfer',
      chainId,
      addressIndex: 0,
      from,
      assetId: 'eip155:1/slip44:60',
      recipient,
      amountRaw: '123',
      observedBlockNumber: '100',
      transaction: {
        type: 'eip1559',
        chainId: '1',
        nonce: '7',
        maxFeePerGas: '5000000000',
        maxPriorityFeePerGas: '1000000000',
        gasLimit: '21000',
        to: recipient,
        value: '123',
        input: '0x',
        accessList: []
      },
      createdAt: 1_000
    },
    signingSummary: legacySigning.summary,
    signingCommandId: 'signing-command:evm:legacy',
    payloadFingerprint: 'a'.repeat(64),
    expiresAt: 5_000
  }
  expect(parsePendingEvmTransfer(legacyAwaiting)).toMatchObject({
    schemaVersion: 2,
    phase: 'awaiting-approval',
    signingExecution: { kind: 'internal' },
    externalSigner: null,
    signingCommandId: 'signing-command:evm:legacy'
  })
  const signed = parsePendingEvmTransfer({
    schemaVersion: 1,
    phase: 'signed',
    transactionId: 'transaction:evm:legacy-signed',
    segmentId: 'segment:evm:legacy-signed',
    scope,
    rawTransaction,
    transactionHash,
    signedAt: 1_000
  })
  expect(signed).toMatchObject({
    schemaVersion: 2,
    phase: 'signed',
    rawTransaction,
    transactionHash
  })
})

test('keeps the prepared review in session and persists only after signing', async () => {
  let monitoringSchedules = 0
  const { orchestrator, repository, pendingStore, calls } = harness({
    onMonitoringRequired: () => {
      monitoringSchedules += 1
    }
  })
  const prepared = await prepare(orchestrator)
  expect(prepared.graph.root.status).toBe('prepared')
  await expect(pendingStore.get(prepared.graph.root.id)).resolves.toMatchObject({
    phase: 'awaiting-approval',
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex,
    prepared: { transaction: { nonce: '7' } }
  })
  await expect(pendingStore.getReviewGraph(prepared.graph.root.id)).resolves.toEqual(prepared.graph)
  await expect(repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
  await expect(
    orchestrator.getPendingApproval({ scope, transactionId: prepared.graph.root.id })
  ).resolves.toEqual(prepared)

  const submitted = await orchestrator.approve({
    scope,
    transactionId: prepared.graph.root.id,
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
  })
  expect(submitted.status).toBe('broadcast')
  expect(submitted.graph).toMatchObject({
    root: { status: 'broadcast' },
    segments: [{ status: 'broadcast', evidence: { transactionHash } }]
  })
  await expect(pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
  await expect(repository.get(scope, prepared.graph.root.id)).resolves.toEqual(submitted.graph)
  expect(calls.map(call => call[0])).toEqual(['prepare', 'confirm'])
  expect(monitoringSchedules).toBe(1)
})

test('serializes approvals for the same sender through signing and broadcast', async () => {
  const calls = []
  const baseSigner = signer(calls)
  let activeConfirms = 0
  let maximumActiveConfirms = 0
  let releaseFirst
  const firstBlocked = new Promise(resolve => {
    releaseFirst = resolve
  })
  let confirmCount = 0
  const serializedSigner = {
    ...baseSigner,
    confirm: async (...args) => {
      confirmCount += 1
      activeConfirms += 1
      maximumActiveConfirms = Math.max(maximumActiveConfirms, activeConfirms)
      if (confirmCount === 1) await firstBlocked
      try {
        return await baseSigner.confirm(...args)
      } finally {
        activeConfirms -= 1
      }
    }
  }
  const { orchestrator } = harness({ signer: serializedSigner })
  const first = await prepare(orchestrator)
  const second = await prepare(orchestrator)
  const firstApproval = orchestrator.approve({
    scope,
    transactionId: first.graph.root.id,
    payloadFingerprint: first.signing.payloadFingerprint.digestHex
  })
  await expect.poll(() => activeConfirms).toBe(1)
  const secondApproval = orchestrator.approve({
    scope,
    transactionId: second.graph.root.id,
    payloadFingerprint: second.signing.payloadFingerprint.digestHex
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(activeConfirms).toBe(1)
  releaseFirst()
  const results = await Promise.allSettled([firstApproval, secondApproval])
  expect(results[0].status).toBe('fulfilled')
  expect(results[1]).toMatchObject({
    status: 'rejected',
    reason: expect.objectContaining({ message: expect.stringContaining('nonce') })
  })
  expect(maximumActiveConfirms).toBe(1)
})

test('persists a contract-call graph without a fake zero-value transfer amount', async () => {
  const { orchestrator, pendingStore, repository } = harness({
    rpc: rpc({ estimateGas: async () => '54321' })
  })
  const prepared = await orchestrator.prepare({
    chainAccount: account,
    intent: {
      chainId,
      contractAddress: recipient,
      valueRaw: '0',
      calldata: '0x12345678aabbccdd'
    }
  })

  expect(prepared.graph.root).toMatchObject({
    kind: 'contract-call',
    status: 'prepared',
    intent: {
      direction: 'contract',
      recipient: { chainId, address: recipient }
    }
  })
  expect(prepared.graph.root.intent.primaryAmount).toBeUndefined()
  await expect(
    orchestrator.getPendingApproval({ scope, transactionId: prepared.graph.root.id })
  ).resolves.toEqual(prepared)
  await expect(pendingStore.get(prepared.graph.root.id)).resolves.toMatchObject({
    prepared: {
      kind: 'contract-call',
      transaction: { input: '0x12345678aabbccdd' }
    }
  })
  await expect(
    orchestrator.reject({ scope, transactionId: prepared.graph.root.id })
  ).resolves.toMatchObject({ root: { kind: 'contract-call', status: 'failed' } })
  await expect(repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
})

test('approves an ERC-20 allowance review without rejecting its approve activity kind', async () => {
  const testHarness = harness()
  const calldata = `0x095ea7b3${recipient.slice(2).padStart(64, '0')}${'123'.padStart(64, '0')}`
  const prepared = await testHarness.orchestrator.prepare({
    chainAccount: account,
    intent: { chainId, contractAddress: customToken, valueRaw: '0', calldata },
    signingMode: 'keystone',
    externalSigner: {
      derivationPath: "m/44'/60'/0'/0/0",
      masterFingerprintHex: 'e9181cf3',
      address: from
    }
  })

  expect(prepared.graph.root).toMatchObject({ kind: 'approve', status: 'prepared' })
  await expect(
    testHarness.orchestrator.getPendingApproval({ scope, transactionId: prepared.graph.root.id })
  ).resolves.toMatchObject({ graph: { root: { kind: 'approve' } } })
  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).resolves.toMatchObject({
    status: 'external-signature-required',
    graph: { root: { kind: 'approve', status: 'approved' } }
  })
})

test('keeps a contract call generic through pending integrity checks', async () => {
  const testHarness = harness()
  const calldata = encodeFunctionData({
    abi: parseAbi([
      'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)'
    ]),
    functionName: 'supply',
    args: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 2_500_000n, from, 0]
  })
  const prepared = await testHarness.orchestrator.prepare({
    chainAccount: account,
    intent: {
      chainId,
      contractAddress: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
      valueRaw: '0',
      calldata
    }
  })

  expect(prepared.graph.root).toMatchObject({
    kind: 'contract-call',
    intent: {
      direction: 'contract'
    }
  })
  expect(prepared.graph.root.intent.primaryAmount).toBeUndefined()
  await expect(
    testHarness.orchestrator.getPendingApproval({ scope, transactionId: prepared.graph.root.id })
  ).resolves.toMatchObject({ graph: { root: { kind: 'contract-call' } } })
})

test('preserves a custom Token metadata snapshot through approval integrity checks', async () => {
  const testHarness = harness({
    assets: customAssets,
    rpc: rpc({
      simulateCall: async () => `0x${'0'.repeat(63)}1`,
      estimateGas: async () => '70000'
    })
  })
  const prepared = await testHarness.orchestrator.prepare({
    chainAccount: account,
    intent: {
      assetId: `${chainId}/erc20:${customToken}`,
      recipient,
      amountRaw: '500000000000000000'
    },
    signingMode: 'keystone',
    externalSigner: {
      derivationPath: "m/44'/60'/0'/0/0",
      masterFingerprintHex: 'e9181cf3',
      address: from
    }
  })

  expect(prepared.graph.root.intent.primaryAmount.metadata).toEqual({
    name: 'Example Token',
    symbol: 'USDC',
    decimals: 18
  })
  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).resolves.toMatchObject({ status: 'external-signature-required' })
})

test('hands an exact EIP-1559 request to Keystone and verifies its UUID-bound signature', async () => {
  const testHarness = harness()
  const prepared = await testHarness.orchestrator.prepare({
    chainAccount: account,
    intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' },
    signingMode: 'keystone',
    externalSigner: {
      derivationPath: "m/44'/60'/0'/0/0",
      masterFingerprintHex: 'e9181cf3',
      address: from
    }
  })
  expect(prepared.signing.execution).toMatchObject({
    kind: 'external',
    request: { encoding: 'base64' }
  })
  expect(testHarness.calls).toEqual([])

  const handoff = await testHarness.orchestrator.approve({
    scope,
    transactionId: prepared.graph.root.id,
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
  })
  expect(handoff).toMatchObject({
    status: 'external-signature-required',
    graph: { root: { status: 'approved' } },
    transactionId: prepared.graph.root.id
  })
  await expect(
    testHarness.orchestrator.getPendingApproval({ scope, transactionId: prepared.graph.root.id })
  ).resolves.toBeNull()
  await expect(
    testHarness.orchestrator.getExternalSigningRequest({
      scope,
      transactionId: prepared.graph.root.id
    })
  ).resolves.toEqual({
    transactionId: prepared.graph.root.id,
    scope,
    summary: prepared.signing.summary,
    request: prepared.signing.execution.request,
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex,
    expiresAt: prepared.signing.expiresAt
  })

  const submitted = await testHarness.orchestrator.submitExternalSignature({
    scope,
    transactionId: prepared.graph.root.id,
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex,
    signatureCborBase64: await keystoneSignatureCborBase64()
  })
  expect(submitted).toMatchObject({
    status: 'broadcast',
    graph: {
      root: { status: 'broadcast' },
      segments: [{ evidence: { transactionHash } }]
    }
  })
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
})

test('binds a Ledger EIP-1559 signature to the prepared transaction and sender', async () => {
  const testHarness = harness()
  const prepared = await testHarness.orchestrator.prepare({
    chainAccount: account,
    intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' },
    signingMode: 'ledger',
    externalSigner: { derivationPath: "m/44'/60'/0'/0/0", address: from }
  })
  await testHarness.orchestrator.approve({
    scope,
    transactionId: prepared.graph.root.id,
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
  })
  const external = await testHarness.orchestrator.getExternalSigningRequest({
    scope,
    transactionId: prepared.graph.root.id
  })
  expect(external).toMatchObject({
    vendor: 'ledger',
    scope,
    summary: prepared.signing.summary,
    ledgerRequest: {
      kind: 'transaction',
      derivationPath: "m/44'/60'/0'/0/0",
      expectedAddress: from,
      unsignedTransactionHex: expect.stringMatching(/^0x02/)
    }
  })
  await expect(
    testHarness.orchestrator.getPendingApproval({ scope, transactionId: prepared.graph.root.id })
  ).resolves.toBeNull()
  const decoded = parseTransaction(rawTransaction)
  const signatureHex = `${decoded.r}${decoded.s.slice(2)}${decoded.yParity.toString(16).padStart(2, '0')}`
  await expect(
    testHarness.orchestrator.submitExternalSignature({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex,
      signatureCborBase64: signatureHex
    })
  ).resolves.toMatchObject({ status: 'broadcast' })
})

test('fails the graph on a substituted Keystone EVM request ID', async () => {
  const testHarness = harness()
  const prepared = await testHarness.orchestrator.prepare({
    chainAccount: account,
    intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' },
    signingMode: 'keystone',
    externalSigner: {
      derivationPath: "m/44'/60'/0'/0/0",
      masterFingerprintHex: 'e9181cf3',
      address: from
    }
  })
  await testHarness.orchestrator.approve({
    scope,
    transactionId: prepared.graph.root.id,
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
  })

  await expect(
    testHarness.orchestrator.submitExternalSignature({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex,
      signatureCborBase64: await keystoneSignatureCborBase64({
        requestId: '7f938703-d54b-4c88-9f6d-e8a6f04f7e88'
      })
    })
  ).rejects.toThrow(/request ID does not match/)
  await expect(testHarness.repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
})

test('keeps the immutable Near Intents graph while broadcasting the EVM origin leg', async () => {
  const { orchestrator } = harness()
  const prepared = await orchestrator.prepare({
    chainAccount: account,
    intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' },
    nearIntentsBinding: nearIntentsBinding()
  })
  expect(prepared.graph).toMatchObject({
    root: {
      kind: 'swap',
      status: 'prepared',
      intent: { protocol: nearIntentsBinding() }
    },
    segments: [
      { role: 'origin', status: 'prepared' },
      { role: 'relay', status: 'created' },
      { role: 'destination', status: 'created' },
      { role: 'refund', status: 'created' }
    ]
  })

  const submitted = await orchestrator.approve({
    scope,
    transactionId: prepared.graph.root.id,
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
  })
  expect(submitted.graph).toMatchObject({
    root: { kind: 'swap', status: 'broadcast', intent: { protocol: nearIntentsBinding() } },
    segments: [
      { role: 'origin', status: 'broadcast', evidence: { transactionHash } },
      { role: 'relay', status: 'created' },
      { role: 'destination', status: 'created' },
      { role: 'refund', status: 'created' }
    ]
  })
})

test('binds a RHEA ERC-20 swap amount to its EVM contract-call review', async () => {
  const testHarness = harness({ assets: customAssets })
  const prepared = await testHarness.orchestrator.prepare({
    chainAccount: account,
    intent: {
      chainId,
      contractAddress: recipient,
      valueRaw: '0',
      calldata: '0x12345678'
    },
    rheaSwapBinding: rheaSwapBinding()
  })

  expect(prepared.graph).toMatchObject({
    root: {
      kind: 'swap',
      status: 'prepared',
      intent: {
        primaryAmount: {
          assetId: `eip155:1/erc20:${customToken}`,
          amountRaw: '123'
        },
        protocol: rheaSwapBinding()
      }
    },
    segments: [
      { role: 'origin', status: 'prepared' },
      { role: 'relay', status: 'created' },
      { role: 'destination', status: 'created' },
      { role: 'refund', status: 'created' }
    ]
  })

  await expect(
    testHarness.orchestrator.getPendingApproval({
      scope,
      transactionId: prepared.graph.root.id
    })
  ).resolves.toMatchObject({
    graph: {
      root: { kind: 'swap', status: 'prepared', intent: { protocol: rheaSwapBinding() } },
      segments: [
        { role: 'origin', status: 'prepared' },
        { role: 'relay', status: 'created' },
        { role: 'destination', status: 'created' },
        { role: 'refund', status: 'created' }
      ]
    },
    signing: { payloadFingerprint: prepared.signing.payloadFingerprint }
  })
})

test('cancels only awaiting approvals from the invalidated Account scope', async () => {
  const testHarness = harness()
  const first = await prepare(testHarness.orchestrator)
  const secondScope = { ...scope, accountId: 'account:evm:1' }
  const second = await testHarness.orchestrator.prepare({
    chainAccount: {
      ...account,
      id: 'chain-account:evm:1',
      scope: { ...account.scope, accountId: secondScope.accountId },
      derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/1" }
    },
    intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '456' }
  })
  testHarness.session.values.set('unrelated-session-state', { keep: true })

  await expect(testHarness.pendingStore.list()).resolves.toHaveLength(2)
  await expect(testHarness.orchestrator.cancelAwaitingApprovalsForScope(scope)).resolves.toBe(1)
  await expect(testHarness.pendingStore.get(first.graph.root.id)).resolves.toBeNull()
  await expect(testHarness.repository.get(scope, first.graph.root.id)).resolves.toBeNull()
  await expect(testHarness.pendingStore.get(second.graph.root.id)).resolves.toMatchObject({
    phase: 'awaiting-approval',
    scope: secondScope
  })
  expect(testHarness.session.values.get('unrelated-session-state')).toEqual({ keep: true })
  expect(testHarness.calls.map(call => call[0])).toEqual(['prepare', 'prepare', 'cancel'])
  await expect(testHarness.orchestrator.clearPendingTransfers()).resolves.toBe(1)
  await expect(testHarness.pendingStore.get(second.graph.root.id)).resolves.toBeNull()
  expect(testHarness.session.values.get('unrelated-session-state')).toEqual({ keep: true })
})

test('cancels stale Account approvals while retaining signed raw transaction recovery', async () => {
  const testHarness = harness({
    rpc: rpc({
      broadcastRawTransaction: async () => {
        throw new Error('network unavailable')
      },
      hasTransaction: async () => false
    })
  })
  const signed = await prepare(testHarness.orchestrator)
  const otherScope = { ...scope, accountId: 'account:evm:1' }
  const awaiting = await testHarness.orchestrator.prepare({
    chainAccount: {
      ...account,
      id: 'chain-account:evm:1',
      scope: { ...account.scope, accountId: otherScope.accountId },
      derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/1" }
    },
    intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '456' }
  })
  await testHarness.orchestrator.approve({
    scope,
    transactionId: signed.graph.root.id,
    payloadFingerprint: signed.signing.payloadFingerprint.digestHex
  })

  await expect(testHarness.orchestrator.cancelAwaitingApprovalsExceptScope(scope)).resolves.toBe(1)
  await expect(testHarness.pendingStore.get(signed.graph.root.id)).resolves.toMatchObject({
    phase: 'signed',
    rawTransaction,
    transactionHash
  })
  await expect(testHarness.pendingStore.get(awaiting.graph.root.id)).resolves.toBeNull()
  await expect(testHarness.repository.get(otherScope, awaiting.graph.root.id)).resolves.toBeNull()
})

test('recovers an approved command after a service worker interruption before signing', async () => {
  const calls = []
  const recoverableSigner = signer(calls)
  const confirm = recoverableSigner.confirm
  let interrupted = true
  recoverableSigner.confirm = async (...args) => {
    if (interrupted) {
      interrupted = false
      calls.push(['confirm-interrupted', ...args])
      throw new Error('service worker interrupted')
    }
    return confirm(...args)
  }
  const testHarness = harness({ signer: recoverableSigner })
  const prepared = await prepare(testHarness.orchestrator)

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/interrupted/i)
  await expect(testHarness.repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
  await expect(
    testHarness.pendingStore.getReviewGraph(prepared.graph.root.id)
  ).resolves.toMatchObject({
    root: { status: 'approved' },
    segments: [{ status: 'approved' }]
  })
  await expect(
    testHarness.orchestrator.getPendingApproval({
      scope,
      transactionId: prepared.graph.root.id
    })
  ).resolves.toMatchObject({
    graph: { root: { status: 'approved' } },
    signing: { payloadFingerprint: prepared.signing.payloadFingerprint }
  })

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).resolves.toMatchObject({ status: 'broadcast', graph: { root: { status: 'broadcast' } } })
})

test('keeps one signed raw transaction for exact rebroadcast after an ambiguous RPC failure', async () => {
  let known = false
  let pendingSchedules = 0
  const analytics = []
  const testHarness = harness({
    rpc: rpc({
      broadcastRawTransaction: async () => {
        throw new Error('network unavailable')
      },
      hasTransaction: async () => known
    }),
    onPendingBroadcast: () => {
      pendingSchedules += 1
    },
    onBroadcastAccepted: (graph, recovered) =>
      recovered &&
      reportBackgroundSendBroadcast(graph, (name, options) => {
        analytics.push({ name, options })
        return new Promise(() => {})
      })
  })
  const prepared = await prepare(testHarness.orchestrator)
  const pending = await testHarness.orchestrator.approve({
    scope,
    transactionId: prepared.graph.root.id,
    payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
  })
  expect(pending.status).toBe('signed-pending-broadcast')
  expect(analytics).toHaveLength(0)
  expect(pending.graph.root.status).toBe('signed')
  expect(pending.graph.segments[0].evidence).toMatchObject({
    transactionHash,
    externalReference: 'evm-nonce:7'
  })
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toMatchObject({
    phase: 'signed',
    rawTransaction,
    transactionHash
  })
  expect(pendingSchedules).toBe(1)

  known = true
  const recovered = await testHarness.orchestrator.resumeBroadcast({
    scope,
    transactionId: prepared.graph.root.id
  })
  expect(recovered.status).toBe('broadcast')
  expect(analytics).toHaveLength(1)
  expect(analytics[0].options.idempotencyKey).toBe(`send-broadcast:${prepared.graph.root.id}`)
  expect(recovered.graph.root.status).toBe('broadcast')
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
})

test('rejects a signed raw transaction that does not match the reviewed transfer', async () => {
  const calls = []
  const testHarness = harness({
    signer: signer(calls, { transactionHash: `0x${'b'.repeat(64)}` })
  })
  const prepared = await prepare(testHarness.orchestrator)

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/integrity validation/)
  await expect(testHarness.repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
  expect(calls.map(call => call[0])).toEqual(['prepare', 'confirm'])
})

test('fails closed before broadcast when the signed recovery record cannot be persisted', async () => {
  let broadcasts = 0
  const testHarness = harness({
    session: { failSetCall: 3 },
    rpc: rpc({
      broadcastRawTransaction: async () => {
        broadcasts += 1
        return transactionHash
      }
    })
  })
  const prepared = await prepare(testHarness.orchestrator)

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/could not be persisted/)
  expect(broadcasts).toBe(0)
  await expect(testHarness.repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
})

test('does not report broadcast success until the signed recovery record is removed', async () => {
  const testHarness = harness({ session: { failRemove: true } })
  const prepared = await prepare(testHarness.orchestrator)

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/cleanup unavailable/)
  await expect(testHarness.repository.get(scope, prepared.graph.root.id)).resolves.toMatchObject({
    root: { status: 'broadcast' },
    segments: [{ status: 'broadcast', evidence: { transactionHash } }]
  })
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toMatchObject({
    phase: 'signed',
    rawTransaction,
    transactionHash
  })

  testHarness.session.setFailRemove(false)
  await expect(
    testHarness.orchestrator.resumeBroadcast({
      scope,
      transactionId: prepared.graph.root.id
    })
  ).resolves.toMatchObject({ status: 'broadcast', graph: { root: { status: 'broadcast' } } })
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
})

test('does not confirm a signing command when the approval fingerprint is stale', async () => {
  const { orchestrator, repository, calls } = harness()
  const prepared = await prepare(orchestrator)

  await expect(
    orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: 'c'.repeat(64)
    })
  ).rejects.toThrow(/fingerprint does not match/)
  expect(calls.map(call => call[0])).toEqual(['prepare'])
  await expect(repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
})

test('reserves distinct nonces for concurrent preparations while RPC pending nonce lags', async () => {
  const testHarness = harness({ rpc: rpc({ getPendingNonce: async () => '7' }) })
  const [first, second] = await Promise.all([
    prepare(testHarness.orchestrator),
    prepare(testHarness.orchestrator)
  ])

  expect(first.signing.summary.fields.nonce).toBe('7')
  expect(second.signing.summary.fields.nonce).toBe('8')
  await expect(testHarness.pendingStore.list()).resolves.toHaveLength(2)
})

test('blocks a new transfer when old local nonces outrun the RPC pending nonce', async () => {
  const testHarness = harness({ rpc: rpc({ getPendingNonce: async () => '9' }) })
  await testHarness.repository.create(localBroadcastGraph(21))

  await expect(prepare(testHarness.orchestrator)).rejects.toMatchObject({
    code: 'nonce-recovery-required'
  })
  await expect(
    testHarness.orchestrator.getNonceRecovery({ chainAccount: account })
  ).resolves.toMatchObject({
    pendingNonce: '9',
    highestLocalNonce: '21',
    action: 'fill-gap'
  })
  await expect(testHarness.pendingStore.list()).resolves.toHaveLength(0)
})

test('releases a stale clearing transaction after the pending nonce advances past it', async () => {
  let pendingNonce = '9'
  const testHarness = harness({ rpc: rpc({ getPendingNonce: async () => pendingNonce }) })
  const original = localBroadcastGraph(9)
  const clearing = localBroadcastGraph(9, 'transaction:evm:clearing-9')
  clearing.root.kind = 'cancel'
  clearing.root.intent.direction = 'self'
  clearing.root.intent.recipient.address = from
  await testHarness.repository.create(original)
  await testHarness.repository.create(clearing)

  await expect(
    testHarness.orchestrator.getNonceRecovery({ chainAccount: account })
  ).resolves.toMatchObject({
    action: 'await-confirmation',
    pendingNonce: '9'
  })
  await expect(prepare(testHarness.orchestrator)).rejects.toMatchObject({
    code: 'nonce-recovery-required'
  })

  pendingNonce = '10'
  await expect(
    testHarness.orchestrator.getNonceRecovery({ chainAccount: account })
  ).resolves.toBeNull()
  const next = await prepare(testHarness.orchestrator)
  expect(next.signing.summary.fields.nonce).toBe('10')
})

test('fails closed on a rate-limited pending nonce query before signing', async () => {
  const testHarness = harness({
    rpc: rpc({
      getPendingNonce: async () => {
        throw new Error('HTTP 429')
      }
    })
  })
  await testHarness.repository.create(localBroadcastGraph(21))

  await expect(prepare(testHarness.orchestrator)).rejects.toThrow('HTTP 429')
  await expect(
    testHarness.orchestrator.getNonceRecovery({ chainAccount: account })
  ).rejects.toThrow('HTTP 429')
  await expect(testHarness.pendingStore.list()).resolves.toHaveLength(0)
})

test('allows a user-approved cancellation when the oldest local hash is unknown to RPC', async () => {
  let nonce = '9'
  const testHarness = harness({
    rpc: rpc({
      getPendingNonce: async () => nonce,
      getTransactionLocation: async () => ({ status: 'unknown' })
    })
  })
  const original = localBroadcastGraph(9)
  await testHarness.repository.create(original)

  await expect(
    testHarness.orchestrator.getNonceRecovery({ chainAccount: account })
  ).resolves.toMatchObject({
    pendingNonce: '9',
    action: 'replace',
    transactionId: original.root.id
  })
  const review = await testHarness.orchestrator.prepareNonceRecovery({ chainAccount: account })
  expect(review.signing.summary.fields.nonce).toBe('9')
  expect(review.graph.root.relation).toEqual({
    kind: 'replacement-of',
    transactionId: original.root.id
  })

  nonce = '10'
  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: review.graph.root.id,
      payloadFingerprint: review.signing.payloadFingerprint.digestHex
    })
  ).rejects.toMatchObject({ code: 'stale-nonce' })
  await expect(testHarness.pendingStore.get(review.graph.root.id)).resolves.toBeNull()
})

test('prepares a self-transfer at the missing pending nonce and rejects stale approval', async () => {
  let nonce = '9'
  const testHarness = harness({ rpc: rpc({ getPendingNonce: async () => nonce }) })
  await testHarness.repository.create(localBroadcastGraph(21))

  const review = await testHarness.orchestrator.prepareNonceRecovery({ chainAccount: account })
  const pending = await testHarness.pendingStore.get(review.graph.root.id)
  expect(review.signing.summary.fields.nonce).toBe('9')
  expect(review.graph.root).toMatchObject({ kind: 'cancel', status: 'prepared' })
  expect(review.graph.root.relation).toBeUndefined()
  expect(pending.prepared).toMatchObject({
    kind: 'nonce-recovery',
    transaction: { nonce: '9', value: '0', to: from, input: '0x' }
  })

  nonce = '10'
  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: review.graph.root.id,
      payloadFingerprint: review.signing.payloadFingerprint.digestHex
    })
  ).rejects.toMatchObject({ code: 'stale-nonce' })
  await expect(testHarness.pendingStore.get(review.graph.root.id)).resolves.toBeNull()
})

test('does not cancel a later unknown hash before the earliest nonce is resolved', async () => {
  const testHarness = harness({
    rpc: rpc({
      getPendingNonce: async () => '9',
      getTransactionLocation: async () => ({ status: 'unknown' })
    })
  })
  const original = localBroadcastGraph(21)
  await testHarness.repository.create(original)

  await expect(
    testHarness.orchestrator.prepareCancel({
      chainAccount: account,
      originalTransactionId: parseTransactionId(original.root.id)
    })
  ).rejects.toMatchObject({ code: 'stale-nonce' })
})

test('accepts a locally reserved nonce ahead of a lagging RPC pending nonce', async () => {
  const testHarness = harness({ rpc: rpc({ getPendingNonce: async () => '7' }) })
  await prepare(testHarness.orchestrator)
  const second = await prepare(testHarness.orchestrator)
  const pending = await testHarness.pendingStore.get(second.graph.root.id)

  await expect(assertEvmTransferFresh(pending.prepared, rpc())).resolves.toBeUndefined()
})

test('prepares a linked same-nonce cancellation only while the original remains pending', async () => {
  let location = { status: 'pending' }
  const testHarness = harness({
    rpc: rpc({ getTransactionLocation: async () => location })
  })
  const original = await prepare(testHarness.orchestrator)
  await testHarness.orchestrator.approve({
    scope,
    transactionId: original.graph.root.id,
    payloadFingerprint: original.signing.payloadFingerprint.digestHex
  })

  const cancellation = await testHarness.orchestrator.prepareCancel({
    chainAccount: account,
    originalTransactionId: original.graph.root.id,
    signingMode: 'internal'
  })
  expect(cancellation.graph.root).toMatchObject({
    kind: 'cancel',
    status: 'prepared',
    relation: { kind: 'replacement-of', transactionId: original.graph.root.id },
    intent: { direction: 'self', evm: { nonce: '7' } }
  })
  expect(cancellation.signing.summary.fields).toMatchObject({
    from,
    to: from,
    nonce: '7',
    valueWei: '0'
  })

  location = { status: 'included', blockHash: '0x1', blockNumber: '1' }
  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: cancellation.graph.root.id,
      payloadFingerprint: cancellation.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/no longer pending/i)
})

test('rejects cancellation preparation after the original leaves the pending pool', async () => {
  let location = { status: 'pending' }
  const testHarness = harness({
    rpc: rpc({ getTransactionLocation: async () => location })
  })
  const original = await prepare(testHarness.orchestrator)
  await testHarness.orchestrator.approve({
    scope,
    transactionId: original.graph.root.id,
    payloadFingerprint: original.signing.payloadFingerprint.digestHex
  })
  location = { status: 'included', blockHash: '0x1', blockNumber: '1' }

  await expect(
    testHarness.orchestrator.prepareCancel({
      chainAccount: account,
      originalTransactionId: original.graph.root.id,
      signingMode: 'internal'
    })
  ).rejects.toThrow(/no longer pending/i)
  await expect(testHarness.pendingStore.list()).resolves.toHaveLength(0)
})

test('rejects a cancellation approval when its original completed during review', async () => {
  const testHarness = harness({
    rpc: rpc({ getTransactionLocation: async () => ({ status: 'pending' }) })
  })
  const original = await prepare(testHarness.orchestrator)
  await testHarness.orchestrator.approve({
    scope,
    transactionId: original.graph.root.id,
    payloadFingerprint: original.signing.payloadFingerprint.digestHex
  })
  const cancellation = await testHarness.orchestrator.prepareCancel({
    chainAccount: account,
    originalTransactionId: original.graph.root.id
  })
  const persisted = await testHarness.repository.get(scope, original.graph.root.id)
  const segment = persisted.segments[0]
  await testHarness.repository.applySegmentEvent({
    scope,
    transactionId: persisted.root.id,
    segmentId: segment.id,
    event: {
      id: 'event:evm:original-completed',
      status: 'final',
      cause: 'progress',
      observedAt: 2_000,
      evidence: {
        transactionHash: segment.evidence.transactionHash,
        blockHash: `0x${'b'.repeat(64)}`,
        blockHeight: 101
      }
    },
    expectedRootRevision: persisted.root.revision,
    expectedSegmentRevision: segment.revision
  })

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: cancellation.graph.root.id,
      payloadFingerprint: cancellation.signing.payloadFingerprint.digestHex
    })
  ).rejects.toMatchObject({ code: 'stale-nonce' })
})

test('expires the approved graph when the pending nonce changes before signing', async () => {
  let nonce = '7'
  const testHarness = harness({ rpc: rpc({ getPendingNonce: async () => nonce }) })
  const prepared = await prepare(testHarness.orchestrator)
  nonce = '8'

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).rejects.toMatchObject({ code: 'stale-nonce' })
  await expect(
    testHarness.repository.get(scope, parseTransactionId(prepared.graph.root.id))
  ).resolves.toBeNull()
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
  expect(testHarness.calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
})

test('fails closed when a session recovery record is structurally altered', async () => {
  const testHarness = harness()
  const prepared = await prepare(testHarness.orchestrator)
  const [key] = testHarness.session.values.keys()
  const altered = structuredClone(testHarness.session.values.get(key))
  altered.prepared.transaction.value = '124'
  testHarness.session.values.set(key, altered)

  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).rejects.toThrow(
    /binding mismatch/
  )
  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/integrity check failed/)
  await expect(testHarness.pendingStore.get(prepared.graph.root.id)).resolves.toBeNull()
  await expect(testHarness.repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
  expect(testHarness.calls.map(call => call[0])).toEqual(['prepare'])
})

test('fails the graph before confirmation when a valid-looking payload no longer matches its WASM fingerprint', async () => {
  const testHarness = harness()
  const prepared = await prepare(testHarness.orchestrator)
  const [key] = testHarness.session.values.keys()
  const altered = structuredClone(testHarness.session.values.get(key))
  altered.prepared.transaction.nonce = '8'
  testHarness.session.values.set(key, altered)

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/integrity check failed/)
  await expect(testHarness.repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
  expect(testHarness.calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
})

test('fails the graph when a stored review summary no longer matches the prepared payload', async () => {
  const testHarness = harness()
  const prepared = await prepare(testHarness.orchestrator)
  const [key] = testHarness.session.values.keys()
  const altered = structuredClone(testHarness.session.values.get(key))
  altered.signingSummary.fields.valueWei = '124'
  testHarness.session.values.set(key, altered)

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId: prepared.graph.root.id,
      payloadFingerprint: prepared.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/integrity check failed/)
  await expect(testHarness.repository.get(scope, prepared.graph.root.id)).resolves.toBeNull()
  expect(testHarness.calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
})
