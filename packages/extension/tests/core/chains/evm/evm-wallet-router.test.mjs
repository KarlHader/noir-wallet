import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'
import {
  parseEvmWalletOptions,
  readEvmWalletPreference
} from '../../../../src/lib/evm-wallet-preference.ts'

const source = readFileSync(
  new URL('../../../../public/early-evm-provider.js', import.meta.url),
  'utf8'
)

function wallet(name, chainId = '0x1') {
  const calls = []
  const listeners = new Map()
  const provider = {
    name,
    chainId,
    selectedAddress: `${name}-account`,
    request: async args => {
      calls.push(args)
      return args.method === 'eth_chainId' ? provider.chainId : [`${name}-account`]
    },
    on(event, callback) {
      const callbacks = listeners.get(event) ?? new Set()
      callbacks.add(callback)
      listeners.set(event, callbacks)
      return provider
    },
    removeListener(event, callback) {
      listeners.get(event)?.delete(callback)
      return provider
    },
    isConnected: () => true
  }
  return {
    provider,
    calls,
    emit: (event, value) => {
      for (const callback of listeners.get(event) ?? []) callback(value)
    }
  }
}

async function harness({
  preference = 'ask',
  existing,
  locked = false,
  announced = [],
  choose,
  configError,
  fallback = false
} = {}) {
  const listeners = new Map()
  const choices = []
  const announcements = []
  const own = wallet('noir')
  const window = {
    location: { origin: 'https://chainlist.test' },
    addEventListener(event, callback) {
      const callbacks = listeners.get(event) ?? new Set()
      callbacks.add(callback)
      listeners.set(event, callbacks)
    },
    dispatchEvent(event) {
      if (event.type === 'eip6963:announceProvider') announcements.push(event.detail)
      for (const callback of listeners.get(event.type) ?? []) callback(event)
      return true
    },
    postMessage(message) {
      if (message.target !== 'noir-content-script') return
      void Promise.resolve().then(async () => {
        let response
        if (message.type === 'NOIR_EVM_WALLET_CONFIG') {
          response = configError ? { error: configError } : { result: preference }
        } else {
          choices.push(message.wallets)
          try {
            response = { result: await choose?.(message.wallets) }
          } catch (error) {
            response = { error: error.message }
          }
        }
        window.dispatchEvent({
          type: 'message',
          source: window,
          data: {
            target: 'noir-evm-wallet-router',
            requestId: message.requestId,
            response
          }
        })
      })
    }
  }
  if (fallback)
    window.__noirFallbackEvmProvider = {
      provider: own.provider,
      info: { uuid: 'existing-noir-uuid', name: 'Noir Wallet', rdns: 'com.zknoir' }
    }
  if (existing)
    Object.defineProperty(window, 'ethereum', {
      value: existing,
      writable: locked === 'writable' || !locked,
      configurable: !locked,
      enumerable: true
    })
  window.addEventListener('noirwallet#requestBridgeReady', () =>
    window.dispatchEvent({ type: 'noirwallet#bridgeReady' })
  )
  window.addEventListener('eip6963:requestProvider', () => {
    for (const [provider, name, metadata = {}] of announced)
      window.dispatchEvent({
        type: 'eip6963:announceProvider',
        detail: { provider, info: { name, ...metadata } }
      })
  })
  vm.runInNewContext(source, {
    window,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    Event: class {
      constructor(type) {
        this.type = type
      }
    },
    CustomEvent: class {
      constructor(type, options) {
        this.type = type
        this.detail = options.detail
      }
    }
  })
  window.__noirEarlyEvmProvider.attach(own.provider)
  await new Promise(resolve => setImmediate(resolve))
  return {
    window,
    own,
    choices,
    announcements,
    dispose: () => window.dispatchEvent({ type: 'pagehide' })
  }
}

