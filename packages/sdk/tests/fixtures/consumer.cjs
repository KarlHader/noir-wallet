const assert = require('node:assert/strict')
const root = require('@noir-wallet/sdk')
const zcash = require('@noir-wallet/sdk/chains/zcash')

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

const api = new root.ZcashAPI({
  async request() {
    return null
  },
  on() {},
  async disconnect() {}
})
assert.equal(typeof api.connect, 'function')
