import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { findWasmAccountIdByHdIndex } from '../../../src/core/worker/account-resolution.ts'

const require = createRequire(import.meta.url)
const typescript = require('typescript')

function loadWalletCore(client) {
  const source = readFileSync(
    new URL('../../../src/core/zcash/wallet-core.ts', import.meta.url),
    'utf8'
  )
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    }
  })
  const module = { exports: {} }
  const dependencies = {
    '../worker/client': { getWorkerClient: () => client },
    '@/lib/runtime-network': { getNetworkConfig: () => ({ rpcUrl: 'http://localhost' }) },
    '@/lib/big': {
      safeBig: value => ({
        times: multiplier => ({ toFixed: () => String(Number(value) * multiplier) }),
        lte: other => Number(value) <= other
      })
    },
    '@/lib/logger': { logger: { log() {}, warn() {}, error() {} } },
    './shielding': {
      getShieldableTransparentBalance: balance => balance.shieldable,
      getShieldInputAmountFromHistory: () => null
    }
  }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  const core = new module.exports.ZcashWalletCore({
    walletId: 'wallet-a',
    network: 'mainnet',
    lightwalletdUrl: 'http://localhost'
  })
  core.seedPhrase = 'test phrase'
  core.accountId = 11
  core.accountIndex = 0
  return core
}

test('worker resolves the approved HD index even when the active WASM account is different', async () => {
  const queried = []
  const accountId = await findWasmAccountIdByHdIndex(
    [
      [11, {}],
      [22, {}]
    ],
    0,
    async id => {
      queried.push(id)
      return id === 11 ? 0 : 1
    }
  )
  assert.equal(accountId, 11)
  assert.deepEqual(queried, [11])
  assert.equal(await findWasmAccountIdByHdIndex([[22, {}]], 0, async () => 1), null)
})

test('shared wallet core sends the approved account after its active account changes', async () => {
  const requests = []
  let wasmAccountId
  const core = loadWalletCore({
    async sendTransaction(request) {
      requests.push(request)
      wasmAccountId = await findWasmAccountIdByHdIndex(
        [
          [11, {}],
          [22, {}]
        ],
        request.accountIndex,
        async id => (id === 11 ? 0 : 1)
      )
      return { txHash: 'synthetic-hash' }
    }
  })
  core.accountId = 22
  core.accountIndex = 1
  await core.sendTransaction(
    { to: 't1-recipient', amount: '1', fundingSource: 'shielded' },
    undefined,
    0
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].accountIndex, 0)
  assert.equal(requests[0].accountId, undefined)
  assert.equal(requests[0].seedPhrase, 'test phrase')
  assert.equal(wasmAccountId, 11)
})

test('shared wallet core shields and reads balance from the approved account after a switch', async () => {
  const balanceReads = []
  const shieldRequests = []
  let shieldedWasmAccountId
  let releaseBalance
  let signalBalance
  const balanceStarted = new Promise(resolve => {
    signalBalance = resolve
  })
  const balanceGate = new Promise(resolve => {
    releaseBalance = resolve
  })
  const client = {
    async getAccountIds() {
      return [11, 22]
    },
    async getAccountHdIndex(id) {
      return id === 11 ? 0 : 1
    },
    async getBalance(id) {
      balanceReads.push(id)
      signalBalance()
      await balanceGate
      return { shieldable: '1', shielded: '0' }
    },
    async oneClickShield(request) {
      shieldRequests.push(request)
      shieldedWasmAccountId = await findWasmAccountIdByHdIndex(
        [
          [11, {}],
          [22, {}]
        ],
        request.accountIndex,
        async id => (id === 11 ? 0 : 1)
      )
      return 'synthetic-txid'
    },
    async getTransactionHistory() {
      return []
    }
  }
  const core = loadWalletCore(client)
  const shielding = core.shieldFunds(5000, 0)
  await balanceStarted
  core.accountId = 22
  core.accountIndex = 1
  releaseBalance()
  assert.equal((await shielding).txid, 'synthetic-txid')
  assert.deepEqual(balanceReads, [11])
  assert.equal(shieldRequests[0].accountIndex, 0)
  assert.equal(shieldRequests[0].accountId, undefined)
  assert.equal(shieldedWasmAccountId, 11)
})

test('message signing retains the approved HD account when its active core account changes', async () => {
  const requests = []
  const core = loadWalletCore({
    async signMessage(request) {
      requests.push(request)
      return {
        signature: 'synthetic-signature',
        pubkey: 'synthetic-key',
        address: 'synthetic-address'
      }
    }
  })
  core.accountIndex = 1

  await core.signMessage('synthetic message', 0, 0)

  assert.equal(requests.length, 1)
  assert.equal(requests[0].accountIndex, 0)
  assert.equal(requests[0].addressIndex, 0)
})
