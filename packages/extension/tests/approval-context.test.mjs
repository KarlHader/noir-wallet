import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const feeQuote = { id: 'bound-quote', standardMarginalFeeZats: 1000, expiresAt: 300000 }
const ts = require('typescript')
function load(path, dependencies = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    name => dependencies[name] ?? {},
    module,
    module.exports
  )
  return module.exports
}

function harness(t) {
  const { pendingRequestsManager: pending } = load('../src/background/pending-requests.ts')
  t.after(() => pending.cancelMatching(() => true))
  const state = {
    currentNetwork: 'mainnet',
    currentAccountId: 'a',
    getAccount: (walletId, accountId) =>
      walletId === 'w' && ['a', 'b'].includes(accountId)
        ? { id: accountId, derivationIndex: accountId === 'a' ? 3 : 9 }
        : null
  }
  let revision = 0
  let locked = false
  const estimates = []
  const accountManager = {
    isLocked: () => locked,
    async getWalletCore(walletId, accountId) {
      estimates.push({ walletId, accountId })
      return {
        async estimateTransferFee() {
          return '10000'
        },
        async estimateShieldFee() {
          return '15000'
        }
      }
    }
  }
  const api = load('../src/background/approval-context.ts', {
    './pending-requests': { pendingRequestsManager: pending },
    '@/core/dapp/dapp-manager': {
      dappManager: {
        getAuthorizationRevision: async () => revision,
        getAuthorizedAccounts: async () => [{ walletId: 'w', accountId: 'a' }]
      }
    },
    '@/core/wallet/account-manager': { accountManager },
    '@/store/wallet-store': {
      rehydrateWalletStore: async () => {},
      useWalletStore: { getState: () => state }
    },
    '@/config/fee': { marginalFeeForTier: (tier, rate) => rate * (tier === 'fast' ? 4 : 1) },
    '@/lib/big': { safeBig: value => new (require('big.js'))(value) },
    '@/core/worker/client': {
      getWorkerClient: walletId => ({
        async getFeeQuote(_accountId, accountIndex) {
          estimates.push({ walletId, quoteAccountIndex: accountIndex })
          return feeQuote
        },
        async estimateTransferFee(params) {
          estimates.push({
            walletId,
            accountIndex: params.accountIndex,
            rate: params.marginalFeeZats,
            quoteId: params.feeQuoteId
          })
          return {
            feeZats: String(params.marginalFeeZats * 2),
            marginalFeeZats: String(params.marginalFeeZats),
            feeQuote
          }
        },
        async estimateShieldFee(params) {
          estimates.push({ walletId, accountIndex: params.accountIndex })
          return { feeZats: '15000', marginalFeeZats: String(params.marginalFeeZats), feeQuote }
        }
      })
    }
  })
  const id = pending.create(
    'https://site.example',
    'sendTransaction',
    { to: 'synthetic-recipient', amount: '1' },
    'w',
    'a',
    'mainnet',
    0
  )
  return {
    ...api,
    pending,
    state,
    accountManager,
    id,
    estimates,
    revoke: () => {
      revision++
    },
    lock: () => {
      locked = true
    }
  }
}

test('approval lookup and fee estimation keep the captured account through switch and reload', async t => {
  const h = harness(t)
  assert.equal((await h.getApprovalContext(h.id)).accountId, 'a')
  h.state.currentAccountId = 'b'
  assert.equal((await h.getApprovalContext(h.id)).accountId, 'a')
  // A refreshed approval page reads the same backend-owned context again.
  assert.equal((await h.getApprovalContext(h.id)).accountId, 'a')
  assert.deepEqual(await h.estimateApprovalFee(h.id), {
    fee: '2000',
    marginalFeeZats: '1000',
    feeQuote
  })
  assert.deepEqual(h.estimates, [
    { walletId: 'w', accountId: 'a' },
    { walletId: 'w', quoteAccountIndex: 3 },
    { walletId: 'w', accountIndex: 3, rate: 1000, quoteId: 'bound-quote' }
  ])
})

test('Fast approval estimation uses the bound account recommendation', async t => {
  const h = harness(t)
  h.state.currentAccountId = 'b'
  assert.deepEqual(await h.estimateApprovalFee(h.id, { feeTier: 'fast' }), {
    fee: '8000',
    marginalFeeZats: '4000',
    feeQuote
  })
  assert.deepEqual(h.estimates.at(-1), {
    walletId: 'w',
    accountIndex: 3,
    rate: 4000,
    quoteId: 'bound-quote'
  })
  await assert.rejects(
    h.estimateApprovalFee(h.id, { feeTier: 'arbitrary' }),
    /Invalid network fee tier/
  )
})

for (const change of ['revoke', 'lock', 'delete', 'network', 'cancel']) {
  test(`approval becomes unusable after ${change}`, async t => {
    const h = harness(t)
    if (change === 'revoke') h.revoke()
    if (change === 'lock') h.lock()
    if (change === 'delete') h.state.getAccount = () => null
    if (change === 'network') h.state.currentNetwork = 'testnet'
    if (change === 'cancel') h.pending.cancel(h.id)
    await assert.rejects(h.estimateApprovalFee(h.id), /changed|expired/)
    assert.equal(h.estimates.length, 0)
    assert.equal(h.pending.get(h.id), null)
  })
}

test('revocation while readiness is pending prevents fee work', async t => {
  const h = harness(t)
  h.accountManager.getWalletCore = async () => {
    h.revoke()
    return {}
  }
  await assert.rejects(h.estimateApprovalFee(h.id), /changed/)
})

test('cancelling an origin settles its pending approvals once and leaves other sites alone', t => {
  const h = harness(t)
  const other = h.pending.create('https://other.example', 'connect', {}, 'w', 'a', 'mainnet', 0)
  let cancelled = 0
  h.pending.onCancel(h.id, () => cancelled++)
  h.pending.cancelMatching(request => request.origin === 'https://site.example')
  h.pending.cancel(h.id)
  assert.equal(cancelled, 1)
  assert.ok(h.pending.get(other))
})