test('wallet preference and option parsing rejects duplicate IDs and unsafe metadata', () => {
  for (const value of [undefined, null, {}, 'unknown', 'ask'])
    assert.equal(readEvmWalletPreference(value), 'ask')
  for (const value of ['noir', 'other']) assert.equal(readEvmWalletPreference(value), value)
  assert.throws(() =>
    parseEvmWalletOptions([
      { id: 'noir', name: 'A' },
      { id: 'noir', name: 'B' }
    ])
  )
  assert.throws(() => parseEvmWalletOptions([{ id: 'invalid', name: 'B' }]))
  assert.throws(() => parseEvmWalletOptions(Array(21).fill({ id: 'noir', name: 'A' })))
  assert.deepEqual(
    parseEvmWalletOptions([{ id: 'wallet-one', name: ' One ', icon: 'https://tracker.test/a' }]),
    [{ id: 'wallet-one', name: 'One' }]
  )
  assert.deepEqual(
    parseEvmWalletOptions([
      { id: 'wallet-phantom', name: 'Phantom', icon: '\ndata:image/png;base64,AA==\n' }
    ]),
    [{ id: 'wallet-phantom', name: 'Phantom', icon: 'data:image/png;base64,AA==' }]
  )
})

test('asking routes connection and subsequent requests to the chosen provider while EIP-6963 stays Noir', async t => {
  const other = wallet('MetaMask')
  const h = await harness({
    announced: [[other.provider, 'MetaMask']],
    choose: choices => choices.find(c => c.name === 'MetaMask').id
  })
  t.after(h.dispose)
  const legacy = h.window.ethereum
  assert.notEqual(legacy, h.window.__noirEarlyEvmProvider.provider)
  assert.equal(legacy.selectedAddress, null)
  assert.deepEqual(Array.from(await legacy.request({ method: 'eth_accounts' })), [])
  assert.equal(h.choices.length, 0)
  const events = []
  const listener = value => events.push(value)
  legacy.on('accountsChanged', listener)
  const args = { method: 'eth_requestAccounts', params: [] }
  assert.deepEqual(await legacy.request(args), ['MetaMask-account'])
  assert.equal(other.calls[0], args)
  assert.equal(h.choices.length, 1)
  assert.equal(legacy.selectedAddress, 'MetaMask-account')
  await legacy.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x89' }] })
  assert.equal(other.calls.at(-1).method, 'wallet_addEthereumChain')
  other.emit('accountsChanged', ['changed'])
  assert.deepEqual(events, [['changed']])
  legacy.removeListener('accountsChanged', listener)
  other.emit('accountsChanged', ['ignored'])
  assert.equal(events.length, 1)
  assert.equal(h.own.calls.length, 0)
  const noirAnnouncement = h.announcements.find(
    a => a.provider === h.window.__noirEarlyEvmProvider.provider
  )
  assert.equal(noirAnnouncement.info.name, 'Noir Wallet')
  await noirAnnouncement.provider.request({ method: 'eth_requestAccounts' })
  assert.equal(h.own.calls.length, 1)
  assert.equal(h.choices.length, 1)
})

test('a bootstrap loaded after the full provider preserves its provider and announcement identity', async t => {
  const other = wallet('MetaMask')
  const h = await harness({
    fallback: true,
    announced: [[other.provider, 'MetaMask']],
    choose: choices => {
      assert.equal(choices.length, 2)
      return 'noir'
    }
  })
  t.after(h.dispose)
  assert.equal(h.window.__noirEarlyEvmProvider.provider, h.own.provider)
  assert.equal(h.window.__noirEarlyEvmProvider.info.uuid, 'existing-noir-uuid')
  assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'noir-account'
  ])
  assert.equal(
    new Set(
      h.announcements
        .filter(detail => detail.info.name === 'Noir Wallet')
        .map(detail => detail.provider)
    ).size,
    1
  )
  assert.equal(h.choices[0].filter(option => option.name === 'Noir Wallet').length, 1)
})

test('a namespace alias and a different EIP-6963 provider for the same wallet appear once', async t => {
  const other = wallet('OKX')
  other.provider.isOkxWallet = true
  const alias = new Proxy(other.provider, {})
  const h = await harness({
    existing: alias,
    announced: [[other.provider, 'OKX Wallet']],
    choose: choices => {
      assert.equal(choices.length, 2)
      return choices.find(option => option.name === 'OKX Wallet').id
    }
  })
  t.after(h.dispose)
  h.window.okxwallet = alias
  assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'OKX-account'
  ])
  assert.equal(h.choices[0].filter(option => option.name === 'OKX Wallet').length, 1)
})

