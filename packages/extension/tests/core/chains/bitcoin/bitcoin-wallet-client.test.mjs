import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { address, initEccLib, networks, payments, Psbt } from 'bitcoinjs-lib'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledBitcoinAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import {
  buildBitcoinPsbt,
  createBitcoinTransferGraph,
  selectBitcoinCoins
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'
import { createBitcoinWalletClient } from '../../../../src/popup/services/bitcoin-wallet-client.ts'
import { loadLedgerSigningView } from '../../../../src/popup/services/ledger-signing-view.ts'

initEccLib(secp256k1)

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const transactionId = 'transaction:bitcoin:client'
const segmentId = 'segment:bitcoin:client'
const fingerprint = 'a'.repeat(64)
const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledBitcoinAssetDefinitions('mainnet'))

function keyMaterial(digit) {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = digit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const derivedAddress = payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin }).address
  if (!derivedAddress) throw new Error('Unable to derive Bitcoin test address')
  return { publicKey, address: derivedAddress }
}

function context(selfTransfer = false) {
  const sender = keyMaterial(1)
  const recipient = selfTransfer ? sender : keyMaterial(2)
  const selection = selectBitcoinCoins({
    chainId,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: recipient.address,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [
      {
        chainId,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        address: sender.address,
        derivationPath: "m/84'/0'/0'/0/0",
        publicKey: `0x${sender.publicKey.toString('hex')}`,
        transactionId: 'b'.repeat(64),
        outputIndex: 0,
        valueSats: '50300',
        blockHeight: 900_000
      }
    ]
  })
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: '0x01020304',
    lockTime: 900_001
  })
  const graph = createBitcoinTransferGraph({
    prepared,
    sender: sender.address,
    scope: { keyDomainId: 'key-domain:bitcoin', accountId: 'account:bitcoin:0' },
    transactionId: parseTransactionId(transactionId),
    segmentId: parseTransactionSegmentId(segmentId),
    chainAccountId: 'chain-account:bitcoin:0',
    assets,
    requiredConfirmations: 6,
    createdAt: 1_000
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
          transactionId: 'b'.repeat(64),
          outputIndex: 0,
          amountSats: '50300',
          sequence: 0xfffffffd,
          scriptType: 'p2wpkh',
          sighashType: 'SIGHASH_ALL',
          ownership: 'signing-account'
        }
      ],
      outputs: psbt.txOutputs.map((output, index) => ({
        index,
        address: address.fromOutputScript(output.script, networks.bitcoin),
        scriptPubKeyHex: `0x${output.script.toString('hex')}`,
        amountSats: output.value.toString(),
        classification: 'recipient'
      })),
      signingInputIndexes: [0],
      totalInputSats: '50300',
      totalOutputSats: '50000',
      feeSats: '300'
    }
  }
  return { sender, recipient, prepared, graph, summary }
}

function review(selfTransfer = false) {
  const value = context(selfTransfer)
  return {
    graph: value.graph,
    review: {
      chainId,
      operation: 'transaction',
      summary: value.summary,
      payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprint },
      expiresAt: 5_000
    }
  }
}

function broadcastGraph() {
  const graph = structuredClone(context().graph)
  graph.root.status = 'broadcast'
  graph.segments[0].status = 'broadcast'
  graph.segments[0].evidence = {
    transactionHash: 'c'.repeat(64),
    confirmations: 0,
    requiredConfirmations: 6
  }
  return graph
}

function approvedGraph() {
  const graph = structuredClone(context().graph)
  graph.root.status = 'approved'
  graph.segments[0].status = 'approved'
  return graph
}

test('sends only a public Bitcoin intent and strictly binds the prepared review', async () => {
  const value = context()
  const messages = []
  const client = createBitcoinWalletClient(async message => {
    messages.push(message)
    return { result: review() }
  })

  await expect(
    client.prepareTransfer(
      {
        recipient: value.recipient.address,
        amount: { mode: 'exact', valueSats: '50000' }
      },
      { feeTier: 'low', bitcoinAddressType: 'p2tr' }
    )
  ).resolves.toMatchObject({
    graph: { root: { id: transactionId, status: 'prepared' } },
    review: { chainId, payloadFingerprint: { digestHex: fingerprint } }
  })
  expect(messages).toEqual([
    {
      type: 'PREPARE_BITCOIN_TRANSFER',
      intent: {
        recipient: value.recipient.address,
        amount: { mode: 'exact', valueSats: '50000' }
      },
      feeTier: 'low',
      bitcoinAddressType: 'p2tr'
    }
  ])
  expect(JSON.stringify(messages)).not.toContain('commandId')
})

