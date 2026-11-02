import assert from 'node:assert/strict'
import test from 'node:test'

import { selectBitcoinCoins } from '../../../src/infrastructure/chains/bitcoin/bitcoin-coin-selection.ts'
import { collectBitcoinSpendableUtxos } from '../../../src/infrastructure/chains/bitcoin/bitcoin-spendable-utxos.ts'
import { bitcoinAccountRootFromPath } from '../../../src/infrastructure/chains/bitcoin/bitcoin-transaction-model.ts'
import { assertBitcoinDiscoveryTargetExtension } from '../../../src/infrastructure/chains/bitcoin/bitcoin-discovery-persistence-progress.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'

function utxo(digit, root) {
  return {
    chainId,
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    address,
    derivationPath: `${root}/0/0`,
    publicKey: `0x02${'1'.repeat(64)}`,
    transactionId: digit.repeat(64),
    outputIndex: 0,
    valueSats: '100000',
    blockHeight: 1
  }
}

test('keeps the Ledger device account root independent of the logical account index', () => {
  const root = "m/84'/0'/5'"
  assert.equal(bitcoinAccountRootFromPath(`${root}/1/7`, chainId, 'p2wpkh', true, 7), root)
  const selection = selectBitcoinCoins({
    chainId,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: address,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [utxo('a', root)]
  })
  assert.equal(selection.selectedUtxos[0].derivationPath, `${root}/0/0`)
  assert.throws(
    () =>
      selectBitcoinCoins({
        chainId,
        accountIndex: 0,
        addressType: 'p2wpkh',
        recipient: address,
        amount: { mode: 'max' },
        feeRateSatsPerVbyte: 2,
        utxos: [utxo('a', root), utxo('b', "m/84'/0'/6'")]
      }),
    /different accounts/
  )
})

test('rejects a mismatched Bitcoin network or child path', () => {
  assert.throws(
    () => bitcoinAccountRootFromPath("m/84'/1'/5'/0/0", chainId, 'p2wpkh', false, 0),
    /Invalid Bitcoin derivation path/
  )
  assert.throws(
    () => bitcoinAccountRootFromPath("m/84'/0'/5'/1/0", chainId, 'p2wpkh', false, 0),
    /Invalid Bitcoin derivation path/
  )
})

test('collects all Ledger account children and rejects a foreign root', () => {
  const root = "m/84'/0'/5'"
  const observation = (change, index, digit, candidateRoot = root) => ({
    derived: {
      ...utxo(digit, candidateRoot),
      change,
      addressIndex: index,
      derivationPath: `${candidateRoot}/${change ? 1 : 0}/${index}`
    },
    utxos: [
      {
        transactionId: digit.repeat(64),
        outputIndex: 0,
        valueRaw: '100000',
        status: { confirmed: true, blockHeight: 1 }
      }
    ]
  })
  const children = [
    observation(false, 0, 'a'),
    observation(false, 1, 'b'),
    observation(true, 0, 'c')
  ]
  assert.equal(collectBitcoinSpendableUtxos(children, 'p2wpkh').length, 1)
  assert.equal(collectBitcoinSpendableUtxos(children, 'p2wpkh', root).length, 3)
  assert.throws(
    () =>
      collectBitcoinSpendableUtxos(
        [...children, observation(true, 1, 'd', "m/84'/0'/6'")],
        'p2wpkh',
        root
      ),
    /another account/
  )
})

test('upgrades a fixed Ledger checkpoint only while preserving its observed child', () => {
  const receive = { addressType: 'p2wpkh', change: false }
  const change = { addressType: 'p2wpkh', change: true }
  const previous = {
    chainId,
    accountIndex: 0,
    gapLimit: 1,
    maximumAddressesPerTarget: 1,
    cursors: [{ target: receive, nextAddressIndex: 1, consecutiveUnused: 0, complete: true }]
  }
  const next = {
    ...previous,
    gapLimit: 20,
    maximumAddressesPerTarget: 1000,
    cursors: [
      { target: receive, nextAddressIndex: 1, consecutiveUnused: 0, complete: false },
      { target: change, nextAddressIndex: 0, consecutiveUnused: 0, complete: false }
    ]
  }
  const observations = [
    {
      derived: { addressType: 'p2wpkh', change: false, addressIndex: 0 },
      activity: { used: true }
    }
  ]
  assert.doesNotThrow(() => assertBitcoinDiscoveryTargetExtension(previous, next, observations))
  assert.throws(
    () =>
      assertBitcoinDiscoveryTargetExtension(
        previous,
        {
          ...next,
          cursors: [{ ...next.cursors[0], nextAddressIndex: 0 }, next.cursors[1]]
        },
        observations
      ),
    /changed an existing cursor/
  )
  const interrupted = {
    ...previous,
    cursors: [
      ...previous.cursors,
      {
        target: change,
        nextAddressIndex: 0,
        consecutiveUnused: 0,
        complete: false
      }
    ]
  }
  assert.doesNotThrow(() => assertBitcoinDiscoveryTargetExtension(interrupted, next, observations))
  assert.throws(
    () =>
      assertBitcoinDiscoveryTargetExtension(
        interrupted,
        {
          ...next,
          cursors: [next.cursors[0], { ...next.cursors[1], nextAddressIndex: 1 }]
        },
        observations
      ),
    /changed an existing cursor/
  )
})

test('widens a Ledger gap while preserving observed children and reopening completed cursors', () => {
  const receive = { addressType: 'p2wpkh', change: false }
  const change = { addressType: 'p2wpkh', change: true }
  const previous = {
    chainId,
    accountIndex: 0,
    gapLimit: 20,
    maximumAddressesPerTarget: 1000,
    cursors: [receive, change].map(target => ({
      target,
      nextAddressIndex: 20,
      consecutiveUnused: 20,
      complete: true
    }))
  }
  const next = {
    ...previous,
    gapLimit: 21,
    cursors: previous.cursors.map(cursor => ({ ...cursor, complete: false }))
  }
  assert.doesNotThrow(() => assertBitcoinDiscoveryTargetExtension(previous, next))
  assert.throws(
    () =>
      assertBitcoinDiscoveryTargetExtension(previous, {
        ...next,
        cursors: [next.cursors[0], { ...next.cursors[1], nextAddressIndex: 19 }]
      }),
    /changed its scan policy/
  )
})
