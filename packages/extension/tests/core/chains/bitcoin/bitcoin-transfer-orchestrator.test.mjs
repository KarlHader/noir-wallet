import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { address, initEccLib, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledBitcoinAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import {
  BitcoinRpcError,
  BitcoinTransferOrchestrator,
  buildBitcoinPsbt,
  ChromeSessionBitcoinPendingTransferStore,
  computeBitcoinSigningPayloadFingerprint,
  selectBitcoinCoins
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'
import { reportBackgroundSendBroadcast } from '../../../../src/background/analytics/send-broadcast.ts'

initEccLib(secp256k1)

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const scope = { keyDomainId: 'key-domain:bitcoin', accountId: 'account:bitcoin:0' }
const transactionId = parseTransactionId('transaction:bitcoin:orchestrator')
const segmentId = parseTransactionSegmentId('segment:bitcoin:orchestrator')
const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledBitcoinAssetDefinitions('mainnet'))

function bitcoinAddressProfile(addressType) {
  if (addressType === 'p2pkh') {
    return { purpose: 44, addressScheme: 'bitcoin-p2pkh', derivationScheme: 'bip44' }
  }
  if (addressType === 'p2sh-p2wpkh') {
    return {
      purpose: 49,
      addressScheme: 'bitcoin-p2sh-p2wpkh',
      derivationScheme: 'bip49'
    }
  }
  return { purpose: 84, addressScheme: 'bitcoin-p2wpkh', derivationScheme: 'bip84' }
}

function keyMaterial(digit, change, addressIndex = 0, addressType = 'p2wpkh') {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = digit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const payment =
    addressType === 'p2pkh'
      ? payments.p2pkh({ pubkey: publicKey, network: networks.bitcoin })
      : addressType === 'p2sh-p2wpkh'
        ? payments.p2sh({
            redeem: payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin }),
            network: networks.bitcoin
          })
        : payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin })
  const derivedAddress = payment.address
  if (!derivedAddress) throw new Error('Unable to derive Bitcoin test address')
  const profile = bitcoinAddressProfile(addressType)
  return {
    privateKey,
    publicKey,
    address: derivedAddress,
    derived: {
      chainId,
      addressType,
      accountIndex: 0,
      change,
      addressIndex,
      address: derivedAddress,
      addressScheme: profile.addressScheme,
      derivationScheme: profile.derivationScheme,
      derivationPath: `m/${profile.purpose}'/0'/0'/${change ? 1 : 0}/${addressIndex}`,
      publicKey: `0x${publicKey.toString('hex')}`,
      ...((addressType === 'p2pkh' || addressType === 'p2sh-p2wpkh') && payment.output
        ? { scriptPubKey: `0x${payment.output.toString('hex')}` }
        : {}),
      ...(addressType === 'p2sh-p2wpkh' && payment.redeem?.output
        ? { redeemScript: `0x${payment.redeem.output.toString('hex')}` }
        : {})
    }
  }
}

