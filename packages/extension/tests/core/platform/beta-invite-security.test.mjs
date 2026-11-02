import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isTrustedRuntimeMessageSender,
  parseTrustedExtensionRuntimeMessage
} from '../../../src/lib/runtime-message-security.ts'
import { resolveUnactivatedBetaDAppRequest } from '../../../src/core/dapp/beta-invite-policy.ts'

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'

test('invite activation messages accept only extension pages and cannot supply a binding address', () => {
  const popup = { id: extensionId, url: `chrome-extension://${extensionId}/index.html` }
  const untrusted = [
    { id: extensionId, url: 'https://dapp.example/' },
    { id: extensionId, url: `chrome-extension://${extensionId}/offscreen.html` },
    { id: extensionId, url: `chrome-extension://${extensionId}/service-worker-loader.js` },
    { id: 'other-extension', url: `chrome-extension://${extensionId}/index.html` }
  ]
  for (const message of [
    { type: 'GET_BETA_INVITE_ACTIVATION' },
    { type: 'CHECK_BETA_INVITE_CODE', inviteCode: ' TEST-code ' },
    { type: 'BIND_BETA_INVITE_WALLET' }
  ]) {
    assert.deepEqual(parseTrustedExtensionRuntimeMessage(message), message)
    assert.equal(isTrustedRuntimeMessageSender(message.type, popup, extensionId), true)
    for (const sender of untrusted) {
      assert.equal(isTrustedRuntimeMessageSender(message.type, sender, extensionId), false)
    }
    assert.throws(() => parseTrustedExtensionRuntimeMessage({ ...message, wallet_address: '0x1' }))
    assert.throws(() => parseTrustedExtensionRuntimeMessage({ ...message, walletId: 'wallet:1' }))
  }
  for (const inviteCode of ['', null, 1234, 'x'.repeat(4097)]) {
    assert.throws(() =>
      parseTrustedExtensionRuntimeMessage({ type: 'CHECK_BETA_INVITE_CODE', inviteCode })
    )
  }
})

test('unactivated saved dApp connections expose neither accounts nor sessions', () => {
  for (const [family, method, result] of [
    ['zcash', 'zcash_getAccounts', null],
    ['evm', 'eth_accounts', []],
    ['bitcoin', 'getAccounts', []],
    ['solana', 'getAccounts', []],
    ['near', 'getAccounts', []],
    ['multichain', 'wallet_getSession', null]
  ]) {
    assert.deepEqual(resolveUnactivatedBetaDAppRequest(family, method), { kind: 'silent', result })
  }
})

test('connect requests wait for activation and wallet operations cannot use existing grants', () => {
  for (const [family, method] of [
    ['zcash', 'zcash_requestAccounts'],
    ['evm', 'eth_requestAccounts'],
    ['evm', 'wallet_requestPermissions'],
    ['bitcoin', 'connect'],
    ['solana', 'connect'],
    ['near', 'requestAccounts'],
    ['multichain', 'wallet_createSession']
  ]) {
    assert.equal(resolveUnactivatedBetaDAppRequest(family, method).kind, 'activate')
  }
  for (const [family, method] of [
    ['zcash', 'zcash_signMessage'],
    ['zcash', 'zcash_getBalance'],
    ['evm', 'eth_sendTransaction'],
    ['evm', 'personal_sign'],
    ['bitcoin', 'signPsbt'],
    ['solana', 'signAndSendTransaction'],
    ['near', 'signMessage'],
    ['multichain', 'wallet_invokeMethod']
  ]) {
    assert.equal(resolveUnactivatedBetaDAppRequest(family, method).kind, 'reject')
  }
})
