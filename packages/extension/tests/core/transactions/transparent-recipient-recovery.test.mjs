import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { safeBig } from '../../../src/lib/big.ts'
import { isTransparentZcashAddress } from '../../../src/lib/zcash-memo.ts'
import { getVerboseTransaction, mapWithConcurrency } from '../../../src/lib/zcash-node-rpc.ts'
import { normalizeTxHash } from '../../../src/lib/tx-history-dedup.ts'
import { partitionVerboseTransactions } from '../../../src/core/wallet/transparent-history-cache.ts'
import {
  getTransparentSendRecipient,
  mergeTransactionsWithWasmHistory
} from '../../../src/core/wallet/transparent-history.ts'

const require = createRequire(import.meta.url)
const typescript = require('typescript')
const source = readFileSync(
  new URL('../../../src/core/wallet/transparent-history.ts', import.meta.url),
  'utf8'
)
const { outputText } = typescript.transpileModule(source, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2022
  }
})

function recoveryWith(cache = {}) {
  const dependencies = {
    '../../config/wallet.ts': { ZEC_DECIMALS: 8 },
    '../../lib/big.ts': { safeBig },
    '../../lib/zcash-memo.ts': { isTransparentZcashAddress },
    '../../lib/zcash-node-rpc.ts': { getVerboseTransaction, mapWithConcurrency },
    '../../lib/tx-history-dedup.ts': { normalizeTxHash },
    './transparent-history-cache.ts': { partitionVerboseTransactions },
    '../../lib/indexed-db.ts': {
      loadTransparentTxCache: async () => cache,
      saveTransparentTxCache: async (_key, bodies, signal) => {
        signal?.throwIfAborted()
        Object.assign(cache, Object.fromEntries(bodies))
      }
    }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  return (transactions, signal) =>
    module.exports.fetchMissingTransparentSendRecipients(transactions, new Set(['t1Wallet']), {
      baseUrl: 'https://rpc.example.test',
      cacheKey: 'mainnet_wallet_account',
      signal
    })
}

const hash = 'ab'.repeat(32)
const send = {
  id: `wasm_${hash}`,
  txHash: hash,
  type: 'send',
  status: 'success',
  amount: '0.01',
  to: '',
  from: '',
  fromType: 'shielded',
  fee: '0.00015',
  timestamp: 1,
  network: 'mainnet',
  confirmations: 4,
  requiredConfirmations: 3
}
const output = (address, valueZat) => ({ valueZat, scriptPubKey: { addresses: [address] } })
const body = (vout = [output('t1Recipient', 1_000_000)]) => ({
  txid: hash,
  confirmations: 4,
  vout
})

test('recovers only a unique external transparent destination equal to the sent amount', () => {
  assert.equal(getTransparentSendRecipient(body(), send.amount, new Set()), 't1Recipient')
  assert.equal(
    getTransparentSendRecipient(
      body([
        output('t1Wallet', 2_000_000),
        output('t1Recipient', 400_000),
        output('t1Recipient', 600_000)
      ]),
      send.amount,
      new Set(['t1Wallet'])
    ),
    't1Recipient'
  )
  for (const transaction of [
    body([]),
    body([output('t1Recipient', 1_000_000), output('t1Other', 500_000)]),
    body([output('t1Recipient', 999_999)]),
    body([output('t1Wallet', 1_000_000)]),
    body([output('u1Shielded', 1_000_000)]),
    body([output('t1Recipient', 1.5)]),
    body([output('t1Recipient', -1)]),
    body([output('t1Recipient', Number.MAX_SAFE_INTEGER + 1)]),
    body([{ valueZat: 1_000_000, scriptPubKey: { addresses: ['t1One', 't1Two'] } }]),
    body([{ valueZat: 1_000_000 }]),
    body([null]),
    { txid: hash, vout: 'invalid' }
  ]) {
    assert.equal(
      getTransparentSendRecipient(transaction, send.amount, new Set(['t1Wallet'])),
      undefined
    )
  }
  assert.equal(getTransparentSendRecipient(body(), '0.010000001', new Set()), undefined)
})

test('WASM refresh preserves an approved or recovered recipient', () => {
  const approved = { ...send, id: 'tx_dapp', to: 't1Approved' }
  assert.deepEqual(mergeTransactionsWithWasmHistory([approved], [send], []).transactions, [
    approved
  ])
  const recovered = { ...send, to: 't1Recovered' }
  assert.deepEqual(mergeTransactionsWithWasmHistory([recovered], [send], []).transactions, [
    recovered
  ])
})

test('queries only missing recipients and reuses confirmed bodies', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return new Response(JSON.stringify({ result: body() }), { status: 200 })
  })
  const recover = recoveryWith()
  const candidates = [
    send,
    { ...send, id: 'duplicate' },
    { ...send, to: 't1Approved' },
    { ...send, type: 'receive' },
    { ...send, txHash: '' }
  ]
  assert.deepEqual([...(await recover(candidates))], [[hash, 't1Recipient']])
  assert.deepEqual([...(await recover([send]))], [[hash, 't1Recipient']])
  assert.equal((await recover([{ ...send, to: 't1Approved' }])).size, 0)
  assert.equal(calls, 1)
})

test('mismatched and transient responses retry; confirmed ambiguous bodies stay cached', async t => {
  let calls = 0
  let response = { result: { ...body(), txid: 'cd'.repeat(32) } }
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return new Response(JSON.stringify(response), { status: 200 })
  })
  const recover = recoveryWith()
  assert.equal((await recover([send])).size, 0)
  response = { error: { code: -5, message: 'No information available about transaction' } }
  assert.equal((await recover([send])).size, 0)
  response = { result: { ...body([]), confirmations: 0 } }
  assert.equal((await recover([send])).size, 0)
  response = { result: body([]) }
  assert.equal((await recover([send])).size, 0)
  assert.equal((await recover([send])).size, 0)
  assert.equal(calls, 4)
})

test('cancellation aborts the RPC and prevents cache persistence', async t => {
  const cache = {}
  const controller = new AbortController()
  let notifyStarted
  const started = new Promise(resolve => {
    notifyStarted = resolve
  })
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    notifyStarted()
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  })
  const pending = recoveryWith(cache)([send], controller.signal)
  await started
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(cache, {})
})
