import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  orderShieldedReceiveAddresses,
  selectShieldedReceiveAddress
} from '../../../src/core/wallet/shielded-address-history.ts'
import {
  isTrustedRuntimeMessageSender,
  parseTrustedExtensionRuntimeMessage
} from '../../../src/lib/runtime-message-security.ts'

const older = { shielded: 'u1-older', fullUnified: 'u1-older-full' }
const latest = { shielded: 'u1-latest', fullUnified: 'u1-latest-full' }
const testnet = { shielded: 'utest1-other', fullUnified: 'utest1-other-full' }
function account() {
  const mainnet = { transparent: 't1-receive', ...latest }
  return {
    id: 'account',
    name: 'Account 1',
    derivationIndex: 0,
    birthdayHeight: 100,
    isPinned: false,
    isHidden: false,
    addresses: mainnet,
    networkAddresses: { mainnet, testnet: { transparent: 'tm-receive', ...testnet } },
    networkShieldedReceiveAddressHistory: { mainnet: [older, latest], testnet: [testnet] }
  }
}

test('selecting an earlier shielded address preserves its unified form and transparent address', () => {
  const source = account()
  const before = structuredClone(source)
  assert.deepEqual(selectShieldedReceiveAddress(source, 'mainnet', older.shielded), {
    transparent: 't1-receive',
    ...older
  })
  assert.deepEqual(source, before)
  assert.deepEqual(
    selectShieldedReceiveAddress(source, 'mainnet', latest.shielded),
    source.addresses
  )
})

test('selection rejects addresses from another account or network', () => {
  for (const shielded of ['u1-another-account', testnet.shielded, '', latest.fullUnified]) {
    assert.throws(() => selectShieldedReceiveAddress(account(), 'mainnet', shielded), /history/)
  }
  assert.throws(() => selectShieldedReceiveAddress(account(), 'testnet', older.shielded), /history/)
  const source = account()
  delete source.networkAddresses.testnet
  assert.throws(() => selectShieldedReceiveAddress(source, 'testnet', testnet.shielded), /network/)
})

test('history shows the current selection first and keeps the latest address selectable', () => {
  const source = account()
  const selected = selectShieldedReceiveAddress(source, 'mainnet', older.shielded)
  assert.deepEqual(orderShieldedReceiveAddresses([older, latest, older], selected), [older, latest])
  assert.deepEqual(orderShieldedReceiveAddresses([older, latest], source.addresses), [
    latest,
    older
  ])
  assert.deepEqual(orderShieldedReceiveAddresses([], source.addresses), [latest])
})

test('shielded address selection accepts only a scoped request from an extension page', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop'
  const message = {
    type: 'SET_ZCASH_SHIELDED_ADDRESS',
    walletId: 'wallet',
    accountId: 'account',
    shielded: older.shielded
  }
  assert.deepEqual(parseTrustedExtensionRuntimeMessage(message), message)
  assert.equal(
    isTrustedRuntimeMessageSender(
      message.type,
      {
        id,
        url: `chrome-extension://${id}/index.html`
      },
      id
    ),
    true
  )
  for (const sender of [
    { id, url: 'https://dapp.example/' },
    { id, url: `chrome-extension://${id}/offscreen.html` },
    { id: 'another-extension', url: `chrome-extension://${id}/index.html` }
  ]) {
    assert.equal(isTrustedRuntimeMessageSender(message.type, sender, id), false)
  }
  for (const patch of [
    { shielded: '' },
    { shielded: 1 },
    { accountId: undefined },
    { network: 'testnet' },
    { fullUnified: 'u1-untrusted-full' }
  ]) {
    assert.throws(() => parseTrustedExtensionRuntimeMessage({ ...message, ...patch }))
  }
})
