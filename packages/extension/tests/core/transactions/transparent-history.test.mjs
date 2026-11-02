import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeNetReceivedZatoshis,
  mapVerboseTransactionToReceive,
  mergeTransactionsWithTransparentReceives
} from '../../../src/core/wallet/transparent-history.ts'

const account = {
  id: 'account-1',
  name: 'Account 1',
  addresses: {
    shielded: 'u1shielded',
    transparent: 't1wallet'
  },
  derivationIndex: 0,
  birthdayHeight: 0,
  isPinned: false,
  isHidden: false
}

function vout(address, valueZat, n = 0) {
  return { valueZat, n, scriptPubKey: { addresses: [address] } }
}

test('maps a confirmed receive into a transaction', () => {
  const tx = {
    txid: 'receive-tx',
    blocktime: 1_700_000_000,
    confirmations: 12,
    vin: [{ txid: 'external-funding', vout: 0 }],
    vout: [vout('t1wallet', 25_000_000)]
  }

  const transaction = mapVerboseTransactionToReceive(tx, new Map(), account, 'mainnet')

  assert.deepEqual(transaction, {
    id: 'rpc_treceive_receive-tx',
    txHash: 'receive-tx',
    status: 'success',
    confirmations: 12,
    requiredConfirmations: 10,
    type: 'receive',
    amount: '0.25',
    to: 't1wallet',
    from: '',
    fromType: 'transparent',
    fee: '0',
    timestamp: 1_700_000_000_000,
    network: 'mainnet'
  })
})

test('marks mempool receive as pending', () => {
  const tx = {
    txid: 'mempool-tx',
    time: 1_700_000_100,
    confirmations: 0,
    vout: [vout('t1wallet', 1000)]
  }

  const transaction = mapVerboseTransactionToReceive(tx, new Map(), account, 'mainnet')

  assert.equal(transaction?.status, 'pending')
  assert.equal(transaction?.amount, '0.00001')
})

test('keeps an externally received transparent output confirming until 10 blocks', () => {
  const tx = {
    txid: 'immature-receive',
    blocktime: 1_700_000_150,
    confirmations: 3,
    vin: [{ txid: 'external-funding', vout: 0 }],
    vout: [vout('t1wallet', 20_000_000)]
  }

  const transaction = mapVerboseTransactionToReceive(tx, new Map(), account, 'mainnet')

  assert.equal(transaction?.status, 'confirming')
  assert.equal(transaction?.confirmations, 3)
  assert.equal(transaction?.requiredConfirmations, 10)
})

test('excludes send-with-change via prevout resolution', () => {
  const fundingTx = {
    txid: 'funding-tx',
    vout: [vout('t1wallet', 63_863_000)]
  }
  const sendTx = {
    txid: 'send-tx',
    blocktime: 1_700_000_200,
    confirmations: 3,
    vin: [{ txid: 'funding-tx', vout: 0 }],
    vout: [vout('t1external', 63_000_000), vout('t1wallet', 828_000, 1)]
  }
  const prevouts = new Map([['funding-tx', fundingTx]])

  assert.equal(computeNetReceivedZatoshis(sendTx, prevouts, 't1wallet'), -63_035_000n)
  assert.equal(mapVerboseTransactionToReceive(sendTx, prevouts, account, 'mainnet'), null)
})

test('treats unknown prevouts as external funding', () => {
  const tx = {
    txid: 'mixed-tx',
    blocktime: 1_700_000_300,
    confirmations: 1,
    vin: [{ txid: 'unknown-external', vout: 2 }],
    vout: [vout('t1wallet', 35_000_000)]
  }

  const transaction = mapVerboseTransactionToReceive(tx, new Map(), account, 'mainnet')

  assert.equal(transaction?.amount, '0.35')
})

test('merges transparent receives without duplicating existing hashes', () => {
  const existing = [
    {
      id: 'tx_local',
      txHash: 'local-send',
      status: 'pending',
      type: 'send',
      amount: '0.1',
      to: 'external',
      from: 't1wallet',
      fromType: 'transparent',
      fee: '0',
      timestamp: 1,
      network: 'mainnet'
    },
    {
      id: 'wasm_existing',
      txHash: 'receive-tx',
      status: 'success',
      type: 'receive',
      amount: '0.25',
      to: 't1wallet',
      from: '',
      fromType: 'transparent',
      fee: '0',
      timestamp: 2,
      network: 'mainnet'
    }
  ]

  const merged = mergeTransactionsWithTransparentReceives(existing, [
    {
      id: 'rpc_treceive_receive-tx',
      txHash: 'receive-tx',
      status: 'success',
      type: 'receive',
      amount: '0.25',
      to: 't1wallet',
      from: '',
      fromType: 'transparent',
      fee: '0',
      timestamp: 3,
      network: 'mainnet'
    },
    {
      id: 'rpc_treceive_new-tx',
      txHash: 'new-tx',
      status: 'success',
      type: 'receive',
      amount: '0.5',
      to: 't1wallet',
      from: '',
      fromType: 'transparent',
      fee: '0',
      timestamp: 4,
      network: 'mainnet'
    }
  ])

  assert.deepEqual(
    merged.map(tx => tx.id),
    ['rpc_treceive_new-tx', 'rpc_treceive_receive-tx', 'tx_local']
  )
})
