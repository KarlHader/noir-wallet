import assert from 'node:assert/strict'
import * as root from '@noir-wallet/sdk'
import * as zcash from '@noir-wallet/sdk/chains/zcash'

for (const name of ['getNoirWallet', 'isNoirWalletInstalled']) {
  assert.equal(typeof root[name], 'function', `root export ${name}`)
}
for (const name of [
  'getZcashProvider',
  'detectProvider',
  'ZcashAPI',
  'publicKeyToAddress',
  'verifyMessageSignature'
]) {
  assert.equal(typeof root[name], 'function', `root export ${name}`)
  assert.equal(typeof zcash[name], 'function', `subpath export ${name}`)
}

const api = new zcash.ZcashAPI({
  async request() {
    return null
  },
  on() {},
  async disconnect() {}
})
for (const name of [
  'connect',
  'getAccounts',
  'getBalance',
  'getMaxTransfer',
  'getAddresses',
  'getPublicKey',
  'sendTransaction',
  'signMessage',
  'shieldFunds',
  'switchNetwork',
  'checkLendingMcaAccount',
  'disconnect',
  'on',
  'removeListener'
]) {
  assert.equal(typeof api[name], 'function', `ZcashAPI.${name}`)
}
