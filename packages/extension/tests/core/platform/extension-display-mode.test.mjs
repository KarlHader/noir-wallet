import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  applyExtensionDisplayMode,
  enqueueExtensionDisplayModeUpdate,
  persistSidePanelMode,
  readPersistedSidePanelMode,
  readSidePanelMode
} from '../../../src/background/extension-display-mode.ts'
import {
  isSidePanelSurface,
  readStoredExtensionDisplayMode
} from '../../../src/lib/extension-display-mode.ts'
import { launchHardwareSignSurface } from '../../../src/lib/hardware-sign-launcher.ts'

test.describe('extension display mode', () => {
  let originalChrome

  test.beforeEach(() => {
    originalChrome = globalThis.chrome
  })

  test.afterEach(() => {
    globalThis.chrome = originalChrome
  })

  test('reads the side panel preference from persisted settings', () => {
    expect(isSidePanelSurface('?surface=side-panel')).toBe(true)
    expect(isSidePanelSurface('?surface=popup')).toBe(false)
    expect(readStoredExtensionDisplayMode({ sidePanelMode: true })).toBe(true)
    expect(readStoredExtensionDisplayMode({ sidePanelMode: false })).toBe(false)
    expect(readStoredExtensionDisplayMode({ sidePanelMode: 'true' })).toBeNull()
    expect(
      readSidePanelMode(
        JSON.stringify({ state: { autoLockMs: 300000, sidePanelMode: true }, version: 0 })
      )
    ).toBe(true)
    expect(readSidePanelMode(JSON.stringify({ state: {}, version: 0 }))).toBe(false)
    expect(readSidePanelMode('{invalid')).toBe(false)
  })

  test('does not let a manifest popup override side panel action clicks', () => {
    const manifestSource = readFileSync(
      new URL('../../../manifest.config.ts', import.meta.url),
      'utf8'
    )
    expect(manifestSource).not.toContain('default_popup')
  })

  test('serializes startup restoration and a later user update', async () => {
    const order = []
    let releaseStartup
    const startupGate = new Promise(resolve => {
      releaseStartup = resolve
    })

    const startup = enqueueExtensionDisplayModeUpdate(async () => {
      order.push('startup:start')
      await startupGate
      order.push('startup:end')
    })
    const userUpdate = enqueueExtensionDisplayModeUpdate(async () => {
      order.push('user:update')
    })

    await Promise.resolve()
    expect(order).toEqual(['startup:start'])
    releaseStartup()
    await Promise.all([startup, userUpdate])
    expect(order).toEqual(['startup:start', 'startup:end', 'user:update'])
  })

  test('configures the toolbar action for side panel mode', async () => {
    const calls = []
    globalThis.chrome = {
      action: {
        setPopup: async options => calls.push(['popup', options])
      },
      sidePanel: {
        setOptions: async options => calls.push(['options', options]),
        setPanelBehavior: async options => calls.push(['behavior', options])
      }
    }

    await applyExtensionDisplayMode(true)

    expect(calls).toEqual([
      ['options', { path: 'index.html?surface=side-panel', enabled: true }],
      ['behavior', { openPanelOnActionClick: true }],
      ['popup', { popup: '' }]
    ])
  })

  test('persists the display mode independently from wallet settings', async () => {
    let writtenValue
    globalThis.chrome = {
      storage: {
        local: {
          set: async value => {
            writtenValue = value
          }
        }
      }
    }

    await persistSidePanelMode(true)

    expect(writtenValue).toEqual({
      extension_display_mode: { sidePanelMode: true }
    })
  })

  test('migrates the display mode from the first beta wallet settings', async () => {
    let writtenValue
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => ({
            wallet_settings: JSON.stringify({
              state: { autoLockMs: 300000, sidePanelMode: true },
              version: 0
            })
          }),
          set: async value => {
            writtenValue = value
          }
        }
      }
    }

    await expect(readPersistedSidePanelMode()).resolves.toBe(true)
    expect(writtenValue).toEqual({
      extension_display_mode: { sidePanelMode: true }
    })
  })

  test('restores popup mode before disabling the side panel', async () => {
    const calls = []
    globalThis.chrome = {
      action: {
        setPopup: async options => calls.push(['popup', options]),
        openPopup: async options => calls.push(['openPopup', options])
      },
      sidePanel: {
        setOptions: async options => calls.push(['options', options]),
        setPanelBehavior: async options => calls.push(['behavior', options])
      }
    }

    await applyExtensionDisplayMode(false)

    expect(calls).toEqual([
      ['popup', { popup: 'index.html' }],
      ['behavior', { openPanelOnActionClick: false }],
      ['options', { path: 'index.html?surface=side-panel', enabled: false }]
    ])
  })

  test('opens side-panel hardware signing in a focused standalone window', async () => {
    const calls = []
    const signTab = { id: 42 }
    globalThis.chrome = {
      windows: {
        create: async options => {
          calls.push(options)
          return { id: 7, tabs: [signTab] }
        }
      },
      tabs: {
        create: async options => ({ ...options, id: 8 }),
        query: async () => []
      }
    }

    await expect(
      launchHardwareSignSurface(
        'chrome-extension://wallet/index.html#/hardware/sign?req=x',
        'window'
      )
    ).resolves.toBe(signTab)
    expect(calls).toEqual([
      {
        url: 'chrome-extension://wallet/index.html#/hardware/sign?req=x',
        type: 'popup',
        width: 375,
        height: 632,
        focused: true
      }
    ])
  })

  test('keeps normal hardware signing in a tab', async () => {
    let openedWindow = false
    globalThis.chrome = {
      windows: { create: async () => (openedWindow = true) },
      tabs: { create: async options => ({ ...options, id: 8 }) }
    }

    await expect(
      launchHardwareSignSurface('chrome-extension://wallet/sign', 'tab')
    ).resolves.toEqual({ url: 'chrome-extension://wallet/sign', id: 8 })
    expect(openedWindow).toBe(false)
  })
})
