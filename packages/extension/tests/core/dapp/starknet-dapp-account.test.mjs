import assert from 'node:assert/strict'
import { test } from 'node:test'

import { starknetDappAccountFromContext } from '../../../src/background/starknet-dapp-account.ts'

const address = '0x6a62e3abc08f1190cf071afeec31d1693f71c9f126e820b98d7017f133e6a27'
const publicKey = '0x7f0ecd1ec6159e6a7c70084aaa7d693d9113149b80ab72618602a185e2c1f2b'
const classHash = '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f'

function context(kind = 'hardware') {
  return {
    chainAccount: {
      identity: { kind: 'account-identifier', value: address },
      scope: { keyDomainId: 'key-domain:ledger', accountId: 'account:ledger' }
    },
    accountIndex: 0,
    addressIndex: 0,
    keyDomainSource: { kind },
    publicKey,
    classHash
  }
}

function ledgerAccount() {
  return {
    address: `0x0${address.slice(2)}`,
    publicKey,
    classHash,
    implementation: 'argent_v0_4',
    accountIndex: 0,
    addressIndex: 0,
    keyDomainId: 'key-domain:ledger',
    accountId: 'account:ledger',
    keySource: 'ledger'
  }
}

test('a cached Ledger account is selected without a wallet-store wallet', () => {
  const selected = starknetDappAccountFromContext(context(), ledgerAccount())
  assert.equal(selected?.keySource, 'ledger')
  assert.equal(selected?.implementation, 'argent_v0_4')
  assert.equal(selected?.address, ledgerAccount().address)
})

test('a Ledger context without a cached account is not projected as software', () => {
  assert.equal(starknetDappAccountFromContext(context(), null), null)
})

test('a software context is projected when the session cache is empty', () => {
  const selected = starknetDappAccountFromContext(context('software'), null)
  assert.equal(selected?.implementation, 'open_zeppelin')
  assert.equal(selected?.keySource, 'software')
  assert.equal(selected?.address, address)
})
