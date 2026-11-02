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
const releaseNotes = JSON.parse(
  readFileSync(new URL('../../../../web/public/changelog.json', import.meta.url), 'utf8')
)

it('uses the RHEA SDK release that propagates lending RPC failures', () => {
  assert.equal(packageJson.dependencies['@rhea-finance/cross-chain-sdk'], '0.1.22')
})

it.describe('Product release notes', () => {
  it('match the extension version and schema', () => {
    assert.deepEqual(parseProductReleaseNotesManifest(releaseNotes, packageJson.version), {
      version: packageJson.version,
      changes: releaseNotes.releases[packageJson.version].changes
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
          ...releaseNotes.releases[packageJson.version],
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
          [packageJson.version]: value
        }
      }
      assert.throws(() => parseProductReleaseNotesManifest(manifest, packageJson.version), error)
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
      }
    ]

    validStates.forEach(state => assert.equal(isExtensionUpdateState(state), true))
    invalidStates.forEach(state => assert.equal(isExtensionUpdateState(state), false))
  })
})