test('Phantom compatibility flags and namespace proxies never create a false MetaMask choice', async t => {
  for (const withMetaMask of [false, true]) {
    const phantom = wallet('Phantom')
    phantom.provider.isMetaMask = true
    const legacyAlias = new Proxy(phantom.provider, {})
    const metamask = wallet('MetaMask')
    let chosen = 'Phantom'
    const h = await harness({
      existing: legacyAlias,
      announced: withMetaMask ? [[metamask.provider, 'MetaMask']] : [],
      choose: choices => {
        assert.deepEqual(
          Array.from(choices, choice => choice.name).sort(),
          ['Noir Wallet', 'Phantom', ...(withMetaMask ? ['MetaMask'] : [])].sort()
        )
        return choices.find(choice => choice.name === chosen).id
      }
    })
    t.after(h.dispose)
    h.window.phantom = { ethereum: phantom.provider }
    assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
      'Phantom-account'
    ])
    assert.equal(phantom.calls.length, 1)
    assert.equal(metamask.calls.length, 0)
    if (withMetaMask) {
      chosen = 'MetaMask'
      assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
        'MetaMask-account'
      ])
      assert.equal(phantom.calls.length, 1)
      assert.equal(metamask.calls.length, 1)
    }
  }
})

test('an unidentified legacy provider remains usable without claiming to be MetaMask', async t => {
  const legacy = wallet('legacy')
  legacy.provider.isMetaMask = true
  const h = await harness({
    existing: legacy.provider,
    choose: choices => {
      assert.deepEqual(
        Array.from(choices, choice => choice.name),
        ['Noir Wallet', 'Other wallet']
      )
      return choices.find(choice => choice.id !== 'noir').id
    }
  })
  t.after(h.dispose)
  assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'legacy-account'
  ])
})

test('Phantom announcements replace ambiguous legacy proxies and normalize the published icon', async t => {
  const phantom = wallet('Phantom')
  phantom.provider.isPhantom = true
  phantom.provider.isMetaMask = true
  const legacyAlias = new Proxy(phantom.provider, {
    get(target, key) {
      return key === 'isPhantom' ? undefined : Reflect.get(target, key)
    }
  })
  const metamask = wallet('MetaMask')
  const h = await harness({
    existing: legacyAlias,
    announced: [
      [metamask.provider, 'MetaMask'],
      [phantom.provider, 'Phantom', { icon: '\ndata:image/png;base64,AA==\n' }]
    ],
    choose: choices => {
      assert.equal(choices.length, 3)
      assert.equal(choices.filter(choice => choice.name === 'MetaMask').length, 1)
      const option = choices.find(choice => choice.name === 'Phantom')
      assert.equal(option.icon, 'data:image/png;base64,AA==')
      return option.id
    }
  })
  t.after(h.dispose)
  h.window.phantom = { ethereum: phantom.provider }
  assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'Phantom-account'
  ])
  await h.window.ethereum.request({ method: 'wallet_addEthereumChain' })
  assert.equal(phantom.calls.at(-1).method, 'wallet_addEthereumChain')
  assert.equal(metamask.calls.length, 0)
})

test('later legacy assignment is captured while another wallet cannot overwrite the routing preference', async t => {
  const other = wallet('late')
  const h = await harness({ choose: choices => choices.find(c => c.id !== 'noir').id })
  t.after(h.dispose)
  h.window.ethereum = other.provider
  assert.equal(Object.getOwnPropertyDescriptor(h.window, 'ethereum').configurable, false)
  assert.throws(() => Object.defineProperty(h.window, 'ethereum', { value: other.provider }))
  assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'late-account'
  ])
  assert.equal(h.choices[0].length, 2)
})