function transferContext(addressType = 'p2wpkh', selfChange = false) {
  const sender = keyMaterial(1, false, 0, addressType)
  const change = selfChange ? sender : keyMaterial(2, true, 0, addressType)
  const recipient = keyMaterial(3, false)
  const primary = addressType === 'p2wpkh' ? sender : keyMaterial(4, false)
  const chainAccount = {
    id: 'chain-account:bitcoin:0',
    scope: { ...scope, chainId },
    derivation: { scheme: 'bip84', path: primary.derived.derivationPath },
    identity: { kind: 'account-identifier', value: primary.address },
    createdAt: 1
  }
  let fundingTransaction
  let fundingTransactionId = 'a'.repeat(64)
  if (addressType === 'p2pkh') {
    fundingTransaction = new Transaction()
    fundingTransaction.version = 2
    fundingTransaction.addInput(Buffer.alloc(32), 0xffffffff)
    fundingTransaction.setWitness(0, [Buffer.alloc(71, 1), Buffer.alloc(33, 2)])
    fundingTransaction.addOutput(address.toOutputScript(sender.address, networks.bitcoin), 100000)
    fundingTransactionId = fundingTransaction.getId()
  }
  const selection = selectBitcoinCoins({
    chainId,
    accountIndex: 0,
    addressType,
    recipient: recipient.address,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [
      {
        chainId,
        addressType,
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        address: sender.address,
        derivationPath: sender.derived.derivationPath,
        publicKey: sender.derived.publicKey,
        transactionId: fundingTransactionId,
        outputIndex: 0,
        valueSats: '100000',
        blockHeight: 899_999
      }
    ]
  })
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: '0x01020304',
    lockTime: 900_000,
    ...(fundingTransaction === undefined
      ? {}
      : {
          previousTransactions: [
            { transactionId: fundingTransactionId, rawTransactionHex: fundingTransaction.toHex() }
          ]
        }),
    change: { address: change.derived, outputPosition: 'first' }
  })
  const psbt = Psbt.fromBase64(prepared.psbtBase64)
  const summary = {
    schema: 'bitcoin.psbt.v1',
    chainId,
    operation: 'transaction',
    review: { level: 'standard', issues: [] },
    fields: {
      psbtVersion: 0,
      signer: sender.address,
      inputs: [
        {
          index: 0,
          transactionId: fundingTransactionId,
          outputIndex: 0,
          amountSats: '100000',
          sequence: 0xfffffffd,
          scriptType: addressType,
          sighashType: 'SIGHASH_ALL',
          ownership: 'signing-account'
        }
      ],
      outputs: psbt.txOutputs.map((output, index) => ({
        index,
        address: address.fromOutputScript(output.script, networks.bitcoin),
        scriptPubKeyHex: `0x${output.script.toString('hex')}`,
        amountSats: output.value.toString(),
        classification: index === prepared.changeOutputIndex ? 'change' : 'recipient'
      })),
      signingInputIndexes: [0],
      totalInputSats: prepared.selectedTotalSats,
      totalOutputSats: (BigInt(prepared.amountSats) + BigInt(prepared.changeSats)).toString(),
      feeSats: prepared.feeSats
    }
  }
  const changeReservation = selfChange
    ? null
    : {
        schemaVersion: 1,
        chainAccount,
        accountIndex: 0,
        addressType,
        transactionId,
        state: 'reserved',
        addressIndex: 0,
        address: change.derived,
        createdAt: 900,
        updatedAt: 950
      }
  const inputReservation = {
    schemaVersion: 1,
    chainAccount,
    accountIndex: 0,
    addressType,
    transactionId,
    state: 'reserved',
    outpoints: [{ transactionId: fundingTransactionId, outputIndex: 0 }],
    createdAt: 900,
    updatedAt: 950
  }
  return { sender, chainAccount, prepared, summary, changeReservation, inputReservation }
}

function sessionStore() {
  const values = new Map()
  return {
    values,
    area: {
      get: async key => {
        if (key === null) return Object.fromEntries(structuredClone([...values]))
        if (Array.isArray(key)) {
          return Object.fromEntries(
            key
              .filter(candidate => values.has(candidate))
              .map(candidate => [candidate, structuredClone(values.get(candidate))])
          )
        }
        return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}
      },
      set: async entries => {
        for (const [key, value] of Object.entries(entries)) {
          values.set(key, structuredClone(value))
        }
      },
      remove: async keys => {
        for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
      }
    }
  }
}

