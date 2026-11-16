import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleEvmWalletChoiceMessage } from '../../../../src/background/evm-wallet-choice.ts'

function event() {
  const listeners = new Set()
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => {
      for (const listener of [...listeners]) listener(...args)
    },
    get size() {
      return listeners.size
    }
  }
}

test('wallet selection follows its source window and enforces request lifecycle', async () => {
  const oldChrome = globalThis.chrome
  const removed = []
  const created = []
  globalThis.chrome = {
    runtime: { id: 'noir-test', getURL: path => `chrome-extension://noir-test/${path}` },
    storage: { local: { get: async () => ({ evm_wallet_preference: 'ask' }) } },
    windows: {
      onRemoved: event(),
      get: async id => {
        if (id === 77) {
          return { id, type: 'normal', left: -1600, top: -200, width: 1400 }
        }
        if (id === 78) return { id, type: 'popup', left: 100, top: 100, width: 1400 }
        throw new Error('Window unavailable')
      },
      create: async options => {
        created.push(options)
        return { id: 8, tabs: [{ id: 9 }] }
      },
      remove: async id => {
        removed.push(id)
      }
    },
    tabs: { onRemoved: event(), onUpdated: event() }
  }
  const chrome = globalThis.chrome
  const source = {
    id: 'noir-test',
    tab: { id: 4, windowId: 77, url: 'https://chainlist.test/' },
    frameId: 0,
    url: 'https://chainlist.test/',
    origin: 'https://chainlist.test'
  }
  const wallets = [
    { id: 'noir', name: 'Forged Noir label' },
    { id: 'wallet-other', name: 'Other' }
  ]
  const send = (message, sender) =>
    new Promise(resolve => {
      assert.equal(handleEvmWalletChoiceMessage(message, sender, resolve), true)
    })
  try {
    const pending = send({ type: 'REQUEST_EVM_WALLET_CHOICE', wallets }, source)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(created[0].left, -595)
    assert.equal(created[0].top, -100)
    const requestId = new URLSearchParams(created[0].url.split('?')[1]).get('requestId')
    const ui = { id: 'noir-test', url: created[0].url, tab: { id: 9, windowId: 8 } }
    const query = { type: 'GET_EVM_WALLET_CHOICE', requestId }
    assert.match(
      (await send({ type: 'REQUEST_EVM_WALLET_CHOICE', wallets }, source)).error,
      /already open/
    )
    assert.match((await send(query, source)).error, /no longer available/)
    assert.match(
      (await send(query, { ...ui, tab: { id: 10, windowId: 8 } })).error,
      /no longer available/
    )
    const request = (await send(query, ui)).result
    assert.equal(request.origin, 'https://chainlist.test')
    assert.equal(request.wallets[0].name, 'Noir Wallet')
    assert.match(
      (await send({ type: 'RESOLVE_EVM_WALLET_CHOICE', requestId, walletId: 'not-listed' }, ui))
        .error,
      /available wallet/
    )
    assert.deepEqual(
      await send({ type: 'RESOLVE_EVM_WALLET_CHOICE', requestId, walletId: 'wallet-other' }, ui),
      { result: true }
    )
    assert.deepEqual(await pending, { result: 'wallet-other' })
    const navigated = send(
      { type: 'REQUEST_EVM_WALLET_CHOICE', wallets },
      { ...source, tab: { ...source.tab, windowId: 79 } }
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(created[1].left, undefined)
    assert.equal(created[1].top, undefined)
    chrome.tabs.onUpdated.emit(4, { status: 'loading' })
    assert.match((await navigated).error, /website changed/)
    const closed = send(
      { type: 'REQUEST_EVM_WALLET_CHOICE', wallets },
      { ...source, tab: { ...source.tab, windowId: 78 } }
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(created[2].left, 1105)
    assert.equal(created[2].top, 200)
    chrome.windows.onRemoved.emit(8)
    assert.match((await closed).error, /cancelled/)
    assert.equal(chrome.tabs.onUpdated.size, 0)
    assert.equal(chrome.tabs.onRemoved.size, 0)
    assert.equal(chrome.windows.onRemoved.size, 0)
    assert.equal(removed.length, 3)
    const unauthorized = await send(
      { type: 'REQUEST_EVM_WALLET_CHOICE', wallets },
      { ...source, id: 'other-extension' }
    )
    assert.match(unauthorized.error, /Unauthorized/)
  } finally {
    chrome.tabs.onRemoved.emit(4)
    globalThis.chrome = oldChrome
  }
})