test('default Noir bypasses the picker and another-wallet preference yields the legacy entry', async t => {
  const other = wallet('other')
  const noir = await harness({ preference: 'noir', existing: other.provider })
  const external = await harness({ preference: 'other', existing: other.provider })
  t.after(noir.dispose)
  t.after(external.dispose)
  assert.deepEqual(await noir.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'noir-account'
  ])
  assert.equal(noir.choices.length, 0)
  assert.equal(external.window.ethereum, other.provider)
  assert.deepEqual(await external.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'other-account'
  ])
  assert.equal(external.own.calls.length, 0)
})

test('another-wallet preference restores a writable locked global provider identity', async t => {
  const other = wallet('other')
  const h = await harness({ preference: 'other', existing: other.provider, locked: 'writable' })
  t.after(h.dispose)
  assert.equal(h.window.ethereum, other.provider)
  assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'other-account'
  ])
  assert.equal(h.own.calls.length, 0)
})

test('another-wallet preference asks among other wallets only when several exist', async t => {
  const one = wallet('one')
  const two = wallet('two')
  const h = await harness({
    preference: 'other',
    announced: [
      [one.provider, 'One'],
      [two.provider, 'Two']
    ],
    choose: choices => choices.find(c => c.name === 'Two').id
  })
  t.after(h.dispose)
  assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'two-account'
  ])
  assert.ok(h.choices[0].every(c => c.id !== 'noir'))
  assert.equal(one.calls.length, 0)
  assert.equal(h.own.calls.length, 0)
})

test('another-wallet preference keeps fresh global reads on the router after a choice', async t => {
  const one = wallet('one')
  const two = wallet('two')
  one.provider.removeListener = undefined
  let next = 'One'
  const h = await harness({
    preference: 'other',
    announced: [
      [one.provider, 'One'],
      [two.provider, 'Two']
    ],
    choose: choices => choices.find(choice => choice.name === next).id
  })
  t.after(h.dispose)
  const router = h.window.ethereum
  const accountEvents = []
  router.on('accountsChanged', accounts => accountEvents.push(accounts))
  assert.deepEqual(await router.request({ method: 'eth_requestAccounts' }), ['one-account'])
  assert.equal(h.window.ethereum, router)
  next = 'Two'
  assert.deepEqual(await h.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'two-account'
  ])
  assert.equal(h.choices.length, 2)
  assert.equal(h.window.ethereum, router)
  one.emit('accountsChanged', ['stale-account'])
  two.emit('accountsChanged', ['two-account'])
  assert.deepEqual(accountEvents, [['two-account']])
})

test('a single Noir wallet connects normally and other-only mode never silently falls back to Noir', async t => {
  const single = await harness()
  const external = await harness({ preference: 'other' })
  t.after(single.dispose)
  t.after(external.dispose)
  assert.deepEqual(await single.window.ethereum.request({ method: 'eth_requestAccounts' }), [
    'noir-account'
  ])
  assert.equal(single.choices.length, 0)
  assert.equal(external.window.ethereum, undefined)
  assert.equal(external.own.calls.length, 0)
})