function signer(context, calls, options = {}) {
  const commandId = parseSigningCommandId('signing-command:bitcoin:orchestrator')
  return {
    prepare: async (keyDomainId, payload) => {
      calls.push(['prepare', keyDomainId, payload])
      return {
        commandId,
        chainId,
        operation: 'transaction',
        summary: options.invalidSummary
          ? {
              ...context.summary,
              fields: { ...context.summary.fields, feeSats: '1' }
            }
          : options.wasmSelfChangeClassification
            ? {
                ...context.summary,
                fields: {
                  ...context.summary.fields,
                  outputs: context.summary.fields.outputs.map(output =>
                    output.classification === 'change'
                      ? { ...output, classification: 'recipient' }
                      : output
                  )
                }
              }
            : context.summary,
        payloadFingerprint: {
          algorithm: 'sha256',
          digestHex: await computeBitcoinSigningPayloadFingerprint(context.prepared)
        },
        execution: { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    confirm: async (keyDomainId, requestedCommandId) => {
      calls.push(['confirm', keyDomainId, requestedCommandId])
      const psbt = Psbt.fromBase64(context.prepared.psbtBase64)
      if (!options.unsigned) {
        psbt.signInput(0, {
          publicKey: context.sender.publicKey,
          sign: hash => Buffer.from(secp256k1.sign(hash, context.sender.privateKey))
        })
      }
      return {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: psbt.toBase64() },
        transactionId: context.prepared.unsignedTransactionId
      }
    },
    cancel: async (keyDomainId, requestedCommandId) => {
      calls.push(['cancel', keyDomainId, requestedCommandId])
      if (options.cancelThrows) throw new Error('cancel unavailable')
    }
  }
}

function harness(options = {}) {
  const context = transferContext(options.addressType, options.selfChange)
  const repository = new InMemoryTransactionRepository()
  const session = sessionStore()
  const pendingStore = new ChromeSessionBitcoinPendingTransferStore(session.area)
  const signingCalls = []
  const reservationCalls = []
  const inputReservationCalls = []
  let broadcastKnown = options.broadcastKnown ?? true
  let currentTime = options.now ?? 1_000
  let eventId = 0
  const orchestrator = new BitcoinTransferOrchestrator({
    repository,
    pendingStore,
    signer: signer(context, signingCalls, options),
    rpc: {
      broadcastRawTransaction: async rawTransactionHex => {
        if (options.broadcastThrows) throw new Error('network unavailable')
        return Transaction.fromHex(rawTransactionHex).getId()
      },
      getTransactionStatus: async () => {
        if (!broadcastKnown) throw new BitcoinRpcError('not-found', 'not found')
        return { confirmed: false }
      }
    },
    assets,
    changeReservations: {
      commit: async (reservationScope, requestedTransactionId) => {
        reservationCalls.push(['commit', reservationScope.chainAccount.id, requestedTransactionId])
        return { ...context.changeReservation, state: 'committed', updatedAt: 1_100 }
      },
      abandon: async (reservationScope, requestedTransactionId) => {
        reservationCalls.push(['abandon', reservationScope.chainAccount.id, requestedTransactionId])
        return { ...context.changeReservation, state: 'abandoned', updatedAt: 1_100 }
      }
    },
    inputReservations: {
      commit: async input => {
        inputReservationCalls.push(['commit', input.transactionId])
        return { ...context.inputReservation, state: 'committed', updatedAt: input.now }
      },
      release: async (_reservationScope, requestedTransactionId) => {
        inputReservationCalls.push(['release', requestedTransactionId])
      }
    },
    now: () => currentTime,
    createId: () => String(++eventId),
    onPendingBroadcast: options.onPendingBroadcast,
    onBroadcastAccepted: options.onBroadcastAccepted,
    onMonitoringRequired: options.onMonitoringRequired
  })
  return {
    context,
    repository,
    pendingStore,
    orchestrator,
    signingCalls,
    reservationCalls,
    inputReservationCalls,
    setBroadcastKnown: value => {
      broadcastKnown = value
    },
    setNow: value => {
      currentTime = value
    }
  }
}

async function prepare(testHarness) {
  return testHarness.orchestrator.prepare({
    chainAccount: testHarness.context.chainAccount,
    transactionId,
    segmentId,
    prepared: testHarness.context.prepared,
    signerAddress: testHarness.context.sender.address,
    changeReservation: testHarness.context.changeReservation,
    inputReservation: testHarness.context.inputReservation,
    requiredConfirmations: 6
  })
}

async function prepareKeystone(testHarness) {
  return testHarness.orchestrator.prepare({
    chainAccount: testHarness.context.chainAccount,
    transactionId,
    segmentId,
    prepared: testHarness.context.prepared,
    signerAddress: testHarness.context.sender.address,
    changeReservation: testHarness.context.changeReservation,
    inputReservation: testHarness.context.inputReservation,
    requiredConfirmations: 6,
    signingMode: 'keystone'
  })
}

function nearIntentsBinding(context) {
  return {
    schemaVersion: 1,
    provider: 'near-intents',
    kind: 'swap',
    depositAddress: context.prepared.recipient,
    refundAddress: context.sender.address,
    expiresAt: 4_000,
    origin: {
      chainId,
      assetId: `${chainId}/slip44:0`,
      protocolAssetId: 'nep141:btc.omft.near'
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

test('keeps the PSBT review in session, persists only after signing, and broadcasts', async () => {
  let monitoringSchedules = 0
  const acceptedBroadcasts = []
  const testHarness = harness({
    onBroadcastAccepted: input => {
      acceptedBroadcasts.push(input)
    },
    onMonitoringRequired: () => {
      monitoringSchedules += 1
    }
  })
  const approval = await prepare(testHarness)
  expect(approval.graph).toMatchObject({
    root: { status: 'prepared' },
    segments: [{ status: 'prepared', evidence: { requiredConfirmations: 6 } }]
  })
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toMatchObject({
    phase: 'awaiting-approval',
    changeReservation: { state: 'reserved' }
  })
  await expect(testHarness.pendingStore.getReviewGraph(transactionId)).resolves.toEqual(
    approval.graph
  )
  await expect(testHarness.repository.get(scope, transactionId)).resolves.toBeNull()

  const submission = await testHarness.orchestrator.approve({
    scope,
    transactionId,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  expect(submission).toMatchObject({
    status: 'broadcast',
    graph: {
      root: { status: 'broadcast' },
      segments: [
        {
          status: 'broadcast',
          evidence: {
            transactionHash: testHarness.context.prepared.unsignedTransactionId,
            confirmations: 0,
            requiredConfirmations: 6
          }
        }
      ]
    }
  })
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toBeNull()
  expect(testHarness.signingCalls.map(call => call[0])).toEqual(['prepare', 'confirm'])
  expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['commit'])
  expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['commit'])
  expect(acceptedBroadcasts).toHaveLength(1)
  expect(acceptedBroadcasts[0]).toMatchObject({
    scope,
    transactionId: testHarness.context.prepared.unsignedTransactionId,
    spentOutpoints: testHarness.context.inputReservation.outpoints
  })
  expect(Transaction.fromHex(acceptedBroadcasts[0].rawTransactionHex).getId()).toBe(
    acceptedBroadcasts[0].transactionId
  )
  expect(monitoringSchedules).toBe(1)
})

test('persists current-address change without allocating a change reservation', async () => {
  const testHarness = harness({ selfChange: true, wasmSelfChangeClassification: true })
  const approval = await prepare(testHarness)

  expect(approval.graph.root.status).toBe('prepared')
  expect(approval.signing.summary.fields.outputs).toContainEqual(
    expect.objectContaining({ classification: 'change' })
  )
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toMatchObject({
    phase: 'awaiting-approval',
    signer: testHarness.context.sender.address,
    changeReservation: null,
    prepared: { changeAddress: testHarness.context.sender.address }
  })
  expect(testHarness.reservationCalls).toEqual([])
})

test('accepts final BIP-44 and BIP-49 txids that differ from their unsigned PSBT txid', async () => {
  for (const addressType of ['p2pkh', 'p2sh-p2wpkh']) {
    const testHarness = harness({ addressType })
    const approval = await prepare(testHarness)
    const submission = await testHarness.orchestrator.approve({
      scope,
      transactionId,
      payloadFingerprint: approval.signing.payloadFingerprint.digestHex
    })
    const transactionHash = submission.graph.segments[0]?.evidence?.transactionHash

    expect(submission.status).toBe('broadcast')
    expect(transactionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(transactionHash).not.toBe(testHarness.context.prepared.unsignedTransactionId)
    await expect(testHarness.pendingStore.get(transactionId)).resolves.toBeNull()
    expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['commit'])
    expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['commit'])
  }
})

test('hands a Keystone PSBT off externally and broadcasts only after strict signed-PSBT validation', async () => {
  const testHarness = harness()
  const approval = await prepareKeystone(testHarness)
  expect(approval.signing).toMatchObject({
    execution: {
      kind: 'external',
      request: { encoding: 'base64', value: testHarness.context.prepared.psbtBase64 }
    }
  })
  expect(testHarness.signingCalls).toEqual([])

  const handoff = await testHarness.orchestrator.approve({
    scope,
    transactionId,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  expect(handoff).toMatchObject({
    status: 'external-signature-required',
    graph: { root: { status: 'approved' } }
  })
  await expect(
    testHarness.orchestrator.getPendingApproval({ scope, transactionId })
  ).resolves.toBeNull()
  await expect(
    testHarness.orchestrator.getExternalSigningRequest({ scope, transactionId })
  ).resolves.toMatchObject({
    transactionId,
    scope,
    chainId,
    summary: approval.signing.summary,
    request: { encoding: 'base64', value: testHarness.context.prepared.psbtBase64 }
  })

  const signedPsbt = Psbt.fromBase64(testHarness.context.prepared.psbtBase64)
  signedPsbt.signInput(0, {
    publicKey: testHarness.context.sender.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, testHarness.context.sender.privateKey))
  })
  await expect(
    testHarness.orchestrator.submitExternalSignature({
      scope,
      transactionId,
      payloadFingerprint: approval.signing.payloadFingerprint.digestHex,
      signedPsbtBase64: signedPsbt.toBase64()
    })
  ).resolves.toMatchObject({ status: 'broadcast', graph: { root: { status: 'broadcast' } } })
  expect(testHarness.signingCalls).toEqual([])
  expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['commit'])
  expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['commit'])
})

test('routes a Ledger Bitcoin PSBT through the same strict finalizer', async () => {
  const testHarness = harness()
  const approval = await testHarness.orchestrator.prepare({
    chainAccount: testHarness.context.chainAccount,
    transactionId,
    segmentId,
    prepared: testHarness.context.prepared,
    signerAddress: testHarness.context.sender.address,
    changeReservation: testHarness.context.changeReservation,
    inputReservation: testHarness.context.inputReservation,
    requiredConfirmations: 6,
    signingMode: 'ledger'
  })
  await testHarness.orchestrator.approve({
    scope,
    transactionId,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  await expect(
    testHarness.orchestrator.getExternalSigningRequest({ scope, transactionId })
  ).resolves.toMatchObject({
    vendor: 'ledger',
    scope,
    chainId,
    summary: approval.signing.summary,
    request: { value: testHarness.context.prepared.psbtBase64 }
  })
  await expect(
    testHarness.orchestrator.getPendingApproval({ scope, transactionId })
  ).resolves.toBeNull()
  const signed = Psbt.fromBase64(testHarness.context.prepared.psbtBase64)
  signed.signInput(0, {
    publicKey: testHarness.context.sender.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, testHarness.context.sender.privateKey))
  })
  await expect(
    testHarness.orchestrator.submitExternalSignature({
      scope,
      transactionId,
      payloadFingerprint: approval.signing.payloadFingerprint.digestHex,
      signedPsbtBase64: signed.toBase64()
    })
  ).resolves.toMatchObject({ status: 'broadcast' })
})

test('fails a Keystone Bitcoin transfer on tampered, unsigned or mismatched external input', async () => {
  const testHarness = harness()
  const approval = await prepareKeystone(testHarness)
  await testHarness.orchestrator.approve({
    scope,
    transactionId,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })

  await expect(
    testHarness.orchestrator.submitExternalSignature({
      scope,
      transactionId,
      payloadFingerprint: 'f'.repeat(64),
      signedPsbtBase64: testHarness.context.prepared.psbtBase64
    })
  ).rejects.toThrow(/fingerprint/)
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toMatchObject({
    phase: 'awaiting-external-signature'
  })

  await expect(
    testHarness.orchestrator.submitExternalSignature({
      scope,
      transactionId,
      payloadFingerprint: approval.signing.payloadFingerprint.digestHex,
      signedPsbtBase64: testHarness.context.prepared.psbtBase64
    })
  ).rejects.toThrow(/integrity validation/)
  await expect(testHarness.repository.get(scope, transactionId)).resolves.toBeNull()
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toBeNull()
})

test('keeps the immutable Near Intents graph while broadcasting the Bitcoin origin leg', async () => {
  const testHarness = harness()
  const binding = nearIntentsBinding(testHarness.context)
  const approval = await testHarness.orchestrator.prepare({
    chainAccount: testHarness.context.chainAccount,
    transactionId,
    segmentId,
    prepared: testHarness.context.prepared,
    signerAddress: testHarness.context.sender.address,
    changeReservation: testHarness.context.changeReservation,
    inputReservation: testHarness.context.inputReservation,
    requiredConfirmations: 6,
    nearIntentsBinding: binding
  })
  expect(approval.graph).toMatchObject({
    root: { kind: 'swap', status: 'prepared', intent: { protocol: binding } },
    segments: [
      { role: 'origin', status: 'prepared' },
      { role: 'relay', status: 'created' },
      { role: 'destination', status: 'created' },
      { role: 'refund', status: 'created' }
    ]
  })

  const submission = await testHarness.orchestrator.approve({
    scope,
    transactionId,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  expect(submission.graph).toMatchObject({
    root: { kind: 'swap', status: 'broadcast', intent: { protocol: binding } },
    segments: [
      {
        role: 'origin',
        status: 'broadcast',
        evidence: { transactionHash: testHarness.context.prepared.unsignedTransactionId }
      },
      { role: 'relay', status: 'created' },
      { role: 'destination', status: 'created' },
      { role: 'refund', status: 'created' }
    ]
  })
})

test('retains one finalized raw transaction across an ambiguous broadcast and resumes exactly', async () => {
  let pendingSchedules = 0
  const analytics = []
  const testHarness = harness({
    broadcastThrows: true,
    broadcastKnown: false,
    onPendingBroadcast: () => {
      pendingSchedules += 1
    },
    onBroadcastAccepted: (input, recovered) =>
      recovered &&
      reportBackgroundSendBroadcast(input.graph, (name, options) => {
        analytics.push({ name, options })
        return new Promise(() => {})
      })
  })
  const approval = await prepare(testHarness)
  const pending = await testHarness.orchestrator.approve({
    scope,
    transactionId,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  expect(pending).toMatchObject({
    status: 'signed-pending-broadcast',
    graph: { root: { status: 'signed' } }
  })
  expect(analytics).toHaveLength(0)
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toMatchObject({
    phase: 'signed',
    transactionHash: testHarness.context.prepared.unsignedTransactionId
  })
  expect(testHarness.reservationCalls).toEqual([])
  expect(testHarness.inputReservationCalls).toEqual([])
  expect(pendingSchedules).toBe(1)

  testHarness.setBroadcastKnown(true)
  await expect(
    testHarness.orchestrator.resumeBroadcast({ scope, transactionId })
  ).resolves.toMatchObject({ status: 'broadcast', graph: { root: { status: 'broadcast' } } })
  expect(analytics).toHaveLength(1)
  expect(analytics[0].options.idempotencyKey).toBe(`send-broadcast:${transactionId}`)
  expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['commit'])
  expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['commit'])
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toBeNull()
})

test('rejects approval without ever creating a permanent transaction record', async () => {
  const testHarness = harness()
  await prepare(testHarness)
  const graph = await testHarness.orchestrator.reject({ scope, transactionId })

  expect(graph).toMatchObject({
    root: { status: 'failed', failure: { code: 'user-rejected' } },
    segments: [{ status: 'failed', failure: { code: 'user-rejected' } }]
  })
  expect(testHarness.signingCalls.map(call => call[0])).toEqual(['prepare', 'cancel'])
  expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['abandon'])
  expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['release'])
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toBeNull()
  await expect(testHarness.repository.get(scope, transactionId)).resolves.toBeNull()
})

test('fails closed and abandons change when WASM returns an unsigned PSBT', async () => {
  const testHarness = harness({ unsigned: true })
  const approval = await prepare(testHarness)

  await expect(
    testHarness.orchestrator.approve({
      scope,
      transactionId,
      payloadFingerprint: approval.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/integrity validation/)
  await expect(testHarness.repository.get(scope, transactionId)).resolves.toBeNull()
  expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['abandon'])
  expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['release'])
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toBeNull()
})

test('cancels a prepared command and abandons change when its immutable summary is invalid', async () => {
  const testHarness = harness({ invalidSummary: true })

  await expect(prepare(testHarness)).rejects.toThrow(/summary does not match|cleanup/)
  expect(testHarness.signingCalls.map(call => call[0])).toEqual(['prepare', 'cancel'])
  expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['abandon'])
  expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['release'])
  await expect(testHarness.repository.get(scope, transactionId)).resolves.toBeNull()
})

