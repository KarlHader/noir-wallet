import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  isExtensionUpdateState,
  parseProductReleaseNotesManifest,
  shouldNotifyExtensionUpdate
} from '../../../src/lib/extension-update.ts'

const packageJson = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
)
const extensionVersion = packageJson.version.split('-')[0]
const releaseNotes = JSON.parse(
  readFileSync(new URL('../../../../web/public/changelog.json', import.meta.url), 'utf8')
)

it.describe('Product release notes', () => {
  it('match the extension version and schema', () => {
    assert.deepEqual(parseProductReleaseNotesManifest(releaseNotes, extensionVersion), {
      version: extensionVersion,
      changes: releaseNotes.releases[extensionVersion].changes
    })
  })

  it('rejects malformed or unsafe release notes', () => {
    const invalidEntries = [
      {
        value: undefined,
        error: /were not found/
      },
      {
        value: {
          ...releaseNotes.releases[extensionVersion],
          internalNotes: 'Do not show this to users'
        },
        error: /unknown fields/
      },
      {
        value: { changes: [] },
        error: /at least one item/
      },
      {
        value: { changes: ['x'.repeat(121)] },
        error: /at most 120 characters/
      },
      {
        value: { changes: Array.from({ length: 9 }, (_, index) => `Feature ${index + 1}`) },
        error: /at most 8 items/
      },
      {
        value: { changes: ['Valid change'], notifyUpdate: 'yes' },
        error: /notifyUpdate must be a boolean/
      }
    ]

    for (const { value, error } of invalidEntries) {
      const manifest = {
        ...releaseNotes,
        releases: {
          ...releaseNotes.releases,
          [extensionVersion]: value
        }
      }
      assert.throws(() => parseProductReleaseNotesManifest(manifest, extensionVersion), error)
    }
  })
})

it.describe('Extension update notification milestones', () => {
  const manifest = {
    schemaVersion: 1,
    releases: {
      '1.0.28': { changes: ['Ordinary release'] },
      '1.0.29': { changes: ['Important release'], notifyUpdate: true },
      '1.0.30': { changes: ['Later ordinary release'], notifyUpdate: false },
      '1.0.31': { changes: ['Latest release'] }
    }
  }

  it('notifies when a marked intermediate release is newer than the installed version', () => {
    assert.equal(shouldNotifyExtensionUpdate(manifest, '1.0.27', '1.0.31'), true)
    assert.equal(shouldNotifyExtensionUpdate(manifest, '1.0.28', '1.0.31'), true)
  })

  it('does not notify for the unmarked current product release', () => {
    assert.equal(releaseNotes.releases['1.0.31'].notifyUpdate, undefined)
    assert.equal(shouldNotifyExtensionUpdate(releaseNotes, '1.0.30', '1.0.31'), false)
    assert.equal(shouldNotifyExtensionUpdate(releaseNotes, '1.0.31', '1.0.32'), false)
  })

  it('does not reuse a milestone that is already installed', () => {
    assert.equal(shouldNotifyExtensionUpdate(manifest, '1.0.29', '1.0.31'), false)
    assert.equal(shouldNotifyExtensionUpdate(manifest, '1.0.30', '1.0.31'), false)
  })

  it('ignores milestones newer than the update Chrome has made available', () => {
    assert.equal(shouldNotifyExtensionUpdate(manifest, '1.0.27', '1.0.28'), false)
  })

  it('does not notify when the available version is not newer', () => {
    assert.equal(shouldNotifyExtensionUpdate(manifest, '1.0.31', '1.0.31'), false)
    assert.equal(shouldNotifyExtensionUpdate(manifest, '1.0.31', '1.0.30'), false)
  })

  it('compares numeric version components instead of sorting them as text', () => {
    const numericManifest = {
      schemaVersion: 1,
      releases: {
        '1.0.10': { changes: ['Important release'], notifyUpdate: true }
      }
    }
    assert.equal(shouldNotifyExtensionUpdate(numericManifest, '1.0.9', '1.0.11'), true)
  })
})

it.describe('Extension update state validation', () => {
  it('accepts valid states and rejects malformed states', () => {
    const validStates = [
      {
        status: 'available',
        version: '1.0.28',
        detectedAt: 1
      },
      {
        status: 'detected',
        version: '1.0.29',
        detectedAt: 2
      }
    ]
    const invalidStates = [
      {
        status: 'available',
        version: '../1.0.28',
        detectedAt: 1
      },
      {
        status: 'installed',
        version: '1.0.28',
        previousVersion: '1.0.27',
        detectedAt: 1
      },
      {
        status: 'detected',
        version: 'invalid',
        detectedAt: 1
      }
    ]

    validStates.forEach(state => assert.equal(isExtensionUpdateState(state), true))
    invalidStates.forEach(state => assert.equal(isExtensionUpdateState(state), false))
  })
})

it('retains detected versions across remote failures and clears installed versions', async () => {
  const listeners = {}
  let installedVersion = '1.0.28'
  let storedState = null
  let notifyUpdate = false
  let failRequest = false
  const originalChrome = globalThis.chrome
  const originalFetch = globalThis.fetch

  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: installedVersion }),
      onUpdateAvailable: { addListener: listener => (listeners.available = listener) },
      onInstalled: { addListener: listener => (listeners.installed = listener) },
      onStartup: { addListener: listener => (listeners.startup = listener) }
    },
    storage: {
      local: {
        get: async key => ({ [key]: storedState }),
        set: async values => {
          storedState = values.extension_update_notice
        },
        remove: async () => {
          storedState = null
        }
      }
    }
  }
  globalThis.fetch = async () => {
    if (failRequest) throw new Error('Remote unavailable')
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          schemaVersion: 1,
          releases: {
            '1.0.29': { changes: ['Update'], notifyUpdate }
          }
        })
    }
  }

  try {
    const { initializeExtensionUpdates, refreshExtensionUpdateNotice } =
      await import('../../../src/background/extension-update.ts')
    initializeExtensionUpdates()

    listeners.available({ version: '1.0.29' })
    await refreshExtensionUpdateNotice()
    assert.equal(storedState.status, 'detected')
    assert.equal(storedState.version, '1.0.29')

    notifyUpdate = true
    listeners.startup()
    await refreshExtensionUpdateNotice()
    assert.equal(storedState.status, 'available')

    failRequest = true
    await assert.rejects(refreshExtensionUpdateNotice(), /Remote unavailable/)
    assert.equal(storedState.status, 'available')

    installedVersion = '1.0.29'
    listeners.installed({ reason: 'update' })
    await refreshExtensionUpdateNotice()
    assert.equal(storedState, null)
  } finally {
    globalThis.chrome = originalChrome
    globalThis.fetch = originalFetch
  }
})
