import assert from 'node:assert/strict'
import test from 'node:test'
import { TransactionRecipientRecovery } from '../../../src/background/transaction-recipient-recovery.ts'

const hash = 'ab'.repeat(32)
const send = { id: 'restored', type: 'send', txHash: hash, amount: '0.01', to: '' }
function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(lookup) {
  const records = new Map([
    ['mainnet_wallet_account', [send]],
    ['mainnet_other_account', [send]]
  ])
  const notices = []
  let active = true
  let mutations = 0
  const recovery = new TransactionRecipientRecovery({
    isActive: () => active,
    getOwnedAddresses: () => new Set(['t1Owned']),
    load: async key => records.get(key) || [],
    lookup,
    mutate: async (key, update) => {
      mutations += 1
      records.set(key, update(records.get(key) || []))
    },
    notify: async key => {
      notices.push(key)
    }
  })
  return {
    recovery,
    records,
    notices,
    deactivate: () => {
      active = false
    },
    mutations: () => mutations
  }
}

test('concurrent refreshes share a lookup and publish one recipient update', async () => {
  const started = deferred()
  const result = deferred()
  let lookups = 0
  const state = fixture(async () => {
    lookups += 1
    started.resolve()
    return result.promise
  })
  const first = state.recovery.recover('mainnet', 'wallet', 'account')
  await started.promise
  const second = state.recovery.recover('mainnet', 'wallet', 'account')
  result.resolve(new Map([[hash, 't1Recipient']]))
  await Promise.all([first, second])
  assert.equal(lookups, 1)
  assert.equal(state.records.get('mainnet_wallet_account')[0].to, 't1Recipient')
  assert.deepEqual(state.notices, ['mainnet_wallet_account'])
})

test('cancelled account cannot persist a late response while a sibling lookup completes', async () => {
  const started = deferred()
  const result = deferred()
  const signals = new Map()
  const state = fixture(async (_txs, _owned, _network, key, signal) => {
    signals.set(key, signal)
    if (signals.size === 2) started.resolve()
    return result.promise
  })
  const first = state.recovery.recover('mainnet', 'wallet', 'account')
  const sibling = state.recovery.recover('mainnet', 'other', 'account')
  await started.promise
  state.recovery.cancel('wallet', 'account')
  assert.equal(signals.get('mainnet_wallet_account').aborted, true)
  assert.equal(signals.get('mainnet_other_account').aborted, false)
  result.resolve(new Map([[hash, 't1Recipient']]))
  await Promise.all([first, sibling])
  assert.equal(state.records.get('mainnet_wallet_account')[0].to, '')
  assert.equal(state.records.get('mainnet_other_account')[0].to, 't1Recipient')
  assert.deepEqual(state.notices, ['mainnet_other_account'])
})

test('lock, removal, or changed network prevents late writes even without a cancellable lookup', async () => {
  const started = deferred()
  const result = deferred()
  const state = fixture(async () => {
    started.resolve()
    return result.promise
  })
  const pending = state.recovery.recover('mainnet', 'wallet', 'account')
  await started.promise
  state.deactivate()
  result.resolve(new Map([[hash, 't1Recipient']]))
  await pending
  assert.equal(state.mutations(), 0)
  assert.equal(state.records.get('mainnet_wallet_account')[0].to, '')
  assert.deepEqual(state.notices, [])
})

test('late recovery retains a recipient supplied concurrently and rejects changed amounts', async () => {
  for (const update of [{ to: 't1Approved' }, { amount: '0.02' }]) {
    const started = deferred()
    const result = deferred()
    const state = fixture(async () => {
      started.resolve()
      return result.promise
    })
    const pending = state.recovery.recover('mainnet', 'wallet', 'account')
    await started.promise
    state.records.set('mainnet_wallet_account', [{ ...send, ...update }])
    result.resolve(new Map([[hash, 't1Recovered']]))
    await pending
    assert.deepEqual(state.records.get('mainnet_wallet_account')[0], { ...send, ...update })
    assert.deepEqual(state.notices, [])
  }
})

test('a cancelled lookup releases its account so the next unlocked refresh can retry', async () => {
  const started = deferred()
  let calls = 0
  const state = fixture(async (_txs, _owned, _network, _key, signal) => {
    calls += 1
    if (calls === 1) {
      started.resolve()
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    }
    return new Map([[hash, 't1Recipient']])
  })
  const interrupted = state.recovery.recover('mainnet', 'wallet', 'account')
  await started.promise
  state.recovery.cancel()
  await interrupted
  await state.recovery.recover('mainnet', 'wallet', 'account')
  assert.equal(calls, 2)
  assert.equal(state.records.get('mainnet_wallet_account')[0].to, 't1Recipient')
})