test('does not report a rejection as successful while a live signing command cannot be cancelled', async () => {
  const testHarness = harness({ cancelThrows: true })
  await prepare(testHarness)

  await expect(testHarness.orchestrator.reject({ scope, transactionId })).rejects.toThrow(
    /cancel unavailable/
  )
  expect(testHarness.reservationCalls).toEqual([])
  expect(testHarness.inputReservationCalls).toEqual([])
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toMatchObject({
    phase: 'awaiting-approval'
  })
})

test('cancels pending approvals for an Account scope and releases every reservation', async () => {
  const testHarness = harness()
  await prepare(testHarness)

  await expect(testHarness.orchestrator.cancelAwaitingApprovalsForScope(scope)).resolves.toBe(1)
  await expect(testHarness.repository.get(scope, transactionId)).resolves.toBeNull()
  expect(testHarness.signingCalls.map(call => call[0])).toEqual(['prepare', 'cancel'])
  expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['abandon'])
  expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['release'])
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toBeNull()
})

test('expires an external signing handoff and releases its reservations before the next send', async () => {
  const testHarness = harness()
  const approval = await prepareKeystone(testHarness)
  await testHarness.orchestrator.approve({
    scope,
    transactionId,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  testHarness.setNow(1_000 + 10 * 60 * 1_000)

  await expect(testHarness.orchestrator.cancelExpiredApprovalsForScope(scope)).resolves.toBe(1)
  await expect(testHarness.repository.get(scope, transactionId)).resolves.toBeNull()
  expect(testHarness.signingCalls).toEqual([])
  expect(testHarness.reservationCalls.map(call => call[0])).toEqual(['abandon'])
  expect(testHarness.inputReservationCalls.map(call => call[0])).toEqual(['release'])
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toBeNull()
})

test('does not cancel a signed pending broadcast during an Account switch', async () => {
  const testHarness = harness({ broadcastThrows: true, broadcastKnown: false })
  const approval = await prepare(testHarness)
  await testHarness.orchestrator.approve({
    scope,
    transactionId,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })

  await expect(
    testHarness.orchestrator.cancelAwaitingApprovalsExceptScope({
      keyDomainId: 'key-domain:other',
      accountId: 'account:other:0'
    })
  ).resolves.toBe(0)
  await expect(testHarness.pendingStore.get(transactionId)).resolves.toMatchObject({
    phase: 'signed'
  })
  expect(testHarness.reservationCalls).toEqual([])
  expect(testHarness.inputReservationCalls).toEqual([])
})
