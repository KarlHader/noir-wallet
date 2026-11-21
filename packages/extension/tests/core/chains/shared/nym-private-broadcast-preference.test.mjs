import assert from 'node:assert/strict'
import { test } from 'node:test'

// Evaluated by the config module at import time, as the isolated Nym build defines it.
globalThis.__NYM_PRIVATE_BROADCAST__ = true

const {
  parseNymPrivateBroadcastEnabled,
  readNymPrivateBroadcastEnabled,
  readNymPrivateBroadcastEnabledFromBackground,
  readNymPrewarmOriginsFromBackground,
  writeNymPrivateBroadcastEnabled
} = await import('../../../../src/infrastructure/chains/nym-private-broadcast-preferences.ts')
const { NYM_PRIVATE_BROADCAST } = await import('../../../../src/config/nym-private-broadcast.ts')
const { DEFAULT_ZERO_INDEXER_REGISTRY } = await import('../../../../src/config/zero-indexer.ts')
const { createChromeStorageAdapter } = await import('../../../../src/lib/chrome-storage-adapter.ts')
const { isTrustedRuntimeMessageSender, parseTrustedExtensionRuntimeMessage } =
  await import('../../../../src/lib/runtime-message-security.ts')
const { getZeroIndexerBroadcastOptions } =
  await import('../../../../src/background/zero-indexer-node-settings.ts')

const SETTINGS_KEY = 'wallet_settings'

function stubExtensionStorage(t, initial = {}) {
  const stored = new Map(Object.entries(initial))
  const originalChrome = globalThis.chrome
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: stored.get(key) }
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) stored.set(key, value)
        }
      }
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name, operation) => operation() } }
  })
  t.after(() => {
    globalThis.chrome = originalChrome
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  })
  return stored
}

const settings = state => JSON.stringify({ state, version: 0 })

test('Nym routing is off until the user turns it on', () => {
  assert.equal(parseNymPrivateBroadcastEnabled(undefined), false)
  assert.equal(parseNymPrivateBroadcastEnabled(settings({ networkMode: 'mainnet' })), false)
  assert.equal(
    parseNymPrivateBroadcastEnabled(settings({ nymPrivateBroadcastEnabled: false })),
    false
  )
  assert.equal(
    parseNymPrivateBroadcastEnabled(settings({ nymPrivateBroadcastEnabled: true })),
    true
  )
})

test('unreadable settings leave the Nym preference unknown instead of off', async t => {
  assert.throws(() => parseNymPrivateBroadcastEnabled('{not json'))
  assert.throws(() => parseNymPrivateBroadcastEnabled(settings({ nymPrivateBroadcastEnabled: 1 })))
  assert.throws(() =>
    parseNymPrivateBroadcastEnabled(settings({ nymPrivateBroadcastEnabled: 'true' }))
  )
  stubExtensionStorage(t, { [SETTINGS_KEY]: '{not json' })
  await assert.rejects(readNymPrivateBroadcastEnabled())
})

test('the Nym preference is saved next to the other wallet settings', async t => {
  const stored = stubExtensionStorage(t, {
    [SETTINGS_KEY]: settings({ networkMode: 'testnet', zeroIndexerEnabled: false })
  })
  assert.equal(await readNymPrivateBroadcastEnabled(), false)

  await writeNymPrivateBroadcastEnabled(true)
  assert.equal(await readNymPrivateBroadcastEnabled(), true)
  assert.deepEqual(JSON.parse(stored.get(SETTINGS_KEY)).state, {
    networkMode: 'testnet',
    zeroIndexerEnabled: false,
    nymPrivateBroadcastEnabled: true
  })

  await writeNymPrivateBroadcastEnabled(false)
  assert.equal(await readNymPrivateBroadcastEnabled(), false)
})

test('a popup settings write can neither drop nor set the Nym preference', async t => {
  const stored = stubExtensionStorage(t, {
    [SETTINGS_KEY]: settings({ networkMode: 'testnet', nymPrivateBroadcastEnabled: true })
  })
  const adapter = createChromeStorageAdapter('local')

  // The popup store does not carry the preference, so its snapshot omits it.
  await adapter.setItem(SETTINGS_KEY, settings({ networkMode: 'testnet', balancesHidden: true }))
  assert.equal(JSON.parse(stored.get(SETTINGS_KEY)).state.nymPrivateBroadcastEnabled, true)
  assert.equal(JSON.parse(stored.get(SETTINGS_KEY)).state.balancesHidden, true)

  await writeNymPrivateBroadcastEnabled(false)
  await adapter.setItem(
    SETTINGS_KEY,
    settings({ networkMode: 'testnet', nymPrivateBroadcastEnabled: true })
  )
  assert.equal(await readNymPrivateBroadcastEnabled(), false)

  // Before the background ever committed a choice, a page cannot introduce one either.
  stored.set(SETTINGS_KEY, settings({ networkMode: 'testnet' }))
  await adapter.setItem(
    SETTINGS_KEY,
    settings({ networkMode: 'testnet', nymPrivateBroadcastEnabled: true })
  )
  assert.equal('nymPrivateBroadcastEnabled' in JSON.parse(stored.get(SETTINGS_KEY)).state, false)
})

