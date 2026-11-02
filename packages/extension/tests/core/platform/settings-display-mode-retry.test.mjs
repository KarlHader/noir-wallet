import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
Object.defineProperty(globalThis.navigator, 'locks', {
  configurable: true,
  value: { request: async (_name, operation) => operation() }
})
after(() => {
  if (originalLocks === undefined) delete globalThis.navigator.locks
  else Object.defineProperty(globalThis.navigator, 'locks', originalLocks)
})

test('late display mode read does not replace a newer storage update', async () => {
  const originalChrome = globalThis.chrome
  const storageArea = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {}
  }
  let resolveRead
  globalThis.chrome = {
    storage: {
      local: storageArea,
      session: storageArea,
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      sendMessage: async message => {
        if (message.type !== 'GET_EXTENSION_DISPLAY_MODE') throw new Error('Unexpected request')
        return new Promise(resolve => {
          resolveRead = resolve
        })
      }
    }
  }

  try {
    const { useSettingsStore } = await import('../../../src/store/settings-store.ts')
    const loading = useSettingsStore.getState().loadSidePanelMode()
    useSettingsStore.getState().syncSidePanelMode(true)
    resolveRead({ success: true, sidePanelMode: false })
    await loading
    assert.equal(useSettingsStore.getState().sidePanelMode, true)
    assert.equal(useSettingsStore.getState().isSidePanelModeLoaded, true)
  } finally {
    await new Promise(resolve => setImmediate(resolve))
    globalThis.chrome = originalChrome
  }
})

test('older display mode read does not replace a newer read', async () => {
  const originalChrome = globalThis.chrome
  const storageArea = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {}
  }
  const reads = []
  globalThis.chrome = {
    storage: {
      local: storageArea,
      session: storageArea,
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      sendMessage: async message => {
        if (message.type !== 'GET_EXTENSION_DISPLAY_MODE') throw new Error('Unexpected request')
        return new Promise(resolve => reads.push(resolve))
      }
    }
  }

  try {
    const { useSettingsStore } = await import('../../../src/store/settings-store.ts')
    const first = useSettingsStore.getState().loadSidePanelMode()
    const second = useSettingsStore.getState().loadSidePanelMode()
    assert.equal(reads.length, 2)

    reads[1]({ success: true, sidePanelMode: true })
    await second
    reads[0]({ success: true, sidePanelMode: false })
    await first
    assert.equal(useSettingsStore.getState().sidePanelMode, true)
  } finally {
    await new Promise(resolve => setImmediate(resolve))
    globalThis.chrome = originalChrome
  }
})