test('reads the selected Bitcoin account identity from the trusted extension route', async () => {
  const sender = keyMaterial(1)
  const messages = []
  const client = createBitcoinWalletClient(async message => {
    messages.push(message)
    return {
      result: {
        chainId,
        address: sender.address,
        publicKey: `0x${sender.publicKey.toString('hex')}`,
        addressType: 'p2wpkh'
      }
    }
  })

  await expect(client.getActiveIdentity()).resolves.toEqual({
    chainId,
    address: sender.address,
    publicKey: `0x${sender.publicKey.toString('hex')}`,
    addressType: 'p2wpkh'
  })
  expect(messages).toEqual([{ type: 'GET_BITCOIN_WALLET_IDENTITY' }])

  const forged = createBitcoinWalletClient(async () => ({
    result: {
      chainId,
      address: sender.address,
      publicKey: `0x04${'11'.repeat(32)}`,
      addressType: 'p2wpkh'
    }
  }))
  await expect(forged.getActiveIdentity()).rejects.toMatchObject({ code: 'invalid-response' })
})

test('accepts a prepared self-transfer only when sender and recipient are the requested address', async () => {
  const value = context(true)
  const selfReview = review(true)
  const client = createBitcoinWalletClient(async () => ({ result: selfReview }))

  await expect(
    client.prepareTransfer({
      recipient: value.sender.address,
      amount: { mode: 'exact', valueSats: '50000' }
    })
  ).resolves.toMatchObject({
    graph: {
      root: {
        status: 'prepared',
        intent: {
          direction: 'self',
          sender: { address: value.sender.address },
          recipient: { address: value.sender.address }
        }
      }
    }
  })

  const forged = structuredClone(selfReview)
  forged.graph.root.intent.sender.address = keyMaterial(3).address
  const rejectingClient = createBitcoinWalletClient(async () => ({ result: forged }))
  await expect(
    rejectingClient.prepareTransfer({
      recipient: value.sender.address,
      amount: { mode: 'exact', valueSats: '50000' }
    })
  ).rejects.toMatchObject({ code: 'invalid-response' })
})

test('binds Bitcoin approval and activity to the exact local transaction', async () => {
  const graph = broadcastGraph()
  const messages = []
  const client = createBitcoinWalletClient(async message => {
    messages.push(message)
    if (message.type === 'GET_BITCOIN_ACTIVITY') {
      return {
        result: {
          scope: graph.root.scope,
          items: [
            {
              id: graph.root.id,
              source: 'wallet-v2',
              scope: graph.root.scope,
              kind: graph.root.kind,
              status: 'confirming',
              snapshot: graph.root.intent,
              segments: graph.segments.map(segment => ({
                id: segment.id,
                role: segment.role,
                target: segment.target,
                status: 'confirming',
                evidence: {
                  transactionHash: 'c'.repeat(64),
                  confirmations: 1,
                  requiredConfirmations: 6
                }
              })),
              completeness: 'complete',
              createdAt: 1_000,
              updatedAt: 2_000
            }
          ],
          partialItemCount: 0
        }
      }
    }
    return { result: { status: 'broadcast', graph } }
  })

  await expect(client.approveTransfer(transactionId, fingerprint)).resolves.toMatchObject({
    status: 'broadcast',
    graph: { root: { id: transactionId, status: 'broadcast' } }
  })
  await expect(client.getTransferActivity(graph)).resolves.toMatchObject({
    status: 'confirming',
    transactionHash: 'c'.repeat(64),
    confirmations: 1,
    requiredConfirmations: 6
  })
  expect(messages[0]).toEqual({
    type: 'APPROVE_BITCOIN_TRANSFER',
    transactionId,
    payloadFingerprint: fingerprint
  })
  expect(messages[1]).toEqual({ type: 'GET_BITCOIN_ACTIVITY', action: 'read' })
})

