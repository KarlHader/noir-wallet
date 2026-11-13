import { test } from 'node:test'
import { expect } from '@playwright/test'
import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { initEccLib, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import bs58check from 'bs58check'

import { DASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { DashRpcError } from '../../../../src/infrastructure/chains/dash/dash-insight-codecs.ts'
import { DashTransactionMonitor } from '../../../../src/infrastructure/chains/dash/dash-transaction-monitor.ts'
import { MemoryDashInputReservationRepository } from '../../../../src/infrastructure/chains/dash/dash-input-reservation-repository.ts'
import { selectDashCoins } from '../../../../src/infrastructure/chains/dash/dash-coin-selection.ts'
import { buildDashPsbt } from '../../../../src/infrastructure/chains/dash/dash-psbt-builder.ts'
import {
  computeDashSigningPayloadFingerprint,
  createDashSigningSummary
} from '../../../../src/infrastructure/chains/dash/dash-prepared-psbt-validator.ts'
import { DashTransactionRecovery } from '../../../../src/infrastructure/chains/dash/dash-transaction-recovery.ts'
import {
  DashTransferOrchestrator,
  MemoryDashPendingTransferStore
} from '../../../../src/infrastructure/chains/dash/dash-transfer-orchestrator.ts'
import { dashBitcoinJsNetwork } from '../../../../src/infrastructure/chains/dash/dash-transaction-model.ts'
import { classifyDashUtxo } from '../../../../src/infrastructure/chains/dash/dash-spendable-utxos.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'

initEccLib(secp256k1)

const CHAIN = DASH_CHAIN_IDS.testnet
const NETWORK = dashBitcoinJsNetwork(CHAIN)
const FEE_RATE = 1000n
const assets = createAssetRegistry(
  createInitialProductChainRegistry('testnet'),
  getBundledInitialProductAssetDefinitions('testnet')
)

function p2pkh(index) {
  const hash = Buffer.alloc(20, index)
  return bs58check.encode(Buffer.concat([Buffer.from([140]), hash]))
}

function chainAccount(address) {
  return {
    id: 'chain-account-dash-test',
    scope: { keyDomainId: 'wallet-dash', accountId: 'account-dash', chainId: CHAIN },
    derivation: { scheme: 'bip44', path: "m/44'/1'/0'/0/0" },
    identity: { kind: 'account-identifier', value: address },
    createdAt: 1
  }
}

function funding(script, value) {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(Buffer.alloc(32, 3), 0)
  transaction.addOutput(script, value)
  return transaction
}

function walletFixture(value = 100_000) {
  const privateKey = Buffer.from('33'.repeat(32), 'hex')
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const payment = payments.p2pkh({ pubkey: publicKey, network: NETWORK })
  const previous = funding(payment.output, value)
  const address = payment.address
  const utxo = {
    chainId: CHAIN,
    accountIndex: 0,
    imported: false,
    change: false,
    addressIndex: 0,
    address,
    derivationPath: "m/44'/1'/0'/0/0",
    publicKey: `0x${publicKey.toString('hex')}`,
    scriptHex: payment.output.toString('hex'),
    transactionId: previous.getId(),
    outputIndex: 0,
    valueDuffs: value.toString(),
    rawTransactionHex: previous.toHex()
  }
  return { privateKey, publicKey, address, utxo }
}

test('only one concurrent reservation of the same outpoint succeeds', async () => {
  const { address, utxo } = walletFixture()
  const repository = new MemoryDashInputReservationRepository()
  const scope = { chainAccount: chainAccount(address), accountIndex: 0 }
  const outpoints = [{ transactionId: utxo.transactionId, outputIndex: 0 }]
  const results = await Promise.allSettled([
    repository.reserve({ ...scope, transactionId: 'transaction:dash:a', outpoints, now: 1 }),
    repository.reserve({ ...scope, transactionId: 'transaction:dash:b', outpoints, now: 1 })
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
})

test('broadcast timeout stays pending and recovery does not sign again', async () => {
  const { privateKey, publicKey, address, utxo } = walletFixture()
  const recipient = p2pkh(9)
  const selection = selectDashCoins({
    chainId: CHAIN,
    accountIndex: 0,
    imported: false,
    recipient,
    amount: { mode: 'max' },
    feeRateDuffsPerKb: FEE_RATE.toString(),
    utxos: [utxo]
  })
  expect(BigInt(selection.amountDuffs) + BigInt(selection.feeDuffs)).toBe(BigInt(utxo.valueDuffs))
  expect(BigInt(selection.amountDuffs) < BigInt(utxo.valueDuffs)).toBe(true)
  const prepared = buildDashPsbt({ selection, masterFingerprint: '0x0a0b0c0d' })
  const account = chainAccount(address)
  const reservations = new MemoryDashInputReservationRepository()
  const inputReservation = await reservations.reserve({
    chainAccount: account,
    accountIndex: 0,
    transactionId: 'transaction:dash:send',
    outpoints: [{ transactionId: utxo.transactionId, outputIndex: utxo.outputIndex }],
    now: 10
  })
  let confirms = 0
  let broadcasts = 0
  const signer = {
    async prepare() {
      return {
        commandId: 'signing-command:dash:1',
        chainId: CHAIN,
        operation: 'transaction',
        summary: createDashSigningSummary(prepared, address),
        payloadFingerprint: {
          algorithm: 'sha256',
          digestHex: await computeDashSigningPayloadFingerprint(prepared.psbtBase64)
        },
        execution: { kind: 'internal' },
        expiresAt: 50_000
      }
    },
    async confirm() {
      confirms += 1
      const psbt = Psbt.fromBase64(prepared.psbtBase64, { network: NETWORK })
      psbt.signInput(0, {
        publicKey,
        sign: hash => Buffer.from(secp256k1.sign(hash, privateKey))
      })
      return { kind: 'signed-payload', payload: { encoding: 'base64', value: psbt.toBase64() } }
    },
    async cancel() {}
  }
  const pendingStore = new MemoryDashPendingTransferStore()
  const repository = new InMemoryTransactionRepository()
  const rpc = {
    async broadcastRawTransaction() {
      broadcasts += 1
      if (broadcasts === 1) throw new DashRpcError('timeout', 'broadcast timed out')
      return ''
    },
    async getTransaction() {
      throw new DashRpcError('not-found', 'not yet visible')
    }
  }
  const options = {
    repository,
    pendingStore,
    signer,
    rpc,
    assets,
    changeReservations: { async transition() { return {} } },
    inputReservations: reservations,
    now: () => 1_000,
    createId: (() => {
      let n = 0
      return () => `event-${n += 1}`
    })()
  }
  const orchestrator = new DashTransferOrchestrator(options)
  const authorization = {
    chainAccountId: account.id,
    credentialGenerationId: 'generation-1',
    chainId: CHAIN,
    accountIndex: 0
  }
  await orchestrator.prepare({
    chainAccount: account,
    transactionId: 'transaction:dash:send',
    segmentId: 'segment:dash:send',
    prepared,
    signerAddress: address,
    changeReservation: null,
    inputReservation,
    authorization
  })
  const pending = await orchestrator.approve({
    scope: account.scope,
    transactionId: 'transaction:dash:send',
    payloadFingerprint: await computeDashSigningPayloadFingerprint(prepared.psbtBase64),
    authorization
  })
  expect(pending.status).toBe('signed-pending-broadcast')
  expect(pending.graph.root.status).not.toBe('failed')
  expect(pending.graph.segments[0].status).not.toBe('failed')
  const stillReserved = await reservations.list({ chainAccount: account, accountIndex: 0 })
  expect(stillReserved[0].state).toBe('reserved')

  rpc.broadcastRawTransaction = async () => {
    broadcasts += 1
    const psbt = Psbt.fromBase64(prepared.psbtBase64, { network: NETWORK })
    return Transaction.fromHex(
      finalizeSigned(psbt, publicKey, privateKey)
    ).getId()
  }
  const restarted = new DashTransferOrchestrator({ ...options, signer: { ...signer, confirm: async () => { throw new Error('must not sign again') } } })
  const recovered = await new DashTransactionRecovery(restarted).recoverSignedBroadcasts(account.scope)
  expect(confirms).toBe(1)
  expect(recovered[0].status).toBe('broadcast')
  expect(recovered[0].graph.root.status).toBe('broadcast')
})

test('invalid broadcast response keeps the reservation unless the transaction is already visible', async () => {
  const { privateKey, publicKey, address, utxo } = walletFixture()
  const recipient = p2pkh(9)
  const selection = selectDashCoins({
    chainId: CHAIN,
    accountIndex: 0,
    imported: false,
    recipient,
    amount: { mode: 'max' },
    feeRateDuffsPerKb: FEE_RATE.toString(),
    utxos: [utxo]
  })
  const prepared = buildDashPsbt({ selection, masterFingerprint: '0x0a0b0c0d' })
  const account = chainAccount(address)
  const visible = new Set()
  const transitions = []
  const reservations = new MemoryDashInputReservationRepository()
  const inputReservation = await reservations.reserve({
    chainAccount: account,
    accountIndex: 0,
    transactionId: 'transaction:dash:ambiguous',
    outpoints: [{ transactionId: utxo.transactionId, outputIndex: utxo.outputIndex }],
    now: 10
  })
  const signer = {
    async prepare() {
      return {
        commandId: 'signing-command:dash:ambiguous',
        chainId: CHAIN,
        operation: 'transaction',
        summary: createDashSigningSummary(prepared, address),
        payloadFingerprint: {
          algorithm: 'sha256',
          digestHex: await computeDashSigningPayloadFingerprint(prepared.psbtBase64)
        },
        execution: { kind: 'internal' },
        expiresAt: 50_000
      }
    },
    async confirm() {
      const psbt = Psbt.fromBase64(prepared.psbtBase64, { network: NETWORK })
      psbt.signInput(0, {
        publicKey,
        sign: hash => Buffer.from(secp256k1.sign(hash, privateKey))
      })
      return { kind: 'signed-payload', payload: { encoding: 'base64', value: psbt.toBase64() } }
    },
    async cancel() {}
  }
  let event = 0
  const orchestrator = new DashTransferOrchestrator({
    repository: new InMemoryTransactionRepository(),
    pendingStore: new MemoryDashPendingTransferStore(),
    signer,
    rpc: {
      async broadcastRawTransaction() {
        throw new DashRpcError('invalid-response', 'Dash RPC response is not valid JSON')
      },
      async getTransaction(transactionId) {
        if (!visible.has(transactionId)) throw new DashRpcError('not-found', 'not yet visible')
        return { transactionId }
      }
    },
    assets,
    changeReservations: {
      async transition(input) {
        transitions.push(input.state)
        return {}
      }
    },
    inputReservations: reservations,
    now: () => 1_000,
    createId: () => `event-ambiguous-${event += 1}`
  })
  const authorization = {
    chainAccountId: account.id,
    credentialGenerationId: 'generation-1',
    chainId: CHAIN,
    accountIndex: 0
  }
  await orchestrator.prepare({
    chainAccount: account,
    transactionId: 'transaction:dash:ambiguous',
    segmentId: 'segment:dash:ambiguous',
    prepared,
    signerAddress: address,
    changeReservation: null,
    inputReservation,
    authorization
  })
  const hidden = await orchestrator.approve({
    scope: account.scope,
    transactionId: 'transaction:dash:ambiguous',
    payloadFingerprint: await computeDashSigningPayloadFingerprint(prepared.psbtBase64),
    authorization
  })
  expect(hidden.status).toBe('signed-pending-broadcast')
  expect(hidden.graph.root.status).not.toBe('failed')
  expect(transitions).not.toContain('abandoned')
  const stillReserved = await reservations.list({ chainAccount: account, accountIndex: 0 })
  expect(stillReserved[0].state).toBe('reserved')

  const signed = await orchestrator.listSignedPending()
  visible.add(signed[0].transactionHash)
  const recovered = await new DashTransactionRecovery(orchestrator).recoverSignedBroadcasts(account.scope)
  expect(recovered[0].status).toBe('broadcast')
  expect(recovered[0].graph.root.status).toBe('broadcast')
  expect(transitions).not.toContain('abandoned')
  const committed = await reservations.list({ chainAccount: account, accountIndex: 0 })
  expect(committed[0].state).toBe('committed')
})

function finalizeSigned(psbt, publicKey, privateKey) {
  psbt.signInput(0, { publicKey, sign: hash => Buffer.from(secp256k1.sign(hash, privateKey)) })
  psbt.finalizeAllInputs()
  return psbt.extractTransaction().toHex()
}

test('max does not spend the full balance and dust or short inputs are rejected', () => {
  const { utxo, address } = walletFixture(100_000)
  const recipient = p2pkh(4)
  const max = selectDashCoins({
    chainId: CHAIN,
    accountIndex: 0,
    imported: false,
    recipient,
    amount: { mode: 'max' },
    feeRateDuffsPerKb: FEE_RATE.toString(),
    utxos: [utxo]
  })
  expect(BigInt(max.amountDuffs)).toBeLessThan(BigInt(utxo.valueDuffs))
  expect(BigInt(max.amountDuffs) + BigInt(max.feeDuffs)).toBe(BigInt(utxo.valueDuffs))
  expect(max.changeDuffs).toBe('0')
  expect(() =>
    selectDashCoins({
      chainId: CHAIN,
      accountIndex: 0,
      imported: false,
      recipient,
      amount: { mode: 'exact', valueDuffs: '181' },
      feeRateDuffsPerKb: FEE_RATE.toString(),
      utxos: [utxo]
    })
  ).toThrow(/dust/i)
  expect(() =>
    selectDashCoins({
      chainId: CHAIN,
      accountIndex: 0,
      imported: false,
      recipient,
      amount: { mode: 'exact', valueDuffs: '90000' },
      feeRateDuffsPerKb: FEE_RATE.toString(),
      utxos: [{ ...utxo, valueDuffs: '1000' }]
    })
  ).toThrow(/insufficient/i)
  const held = classifyDashUtxo(
    {
      transactionId: utxo.transactionId,
      outputIndex: 0,
      valueDuffs: utxo.valueDuffs,
      confirmations: 20,
      scriptHex: utxo.scriptHex
    },
    { transactionId: utxo.transactionId, type: 5, isCoinbase: false }
  )
  expect(held.kind).toBe('held')
  expect(held.reason).toBe('dip2-special-transaction')
  void address
})

test('ledger send keeps the account path and broadcasts the device transaction', async () => {
  const { HDKey } = await import('@scure/bip32')
  const { deriveLedgerDashP2pkh } = await import(
    '../../../../src/lib/ledger/dash-model.ts'
  )
  const chainId = DASH_CHAIN_IDS.mainnet
  const network = dashBitcoinJsNetwork(chainId)
  const mainnetAssets = createAssetRegistry(
    createInitialProductChainRegistry('mainnet'),
    getBundledInitialProductAssetDefinitions('mainnet')
  )
  const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(5))
  const accountKey = root.derive("m/44'/5'/0'")
  const child = root.derive("m/44'/5'/0'/0/0")
  const derived = deriveLedgerDashP2pkh(accountKey.publicExtendedKey, false, 0)
  const privateKey = Buffer.from(child.privateKey)
  const publicKey = Buffer.from(derived.publicKey, 'hex')
  const script = Buffer.from(derived.scriptPubKeyHex, 'hex')
  const previous = funding(script, 100_000)
  const utxo = {
    chainId,
    accountIndex: 0,
    imported: false,
    change: false,
    addressIndex: 0,
    address: derived.address,
    derivationPath: "m/44'/5'/0'/0/0",
    publicKey: `0x${derived.publicKey}`,
    scriptHex: derived.scriptPubKeyHex,
    transactionId: previous.getId(),
    outputIndex: 0,
    valueDuffs: '100000',
    rawTransactionHex: previous.toHex()
  }
  const recipient = payments.p2pkh({
    hash: Buffer.alloc(20, 9),
    network
  }).address
  const selection = selectDashCoins({
    chainId,
    accountIndex: 0,
    imported: false,
    recipient,
    amount: { mode: 'max' },
    feeRateDuffsPerKb: FEE_RATE.toString(),
    utxos: [utxo]
  })
  const fingerprint = `0x${accountKey.fingerprint.toString(16).padStart(8, '0')}`
  const prepared = buildDashPsbt({ selection, masterFingerprint: fingerprint })
  const review = Psbt.fromBase64(prepared.psbtBase64, { network })
  expect(review.data.inputs[0].bip32Derivation[0].path).toBe("m/44'/5'/0'/0/0")
  expect(Buffer.from(review.data.inputs[0].bip32Derivation[0].pubkey).toString('hex')).toBe(
    derived.publicKey
  )
  const account = {
    id: 'chain-account-dash-ledger',
    scope: { keyDomainId: 'wallet-dash', accountId: 'account-dash', chainId },
    derivation: { scheme: 'bip44', path: "m/44'/5'/0'/0/0" },
    identity: { kind: 'account-identifier', value: derived.address },
    createdAt: 1
  }
  const reservations = new MemoryDashInputReservationRepository()
  const inputReservation = await reservations.reserve({
    chainAccount: account,
    accountIndex: 0,
    transactionId: 'transaction:dash:ledger',
    outpoints: [{ transactionId: utxo.transactionId, outputIndex: 0 }],
    now: 10
  })
  let prepares = 0
  let confirms = 0
  let broadcastHex = ''
  const signer = {
    async prepare() {
      prepares += 1
      throw new Error('ledger prepare must not use the software signer')
    },
    async confirm() {
      confirms += 1
      throw new Error('ledger approval must not use the software signer')
    },
    async cancel() {
      throw new Error('ledger command was not registered')
    }
  }
  const orchestrator = new DashTransferOrchestrator({
    repository: new InMemoryTransactionRepository(),
    pendingStore: new MemoryDashPendingTransferStore(),
    signer,
    rpc: {
      async broadcastRawTransaction(rawTransactionHex) {
        broadcastHex = rawTransactionHex
        return Transaction.fromHex(rawTransactionHex).getId()
      },
      async getTransaction() {
        throw new DashRpcError('not-found', 'not yet visible')
      }
    },
    assets: mainnetAssets,
    changeReservations: { async transition() { return {} } },
    inputReservations: reservations,
    now: () => 1_000,
    createId: (() => {
      let n = 0
      return () => `ledger-${n += 1}`
    })()
  })
  const authorization = {
    chainAccountId: account.id,
    credentialGenerationId: 'generation-1',
    chainId,
    accountIndex: 0
  }
  await orchestrator.prepare({
    chainAccount: account,
    transactionId: 'transaction:dash:ledger',
    segmentId: 'segment:dash:ledger',
    prepared,
    signerAddress: derived.address,
    changeReservation: null,
    inputReservation,
    authorization,
    signingMode: 'ledger'
  })
  expect(prepares).toBe(0)
  await expect(
    orchestrator.approve({
      scope: account.scope,
      transactionId: 'transaction:dash:ledger',
      payloadFingerprint: await computeDashSigningPayloadFingerprint(prepared.psbtBase64),
      authorization
    })
  ).rejects.toThrow(/signed on the device/)
  expect(confirms).toBe(0)
  const signedHex = finalizeSigned(Psbt.fromBase64(prepared.psbtBase64, { network }), publicKey, privateKey)
  const submission = await orchestrator.submitLedgerSignature({
    scope: account.scope,
    transactionId: 'transaction:dash:ledger',
    payloadFingerprint: await computeDashSigningPayloadFingerprint(prepared.psbtBase64),
    signedTransactionHex: signedHex,
    authorization
  })
  expect(submission.status).toBe('broadcast')
  expect(broadcastHex).toBe(signedHex)
  expect(confirms).toBe(0)
})

test('confirmation progress advances while the transfer stays confirming', async () => {
  const { privateKey, publicKey, address, utxo } = walletFixture()
  const recipient = p2pkh(9)
  const selection = selectDashCoins({
    chainId: CHAIN,
    accountIndex: 0,
    imported: false,
    recipient,
    amount: { mode: 'max' },
    feeRateDuffsPerKb: FEE_RATE.toString(),
    utxos: [utxo]
  })
  const prepared = buildDashPsbt({ selection, masterFingerprint: '0x0a0b0c0d' })
  const account = chainAccount(address)
  const reservations = new MemoryDashInputReservationRepository()
  const inputReservation = await reservations.reserve({
    chainAccount: account,
    accountIndex: 0,
    transactionId: 'transaction:dash:confirmations',
    outpoints: [{ transactionId: utxo.transactionId, outputIndex: utxo.outputIndex }],
    now: 10
  })
  const signer = {
    async prepare() {
      return {
        commandId: 'signing-command:dash:confirmations',
        chainId: CHAIN,
        operation: 'transaction',
        summary: createDashSigningSummary(prepared, address),
        payloadFingerprint: {
          algorithm: 'sha256',
          digestHex: await computeDashSigningPayloadFingerprint(prepared.psbtBase64)
        },
        execution: { kind: 'internal' },
        expiresAt: 50_000
      }
    },
    async confirm() {
      const psbt = Psbt.fromBase64(prepared.psbtBase64, { network: NETWORK })
      psbt.signInput(0, {
        publicKey,
        sign: hash => Buffer.from(secp256k1.sign(hash, privateKey))
      })
      return { kind: 'signed-payload', payload: { encoding: 'base64', value: psbt.toBase64() } }
    },
    async cancel() {}
  }
  const repository = new InMemoryTransactionRepository()
  let confirmations = 1
  const rpc = {
    async broadcastRawTransaction(rawTransactionHex) {
      return Transaction.fromHex(rawTransactionHex).getId()
    },
    async getTransaction(transactionId) {
      return {
        transactionId,
        confirmations,
        blockHeight: 2569880,
        txlock: true
      }
    }
  }
  const orchestrator = new DashTransferOrchestrator({
    repository,
    pendingStore: new MemoryDashPendingTransferStore(),
    signer,
    rpc,
    assets,
    changeReservations: { async transition() { return {} } },
    inputReservations: reservations,
    now: () => 1_000,
    createId: (() => {
      let n = 0
      return () => `event-dash-confirm-${n += 1}`
    })()
  })
  const authorization = {
    chainAccountId: account.id,
    credentialGenerationId: 'generation-1',
    chainId: CHAIN,
    accountIndex: 0
  }
  await orchestrator.prepare({
    chainAccount: account,
    transactionId: 'transaction:dash:confirmations',
    segmentId: 'segment:dash:confirmations',
    prepared,
    signerAddress: address,
    changeReservation: null,
    inputReservation,
    authorization
  })
  const broadcast = await orchestrator.approve({
    scope: account.scope,
    transactionId: 'transaction:dash:confirmations',
    payloadFingerprint: await computeDashSigningPayloadFingerprint(prepared.psbtBase64),
    authorization
  })
  expect(broadcast.status).toBe('broadcast')
  let now = 2_000
  let eventId = 0
  const monitor = new DashTransactionMonitor({
    repository,
    rpc,
    now: () => {
      now += 1
      return now
    },
    createEventId: () => `confirmation-${eventId += 1}`
  })
  const scope = broadcast.graph.root.scope
  const first = await monitor.checkTransaction(scope, broadcast.graph.root.id)
  expect(first).toMatchObject({ status: 'confirming', confirmations: 1, requiredConfirmations: 6 })
  confirmations = 2
  const second = await monitor.checkTransaction(scope, broadcast.graph.root.id)
  expect(second).toMatchObject({ status: 'confirming', confirmations: 2, requiredConfirmations: 6 })
  confirmations = 6
  await monitor.poll([scope])
  await expect(repository.get(scope, broadcast.graph.root.id)).resolves.toMatchObject({
    root: { status: 'final' },
    segments: [{ status: 'final', evidence: { confirmations: 6, requiredConfirmations: 6 } }]
  })
})
