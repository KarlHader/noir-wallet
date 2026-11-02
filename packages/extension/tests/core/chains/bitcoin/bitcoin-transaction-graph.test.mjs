import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { initEccLib, networks, payments } from 'bitcoinjs-lib'

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

initEccLib(secp256k1)

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledBitcoinAssetDefinitions('mainnet'))

function keyMaterial(digit) {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = digit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const address = payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin }).address
  if (!address) throw new Error('Unable to derive Bitcoin test address')
  return { publicKey, address }
}

function preparedTransfer() {
  const sender = keyMaterial(1)
  const recipient = keyMaterial(2)
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
        transactionId: 'a'.repeat(64),
        outputIndex: 0,
        valueSats: '50300',
        blockHeight: 899_999
      }
    ]
  })
  return {
    sender: sender.address,
    prepared: buildBitcoinPsbt({
      selection,
      masterFingerprint: '0x01020304',
      lockTime: 900_000
    })
  }
}

test('creates an immutable BTC transfer snapshot with an explicit finality policy', () => {
  const { sender, prepared } = preparedTransfer()
  const graph = createBitcoinTransferGraph({
    prepared,
    sender,
    scope: { keyDomainId: 'key-domain:bitcoin', accountId: 'account:bitcoin:0' },
    transactionId: parseTransactionId('transaction:bitcoin:graph'),
    segmentId: parseTransactionSegmentId('segment:bitcoin:graph'),
    chainAccountId: 'chain-account:bitcoin:0',
    assets,
    requiredConfirmations: 6,
    createdAt: 1_000
  })

  expect(graph).toMatchObject({
    root: {
      status: 'prepared',
      intent: {
        direction: 'outgoing',
        primaryAmount: { assetId: `${chainId}/slip44:0`, amountRaw: '50000' },
        feeLimit: { assetId: `${chainId}/slip44:0`, amountRaw: prepared.feeSats },
        sender: { chainId, address: sender },
        recipient: { chainId, address: prepared.recipient }
      }
    },
    segments: [
      {
        status: 'prepared',
        target: { kind: 'onchain', chainId, chainAccountId: 'chain-account:bitcoin:0' },
        evidence: { requiredConfirmations: 6 }
      }
    ]
  })
})

test('rejects unsupported finality and sender bindings before persistence', () => {
  const { sender, prepared } = preparedTransfer()
  const input = {
    prepared,
    sender,
    scope: { keyDomainId: 'key-domain:bitcoin', accountId: 'account:bitcoin:0' },
    transactionId: parseTransactionId('transaction:bitcoin:invalid'),
    segmentId: parseTransactionSegmentId('segment:bitcoin:invalid'),
    assets,
    requiredConfirmations: 6,
    createdAt: 1_000
  }
  expect(() => createBitcoinTransferGraph({ ...input, requiredConfirmations: 0 })).toThrow(
    /finality confirmation/
  )
  expect(() => createBitcoinTransferGraph({ ...input, sender: prepared.recipient })).not.toThrow()
  expect(() => createBitcoinTransferGraph({ ...input, sender: `${sender.slice(0, -1)}x` })).toThrow(
    /Bitcoin address/
  )
})