test('concurrent connections share a picker and cancelled selection can be retried', async t => {
  const other = wallet('other')
  let resolveChoice
  let cancel = false
  const h = await harness({
    existing: other.provider,
    choose: choices => {
      if (cancel) throw new Error('Wallet selection was cancelled.')
      return new Promise(resolve => {
        resolveChoice = () => resolve(choices[0].id)
      })
    }
  })
  t.after(h.dispose)
  const legacy = h.window.ethereum
  const first = legacy.request({ method: 'eth_requestAccounts' })
  const second = legacy.request({ method: 'eth_requestAccounts' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.choices.length, 1)
  resolveChoice()
  await Promise.all([first, second])
  cancel = true
  await assert.rejects(
    legacy.request({ method: 'eth_requestAccounts' }),
    error => error.code === 4001
  )
  assert.equal(h.choices.length, 2)
  cancel = false
  const retry = legacy.request({ method: 'eth_requestAccounts' })
  await new Promise(resolve => setImmediate(resolve))
  resolveChoice()
  await retry
  assert.equal(h.choices.length, 3)
})

test('requests during reconnect wait for the new wallet and propagate cancellation', async t => {
  const one = wallet('one')
  const two = wallet('two')
  let resolveChoice
  let rejectChoice
  let choiceCount = 0
  const h = await harness({
    announced: [
      [one.provider, 'One'],
      [two.provider, 'Two']
    ],
    choose: choices => {
      choiceCount += 1
      if (choiceCount === 1) return choices.find(choice => choice.name === 'One').id
      return new Promise((resolve, reject) => {
        resolveChoice = () => resolve(choices.find(choice => choice.name === 'Two').id)
        rejectChoice = () => reject(new Error('Wallet selection was cancelled.'))
      })
    }
  })
  t.after(h.dispose)
  const router = h.window.ethereum
  await router.request({ method: 'eth_requestAccounts' })

  const reconnect = router.request({ method: 'eth_requestAccounts' })
  await new Promise(resolve => setImmediate(resolve))
  const sign = router.request({ method: 'personal_sign', params: ['message'] })
  const chain = router.request({ method: 'eth_chainId' })
  const accounts = router.request({ method: 'eth_accounts' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(one.calls.filter(call => call.method === 'personal_sign').length, 0)
  assert.equal(one.calls.filter(call => call.method === 'eth_chainId').length, 0)
  resolveChoice()
  assert.deepEqual(await reconnect, ['two-account'])
  assert.deepEqual(await sign, ['two-account'])
  assert.equal(await chain, '0x1')
  assert.deepEqual(await accounts, ['two-account'])
  assert.equal(two.calls.filter(call => call.method === 'personal_sign').length, 1)

  const cancelledReconnect = router.request({ method: 'eth_requestAccounts' })
  await new Promise(resolve => setImmediate(resolve))
  const cancelledSign = router.request({ method: 'eth_sendTransaction', params: [{}] })
  rejectChoice()
  await assert.rejects(cancelledReconnect, error => error.code === 4001)
  await assert.rejects(cancelledSign, error => error.code === 4001)
  assert.equal(two.calls.filter(call => call.method === 'eth_sendTransaction').length, 0)
})

test('selecting another chain reconciles a pre-read and ignores a late old-wallet read', async t => {
  const other = wallet('other', '0x89')
  const h = await harness({
    announced: [[other.provider, 'Other']],
    choose: choices => choices.find(choice => choice.name === 'Other').id
  })
  t.after(h.dispose)
  const router = h.window.ethereum
  const changed = []
  router.on('chainChanged', chainId => changed.push(chainId))
  assert.equal(await router.request({ method: 'eth_chainId' }), '0x1')
  await router.request({ method: 'eth_requestAccounts' })
  assert.deepEqual(changed, ['0x89'])
  assert.equal(await router.request({ method: 'eth_chainId' }), '0x89')
  assert.deepEqual(changed, ['0x89'])

  let releaseRead
  const isolated = await harness({
    announced: [[other.provider, 'Other']],
    choose: choices => choices.find(choice => choice.name === 'Other').id
  })
  t.after(isolated.dispose)
  isolated.own.provider.request = args => {
    isolated.own.calls.push(args)
    if (args.method === 'eth_chainId')
      return new Promise(resolve => {
        releaseRead = resolve
      })
    return Promise.resolve(['noir-account'])
  }
  const pendingRead = isolated.window.ethereum.request({ method: 'eth_chainId' })
  await new Promise(resolve => setImmediate(resolve))
  await isolated.window.ethereum.request({ method: 'eth_requestAccounts' })
  releaseRead('0x1')
  assert.equal(await pendingRead, '0x89')
})

test('a delayed chain read follows the current selection after A to B to A', async t => {
  const a = wallet('A')
  const b = wallet('B', '0x89')
  const originalRequest = a.provider.request
  let releaseOldRead
  let chainReads = 0
  a.provider.request = args => {
    if (args.method === 'eth_chainId' && ++chainReads === 1) {
      return new Promise(resolve => {
        releaseOldRead = resolve
      })
    }
    return originalRequest(args)
  }
  let next = 'A'
  const h = await harness({
    announced: [
      [a.provider, 'A'],
      [b.provider, 'B']
    ],
    choose: choices => choices.find(choice => choice.name === next).id
  })
  t.after(h.dispose)
  const router = h.window.ethereum
  await router.request({ method: 'eth_requestAccounts' })
  const oldRead = router.request({ method: 'eth_chainId' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof releaseOldRead, 'function')
  next = 'B'
  await router.request({ method: 'eth_requestAccounts' })
  a.provider.chainId = '0xaa'
  next = 'A'
  await router.request({ method: 'eth_requestAccounts' })
  releaseOldRead('0x1')
  assert.equal(await oldRead, '0xaa')
})

test('a synthetic chain update supersedes an older read from the same wallet', async t => {
  const other = wallet('other')
  const originalRequest = other.provider.request
  let releaseOldRead
  let chainReads = 0
  other.provider.request = args => {
    if (args.method === 'eth_chainId' && ++chainReads === 2) {
      return new Promise(resolve => {
        releaseOldRead = resolve
      })
    }
    return originalRequest(args)
  }
  const h = await harness({
    announced: [[other.provider, 'Other']],
    choose: choices => choices.find(choice => choice.name === 'Other').id
  })
  t.after(h.dispose)
  const router = h.window.ethereum
  const changed = []
  router.on('chainChanged', chainId => changed.push(chainId))
  await router.request({ method: 'eth_requestAccounts' })
  assert.equal(await router.request({ method: 'eth_chainId' }), '0x1')
  const oldRead = router.request({ method: 'eth_chainId' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof releaseOldRead, 'function')
  other.provider.chainId = '0xaa'
  await router.request({ method: 'eth_requestAccounts' })
  assert.deepEqual(changed, ['0xaa'])
  releaseOldRead('0x1')
  assert.equal(await oldRead, '0xaa')
})

test('chain reconciliation works when the selected wallet has no event methods', async t => {
  const other = wallet('other', '0x89')
  other.provider.on = undefined
  other.provider.removeListener = undefined
  const h = await harness({
    announced: [[other.provider, 'Other']],
    choose: choices => choices.find(choice => choice.name === 'Other').id
  })
  t.after(h.dispose)
  const changed = []
  h.window.ethereum.on('chainChanged', chainId => changed.push(chainId))
  assert.equal(await h.window.ethereum.request({ method: 'eth_chainId' }), '0x1')
  await h.window.ethereum.request({ method: 'eth_requestAccounts' })
  assert.deepEqual(changed, ['0x89'])
})

test('a live chain event supersedes an older reconciliation response', async t => {
  const other = wallet('other', '0x89')
  let releaseChainRead
  other.provider.request = args => {
    other.calls.push(args)
    if (args.method === 'eth_chainId') {
      return new Promise(resolve => {
        releaseChainRead = resolve
      })
    }
    return Promise.resolve(['other-account'])
  }
  const h = await harness({
    announced: [[other.provider, 'Other']],
    choose: choices => choices.find(choice => choice.name === 'Other').id
  })
  t.after(h.dispose)
  const router = h.window.ethereum
  const changed = []
  router.on('chainChanged', chainId => changed.push(chainId))
  assert.equal(await router.request({ method: 'eth_chainId' }), '0x1')
  const connect = router.request({ method: 'eth_requestAccounts' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof releaseChainRead, 'function')
  other.provider.chainId = '0xaa'
  other.emit('chainChanged', '0xaa')
  releaseChainRead('0x89')
  await connect
  assert.deepEqual(changed, ['0xaa'])
})

test('a locked global provider does not break independent Noir discovery or initialization', async t => {
  const other = wallet('locked')
  const h = await harness({ preference: 'noir', existing: other.provider, locked: true })
  t.after(h.dispose)
  assert.equal(h.window.ethereum, other.provider)
  assert.deepEqual(
    await h.window.__noirEarlyEvmProvider.provider.request({ method: 'eth_requestAccounts' }),
    ['noir-account']
  )
  assert.ok(h.announcements.some(a => a.info.name === 'Noir Wallet'))
})

test('configuration failure rejects legacy requests without forwarding them', async t => {
  const h = await harness({ configError: 'Wallet preference could not be loaded.' })
  t.after(h.dispose)
  await assert.rejects(h.window.ethereum.request({ method: 'eth_requestAccounts' }), /preference/)
  assert.equal(h.own.calls.length, 0)
})