test('Nym preference messages enforce their runtime contract and sender boundary', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
  const page = { id: extensionId, url: `chrome-extension://${extensionId}/index.html` }
  const offscreen = {
    id: extensionId,
    url: `chrome-extension://${extensionId}/src/offscreen/index.html`
  }
  const read = { type: 'GET_NYM_PRIVATE_BROADCAST_ENABLED' }
  const write = { type: 'SET_NYM_PRIVATE_BROADCAST_ENABLED', enabled: true }
  assert.deepEqual(parseTrustedExtensionRuntimeMessage(read), read)
  assert.deepEqual(parseTrustedExtensionRuntimeMessage(write), write)
  // The offscreen tunnel host asks before each broadcast; only pages may change the setting.
  assert.equal(isTrustedRuntimeMessageSender(read.type, page, extensionId), true)
  assert.equal(isTrustedRuntimeMessageSender(read.type, offscreen, extensionId), true)
  assert.equal(isTrustedRuntimeMessageSender(write.type, page, extensionId), true)
  assert.equal(isTrustedRuntimeMessageSender(write.type, offscreen, extensionId), false)
  assert.throws(() => parseTrustedExtensionRuntimeMessage({ ...write, enabled: 'true' }))
  assert.throws(() => parseTrustedExtensionRuntimeMessage({ type: write.type }))
  assert.throws(() => parseTrustedExtensionRuntimeMessage({ ...read, unexpected: true }))
})

test('the offscreen document accepts only a definite answer from the background', async t => {
  const originalChrome = globalThis.chrome
  t.after(() => {
    globalThis.chrome = originalChrome
  })
  const answer = response => {
    globalThis.chrome = {
      runtime: {
        async sendMessage(message) {
          assert.deepEqual(message, { type: 'GET_NYM_PRIVATE_BROADCAST_ENABLED' })
          return response
        }
      }
    }
  }
  answer({ success: true, enabled: true })
  assert.equal(await readNymPrivateBroadcastEnabledFromBackground(), true)
  answer({ success: true, enabled: false })
  assert.equal(await readNymPrivateBroadcastEnabledFromBackground(), false)
  for (const invalid of [
    undefined,
    { success: false, error: 'Could not load privacy preference' },
    { success: true },
    { success: true, enabled: 'true' }
  ]) {
    answer(invalid)
    await assert.rejects(readNymPrivateBroadcastEnabledFromBackground())
  }
})

test('prewarm destinations from the background are validated before use', async t => {
  const originalChrome = globalThis.chrome
  t.after(() => {
    globalThis.chrome = originalChrome
  })
  const answer = response => {
    globalThis.chrome = {
      runtime: {
        async sendMessage(message) {
          assert.deepEqual(message, { type: 'GET_NYM_PREWARM_ORIGINS' })
          return response
        }
      }
    }
  }
  answer({ success: true, origins: ['https://node.example/path', 'http://plain.example'] })
  assert.deepEqual(await readNymPrewarmOriginsFromBackground(), ['https://node.example'])
  answer({ success: true, origins: [] })
  assert.deepEqual(await readNymPrewarmOriginsFromBackground(), [])
  for (const invalid of [undefined, { success: false }, { success: true, origins: 'https://a' }]) {
    answer(invalid)
    await assert.rejects(readNymPrewarmOriginsFromBackground())
  }

  const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
  const page = { id: extensionId, url: `chrome-extension://${extensionId}/index.html` }
  const offscreen = {
    id: extensionId,
    url: `chrome-extension://${extensionId}/src/offscreen/index.html`
  }
  const message = { type: 'GET_NYM_PREWARM_ORIGINS' }
  assert.deepEqual(parseTrustedExtensionRuntimeMessage(message), message)
  assert.equal(isTrustedRuntimeMessageSender(message.type, offscreen, extensionId), true)
  assert.equal(isTrustedRuntimeMessageSender(message.type, page, extensionId), false)
})

test('ZeroIndexer sends wait for the mixnet only while Nym routing is on', async t => {
  stubExtensionStorage(t)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async input => {
    if (String(input).includes('/v1/zero-indexer-endpoints')) {
      return Response.json(DEFAULT_ZERO_INDEXER_REGISTRY)
    }
    throw new Error('unexpected request')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const direct = await getZeroIndexerBroadcastOptions('mainnet', true)
  assert.ok(direct.urls.length > 0)
  assert.equal(direct.sendTimeoutMs, undefined)

  await writeNymPrivateBroadcastEnabled(true)
  const routed = await getZeroIndexerBroadcastOptions('mainnet', true)
  assert.deepEqual(routed.urls, direct.urls)
  assert.equal(routed.sendTimeoutMs, NYM_PRIVATE_BROADCAST.zeroIndexerSendTimeoutMs)
})
