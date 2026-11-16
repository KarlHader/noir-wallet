import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  MULTISIG_BANNER_STORAGE_KEY,
  MULTISIG_GROUPS_STORAGE_KEY,
  clearMultisigData,
  dismissMultisigBanner,
  isMultisigBannerDismissed,
  multisigGroupScopeKey,
  readAllMultisigGroups,
  readMultisigGroup,
  writeMultisigGroup,
  type MultisigGroupScope
} from '../../../src/lib/multisig-group-storage'
import {
  MULTISIG_ROUTE_PREFIX,
  isMultisigTabRoute,
  multisigCreateRoute,
  multisigTeamRoute,
  openMultisigCreateTab,
  openMultisigTeamTab
} from '../../../src/lib/multisig-tab'
import { installLockEnv } from './helpers/storage-env'
import type { MultisigGroupRecord } from '../../../src/core/multisig/types'

const MAINNET: MultisigGroupScope = { network: 'mainnet', walletId: 'w', accountId: 'a' }
const TESTNET: MultisigGroupScope = { network: 'testnet', walletId: 'w', accountId: 'a' }
const OTHER_ACCOUNT: MultisigGroupScope = { network: 'mainnet', walletId: 'w', accountId: 'b' }

const RECORD: MultisigGroupRecord = {
  groupId: 'group-1',
  threshold: '2-of-3',
  transportKind: 'ble',
  devices: [
    { slot: 1, role: 'owner', name: 'This browser', model: 'Chrome', platform: 'extension' },
    { slot: 2, role: 'guardian', name: 'Alice phone', model: 'iPhone 15', platform: 'ios' },
    { slot: 3, role: 'guardian', name: 'Bob phone', model: 'Pixel 8', platform: 'android' }
  ],
  fingerprint: '4F2A-91C0',
  createdAt: 1_700_000_000_000,
  mock: true
}

interface ChromeEnv {
  readonly store: Map<string, unknown>
  readonly createdTabUrls: string[]
}

// Node has no `chrome` global, so each test installs an in-memory stand-in for the three
// extension APIs these modules touch and restores the previous global afterwards. Values are
// structured-cloned on the way in and out, like the real storage area.
async function withChrome(run: (env: ChromeEnv) => void | Promise<void>): Promise<void> {
  const host = globalThis as { chrome?: unknown }
  const original = host.chrome
  const env: ChromeEnv = { store: new Map(), createdTabUrls: [] }
  const restoreLocks = installLockEnv()
  const keysOf = (keys: string | string[]): string[] => (Array.isArray(keys) ? keys : [keys])
  host.chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://test-id/${path}` },
    tabs: {
      create: async ({ url }: { url: string }) => {
        env.createdTabUrls.push(url)
        return {}
      }
    },
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            keysOf(keys)
              .filter(key => env.store.has(key))
              .map(key => [key, structuredClone(env.store.get(key))])
          ),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items))
            env.store.set(key, structuredClone(value))
        },
        remove: async (keys: string | string[]) => {
          for (const key of keysOf(keys)) env.store.delete(key)
        }
      }
    }
  }
  try {
    await run(env)
  } finally {
    restoreLocks()
    if (original === undefined) delete host.chrome
    else host.chrome = original
  }
}