test('strictly binds Keystone handoff, PSBT retrieval and signed submission messages', async () => {
  const graph = approvedGraph()
  const signedPsbtBase64 = context().prepared.psbtBase64
  const messages = []
  const client = createBitcoinWalletClient(async message => {
    messages.push(message)
    if (message.type === 'APPROVE_BITCOIN_TRANSFER') {
      return {
        result: {
          status: 'external-signature-required',
          graph,
          transactionId,
          payloadFingerprint: fingerprint,
          expiresAt: 5_000
        }
      }
    }
    if (message.type === 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST') {
      return {
        result: {
          transactionId,
          scope: graph.root.scope,
          chainId,
          summary: context().summary,
          request: { encoding: 'base64', value: signedPsbtBase64 },
          payloadFingerprint: fingerprint,
          expiresAt: 5_000
        }
      }
    }
    return { result: { status: 'broadcast', graph: broadcastGraph() } }
  })

  await expect(client.approveTransfer(transactionId, fingerprint)).resolves.toMatchObject({
    status: 'external-signature-required',
    transactionId,
    graph: { root: { status: 'approved' } }
  })
  await expect(client.getExternalSigningRequest(transactionId)).resolves.toMatchObject({
    scope: graph.root.scope,
    chainId,
    summary: context().summary,
    request: { encoding: 'base64', value: signedPsbtBase64 }
  })
  await expect(
    client.submitExternalSignature(transactionId, fingerprint, signedPsbtBase64)
  ).resolves.toMatchObject({ status: 'broadcast' })
  expect(messages).toEqual([
    { type: 'APPROVE_BITCOIN_TRANSFER', transactionId, payloadFingerprint: fingerprint },
    { type: 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST', transactionId },
    {
      type: 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE',
      transactionId,
      payloadFingerprint: fingerprint,
      signedPsbtBase64
    }
  ])
})

test('loads a Ledger Bitcoin signing review from the approved external request', async () => {
  const value = context()
  const originalChrome = globalThis.chrome
  const messages = []
  globalThis.chrome = {
    runtime: {
      sendMessage: async message => {
        messages.push(message)
        return {
          result: {
            transactionId,
            scope: value.graph.root.scope,
            chainId,
            summary: value.summary,
            vendor: 'ledger',
            ledgerRequest: {
              kind: 'psbt',
              psbtBase64: value.prepared.psbtBase64,
              accountPath: "m/84'/0'/0'",
              masterFingerprintHex: '01020304',
              expectedAddress: value.sender.address,
              network: 'mainnet'
            },
            request: { encoding: 'base64', value: value.prepared.psbtBase64 },
            payloadFingerprint: fingerprint,
            expiresAt: Date.now() + 60_000
          }
        }
      }
    }
  }
  try {
    const view = await loadLedgerSigningView({ family: 'bitcoin', transactionId })
    expect(messages).toEqual([{ type: 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST', transactionId }])
    expect(view.scope).toEqual({ ...value.graph.root.scope, chainId })
    expect(view.summary).toEqual(value.summary)
    expect(view.request).toMatchObject({ kind: 'psbt', psbtBase64: value.prepared.psbtBase64 })
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('rejects Bitcoin response substitution, forged errors, and invalid public input', async () => {
  const value = context()
  const changed = review()
  changed.graph = structuredClone(changed.graph)
  changed.graph.root.intent.primaryAmount.amountRaw = '49999'
  const substituted = createBitcoinWalletClient(async () => ({ result: changed }))
  await expect(
    substituted.prepareTransfer({
      recipient: value.recipient.address,
      amount: { mode: 'exact', valueSats: '50000' }
    })
  ).rejects.toMatchObject({ code: 'invalid-response' })

  const forgedError = createBitcoinWalletClient(async () => ({
    error: { code: 'network-unavailable', message: 'private endpoint failed' }
  }))
  await expect(
    forgedError.prepareTransfer({ recipient: value.recipient.address, amount: { mode: 'max' } })
  ).rejects.toMatchObject({ code: 'invalid-response' })

  const noRequest = createBitcoinWalletClient(async () => {
    throw new Error('must not send')
  })
  await expect(
    noRequest.prepareTransfer({ recipient: 'not-bitcoin', amount: { mode: 'max' } })
  ).rejects.toMatchObject({ code: 'invalid-request' })
})
