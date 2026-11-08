import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EvmDAppOriginRuntime } from '../../../src/background/evm-dapp-origin-runtime.ts'
import { CurrentDAppEvmNetworkCoordinator } from '../../../src/background/wallet-dapp-evm-networks.ts'

const first = 'https://first.example'
const second = 'https://second.example'
const eth = 'eip155:1'
const bnb = 'eip155:56'

function currentSiteSelection(origin = first) {
  return {
    origin,
    activeChainId: eth,
    options: [
      { chainId: eth, displayName: 'Ethereum', iconChain: 'ethereum' },
      { chainId: bnb, displayName: 'BNB Chain', iconChain: 'bnb' }
    ],
    selectionContext: {
      origin,
      walletId: 'wallet-1',
      accountId: 'account-1',
      networkMode: 'mainnet',
      activeChainId: eth,
      authorizationRevision: 1,
      authorizationSnapshot: 'grant-1',
      unlockEpoch: 'epoch-1',
      runtimeKey: 'runtime-1'
    }
  }
}

test('wallet site selection rejects a stale tab, account, or unlock context', async () => {
  let current = currentSiteSelection()
  const committed = []
  const coordinator = new CurrentDAppEvmNetworkCoordinator({
    read: async () => current,
    commit: async chainId => committed.push(chainId)
  })
  const context = current.selectionContext
  current = currentSiteSelection(second)
  await assert.rejects(coordinator.set(bnb, context), /context changed/)
  current = {
    ...currentSiteSelection(),
    selectionContext: { ...context, accountId: 'account-2' }
  }
  await assert.rejects(coordinator.set(bnb, context), /context changed/)
  current = {
    ...currentSiteSelection(),
    selectionContext: { ...context, unlockEpoch: 'epoch-2' }
  }
  await assert.rejects(coordinator.set(bnb, context), /context changed/)
  assert.deepEqual(committed, [])
})

test('wallet site selection rechecks authorization and target availability at commit', async () => {
  let current = currentSiteSelection()
  let committed = false
  const coordinator = new CurrentDAppEvmNetworkCoordinator({
    read: async () => current,
    commit: async (_chainId, _context, validate) => {
      current = {
        ...current,
        selectionContext: { ...current.selectionContext, authorizationRevision: 2 }
      }
      await validate()
      committed = true
    }
  })
  await assert.rejects(coordinator.set(bnb, current.selectionContext), /context changed/)
  assert.equal(committed, false)
  current = { ...currentSiteSelection(), options: currentSiteSelection().options.slice(0, 1) }
  await assert.rejects(coordinator.set(bnb, current.selectionContext), /context changed/)
  assert.equal(committed, false)
})

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(readChainId) {
  const chains = new Map([
    [first, eth],
    [second, eth]
  ])
  const runtime = new EvmDAppOriginRuntime({
    readChainId: readChainId ?? (async origin => chains.get(origin)),
    createHandler: chainId => ({
      active: true,
      getCaip2ChainId: () => chainId,
      deactivate() {
        this.active = false
      },
      async request() {
        return chainId
      }
    })
  })
  return { chains, runtime }
}

test('site network routing isolates another site and restores from persisted selection', async () => {
  const { chains, runtime } = fixture()
  const original = await runtime.get(first)
  const other = await runtime.get(second)
  assert.notEqual(original, other)
  chains.set(first, bnb)
  runtime.invalidate(first)
  assert.equal(await runtime.request({ method: 'eth_chainId' }, first, {}), bnb)
  assert.equal(await runtime.request({ method: 'eth_chainId' }, second, {}), eth)
  assert.equal(original.active, false)
  assert.equal(other.active, true)
  assert.equal(await runtime.get(second), other)
  const restored = fixture(async origin => chains.get(origin)).runtime
  assert.equal(await restored.request({ method: 'eth_chainId' }, first, {}), bnb)
})

test('a response from the previous site network cannot complete after switching', async () => {
  const { chains, runtime } = fixture()
  const pending = deferred()
  const started = deferred()
  const handler = await runtime.get(first)
  handler.request = async () => {
    started.resolve()
    return pending.promise
  }
  const response = runtime.request({ method: 'eth_getBalance' }, first, {})
  await started.promise
  chains.set(first, bnb)
  runtime.invalidate(first)
  await assert.rejects(response, error => error.code === 4901)
  pending.resolve('old-chain-result')
})

test('permission validation and dispatch cannot cross a site chain transition', async () => {
  const { chains, runtime } = fixture()
  const checked = deferred()
  const release = deferred()
  const handler = await runtime.get(first)
  let executed = false
  handler.request = async () => {
    executed = true
  }
  const response = runtime.request({ method: 'eth_sendTransaction' }, first, {}, async chainId => {
    assert.equal(chainId, eth)
    checked.resolve()
    await release.promise
  })
  await checked.promise
  chains.set(first, bnb)
  runtime.invalidate(first)
  release.resolve()
  await assert.rejects(response, error => error.code === 4901)
  assert.equal(executed, false)
})

test('storage reads pending during a switch cannot reinstall the old site handler', async () => {
  const oldRead = deferred()
  let stale = true
  const { runtime } = fixture(async () => (stale ? oldRead.promise : bnb))
  const pending = runtime.get(first)
  stale = false
  runtime.invalidate(first)
  oldRead.resolve(eth)
  assert.equal((await pending).getCaip2ChainId(), bnb)
})

test('runtime replacement rejects old reads without creating another handler', async () => {
  const storage = deferred()
  const { runtime } = fixture(async () => storage.promise)
  const pending = runtime.get(first)
  runtime.deactivate()
  storage.resolve(eth)
  await assert.rejects(pending, error => error.code === 4901)
})