test.describe('multisig group storage', () => {
  test('scope key includes network', () => {
    expect(multisigGroupScopeKey(TESTNET)).toBe('testnet:w:a')
    expect(multisigGroupScopeKey(MAINNET)).not.toBe(multisigGroupScopeKey(TESTNET))
  })

  test('write then read round-trips and other scopes stay empty', async () => {
    await withChrome(async env => {
      await expect(readMultisigGroup(MAINNET)).resolves.toBeNull()

      await writeMultisigGroup(MAINNET, RECORD)

      await expect(readMultisigGroup(MAINNET)).resolves.toEqual(RECORD)
      await expect(readMultisigGroup(TESTNET)).resolves.toBeNull()
      await expect(readMultisigGroup(OTHER_ACCOUNT)).resolves.toBeNull()
      expect(Object.keys(env.store.get(MULTISIG_GROUPS_STORAGE_KEY) as object)).toEqual([
        'mainnet:w:a'
      ])

      await writeMultisigGroup(TESTNET, { ...RECORD, groupId: 'group-2' })
      const all = await readAllMultisigGroups()
      expect(Object.keys(all).sort()).toEqual(['mainnet:w:a', 'testnet:w:a'])
      expect(all['mainnet:w:a']?.groupId).toBe('group-1')
      expect(all['testnet:w:a']?.groupId).toBe('group-2')
      expect(Object.isFrozen(all)).toBe(true)
    })
  })

  test('never persists fields outside the group record', async () => {
    await withChrome(async env => {
      const wider = {
        ...RECORD,
        keyShare: 'secret',
        devices: RECORD.devices.map(device => ({ ...device, token: 'secret' }))
      }

      await writeMultisigGroup(MAINNET, wider)

      expect(JSON.stringify(env.store.get(MULTISIG_GROUPS_STORAGE_KEY))).not.toContain('secret')
      await expect(readMultisigGroup(MAINNET)).resolves.toEqual(RECORD)
    })
  })

  test('treats malformed stored records as absent instead of throwing', async () => {
    await withChrome(async env => {
      const invalid: Record<string, unknown> = {
        'mainnet:w:missing-group-id': { ...RECORD, groupId: undefined },
        'mainnet:w:numeric-threshold': { ...RECORD, threshold: 3 },
        'mainnet:w:string-created-at': { ...RECORD, createdAt: '1700000000000' },
        'mainnet:w:not-mock': { ...RECORD, mock: false },
        'mainnet:w:no-mock': { ...RECORD, mock: undefined },
        'mainnet:w:devices-not-array': { ...RECORD, devices: 'nope' },
        'mainnet:w:device-string-slot': {
          ...RECORD,
          devices: [{ ...RECORD.devices[0], slot: '1' }]
        },
        'mainnet:w:device-missing-role': {
          ...RECORD,
          devices: [{ ...RECORD.devices[0], role: undefined }]
        },
        'mainnet:w:device-null': { ...RECORD, devices: [null] },
        'mainnet:w:null': null,
        'mainnet:w:string': 'record'
      }
      env.store.set(MULTISIG_GROUPS_STORAGE_KEY, { ...invalid, 'mainnet:w:valid': RECORD })

      const all = await readAllMultisigGroups()
      expect(Object.keys(all)).toEqual(['mainnet:w:valid'])
      await expect(
        readMultisigGroup({ ...MAINNET, accountId: 'numeric-threshold' })
      ).resolves.toBeNull()

      for (const stored of ['garbage', 42, null, ['x'], true]) {
        env.store.set(MULTISIG_GROUPS_STORAGE_KEY, stored)
        await expect(readAllMultisigGroups()).resolves.toEqual({})
        await expect(readMultisigGroup(MAINNET)).resolves.toBeNull()
      }
    })
  })

  test('banner dismissal is remembered per scope', async () => {
    await withChrome(async () => {
      await expect(isMultisigBannerDismissed(MAINNET)).resolves.toBe(false)

      await dismissMultisigBanner(MAINNET)

      await expect(isMultisigBannerDismissed(MAINNET)).resolves.toBe(true)
      await expect(isMultisigBannerDismissed(TESTNET)).resolves.toBe(false)
      await expect(isMultisigBannerDismissed(OTHER_ACCOUNT)).resolves.toBe(false)

      await dismissMultisigBanner(TESTNET)

      await expect(isMultisigBannerDismissed(MAINNET)).resolves.toBe(true)
      await expect(isMultisigBannerDismissed(TESTNET)).resolves.toBe(true)
    })
  })

  test('ignores malformed banner storage', async () => {
    await withChrome(async env => {
      for (const stored of ['garbage', 42, null, ['mainnet:w:a'], { 'mainnet:w:a': 'yes' }]) {
        env.store.set(MULTISIG_BANNER_STORAGE_KEY, stored)
        await expect(isMultisigBannerDismissed(MAINNET)).resolves.toBe(false)
      }

      env.store.set(MULTISIG_BANNER_STORAGE_KEY, 'garbage')
      await dismissMultisigBanner(MAINNET)
      await expect(isMultisigBannerDismissed(MAINNET)).resolves.toBe(true)
    })
  })

  test('clearMultisigData removes groups and banner flags', async () => {
    await withChrome(async env => {
      await writeMultisigGroup(MAINNET, RECORD)
      await dismissMultisigBanner(MAINNET)
      env.store.set('unrelated', 'kept')

      await clearMultisigData()

      expect(env.store.has(MULTISIG_GROUPS_STORAGE_KEY)).toBe(false)
      expect(env.store.has(MULTISIG_BANNER_STORAGE_KEY)).toBe(false)
      expect(env.store.get('unrelated')).toBe('kept')
      await expect(readMultisigGroup(MAINNET)).resolves.toBeNull()
      await expect(isMultisigBannerDismissed(MAINNET)).resolves.toBe(false)
    })
  })
})

test.describe('multisig tab helpers', () => {
  test('multisigCreateRoute encodes ids as a query string under /multisig', () => {
    expect(MULTISIG_ROUTE_PREFIX).toBe('/multisig')
    expect(multisigCreateRoute({ walletId: 'w 1', accountId: 'a' })).toBe(
      '/multisig/create?walletId=w+1&accountId=a'
    )
    expect(multisigTeamRoute({ walletId: 'w&1', accountId: 'a=b' })).toBe(
      '/multisig/team?walletId=w%261&accountId=a%3Db'
    )
  })

  test('opens the create and team routes in a full extension tab', async () => {
    await withChrome(async env => {
      openMultisigCreateTab({ walletId: 'w 1', accountId: 'a' })
      openMultisigTeamTab({ walletId: 'w', accountId: 'a' })

      expect(env.createdTabUrls).toEqual([
        'chrome-extension://test-id/index.html#/multisig/create?walletId=w+1&accountId=a',
        'chrome-extension://test-id/index.html#/multisig/team?walletId=w&accountId=a'
      ])
    })
  })

  test('recognises multisig tab hashes', () => {
    expect(isMultisigTabRoute('#/multisig/create?walletId=w&accountId=a')).toBe(true)
    expect(isMultisigTabRoute('#/multisig/team?walletId=w&accountId=a')).toBe(true)
    expect(isMultisigTabRoute('#/hardware/connect')).toBe(false)
    expect(isMultisigTabRoute('')).toBe(false)
  })
})
