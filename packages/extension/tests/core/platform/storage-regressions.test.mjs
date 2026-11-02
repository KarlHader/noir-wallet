import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  isAccountScopeForNetwork,
  resolveAccountScope
} from '../../../src/core/wallet/account-scope.ts'
import {
  decodePersistedWalletSettings,
  resolvePersistedAutoLockMs,
  resolvePersistedNetworkChainEndpointSettings,
  resolvePersistedNetworkMode,
  updatePersistedWalletSettings
} from '../../../src/lib/wallet-settings-storage.ts'
import {
  setActiveRpcEndpointPreferences,
  syncActiveRpcEndpointPreferencesFromStorage
} from '../../../src/infrastructure/chains/rpc-endpoints.ts'
import { inspectWalletDbEntry } from '../../../src/lib/indexed-db.ts'
import {
  createWalletPersistenceQuarantineRecord,
  parseWalletPersistenceQuarantineRecord
} from '../../../src/lib/indexed-db-quarantine.ts'
import { isRetryableWalletRpcError } from '../../../src/core/zcash/wallet-rpc-errors.ts'

const pendingZcashSource = readFileSync(
  new URL('../../../src/core/wallet/pending-zcash-tx.ts', import.meta.url),
  'utf-8'
)
const indexedDbSource = readFileSync(
  new URL('../../../src/lib/indexed-db.ts', import.meta.url),
  'utf-8'
)
const offscreenSource = readFileSync(
  new URL('../../../src/offscreen/offscreen.ts', import.meta.url),
  'utf-8'
)
const zcashWalletRuntimeSource = readFileSync(
  new URL('../../../src/background/zcash-wallet-runtime.ts', import.meta.url),
  'utf-8'
)

const wallets = [
  {
    id: 'wallet_with_underscores',
    name: 'Test wallet',
    seedPhraseKey: 'seed',
    accounts: [{ id: 'account_with_underscores' }],
    createdAt: 0,
    isPinned: false
  }
]

test.describe('Storage regressions', () => {
  test('keeps an unlocked session recoverable when its Worker was recreated', () => {
    expect(isRetryableWalletRpcError('Wallet not initialized: wallet-id')).toBe(true)
    expect(isRetryableWalletRpcError('Invalid password')).toBe(false)
  })

  test('resolves explicit pending transaction account identity', () => {
    const scope = resolveAccountScope(
      {
        accountKey: 'mainnet_wallet_with_underscores_account_with_underscores',
        walletId: 'wallet_with_underscores',
        accountId: 'account_with_underscores'
      },
      []
    )
    expect(scope).toEqual({
      accountKey: 'mainnet_wallet_with_underscores_account_with_underscores',
      walletId: 'wallet_with_underscores',
      accountId: 'account_with_underscores'
    })
    expect(isAccountScopeForNetwork(scope, 'mainnet')).toBe(true)
    expect(isAccountScopeForNetwork(scope, 'testnet')).toBe(false)
  })

  test('adapts a legacy account key by exact metadata matching', () => {
    expect(
      resolveAccountScope(
        { accountKey: 'testnet_wallet_with_underscores_account_with_underscores' },
        wallets
      )
    ).toEqual({
      accountKey: 'testnet_wallet_with_underscores_account_with_underscores',
      walletId: 'wallet_with_underscores',
      accountId: 'account_with_underscores'
    })
  })

  test('rejects malformed explicit identity instead of parsing the key', () => {
    expect(
      resolveAccountScope(
        {
          accountKey: 'mainnet_wallet_with_underscores_account_with_underscores',
          walletId: 'wrong',
          accountId: 'identity'
        },
        wallets
      )
    ).toBeNull()
    expect(pendingZcashSource).not.toContain('.split(')
  })

  test('decodes object and serialized Zustand settings envelopes identically', () => {
    const state = {
      autoLockMs: 300_000,
      rpcEndpointPreferences: { zcash: 'chainsafe' }
    }
    expect(decodePersistedWalletSettings({ state, version: 0 })).toEqual(state)
    expect(decodePersistedWalletSettings(JSON.stringify({ state, version: 0 }))).toEqual(state)
  })

  test('accepts direct legacy settings state and rejects malformed envelopes', () => {
    expect(decodePersistedWalletSettings({ autoLockMs: 60_000 })).toEqual({
      autoLockMs: 60_000
    })
    expect(decodePersistedWalletSettings({ state: null, version: 0 })).toBeNull()
    expect(decodePersistedWalletSettings('{invalid')).toBeNull()
  })

  test('validates persisted auto-lock values at runtime', () => {
    const allowedAutoLockMs = [60_000, 300_000]
    expect(
      resolvePersistedAutoLockMs({ state: { autoLockMs: 300_000 } }, 60_000, allowedAutoLockMs)
    ).toBe(300_000)
    expect(
      resolvePersistedAutoLockMs({ state: { autoLockMs: -1 } }, 60_000, allowedAutoLockMs)
    ).toBe(60_000)
  })

  test('defaults missing network mode to mainnet and rejects corrupted values', () => {
    expect(resolvePersistedNetworkMode(undefined, 'mainnet')).toBe('mainnet')
    expect(resolvePersistedNetworkMode({ state: {}, version: 0 }, 'mainnet')).toBe('mainnet')
    expect(
      resolvePersistedNetworkMode({ state: { networkMode: 'testnet' }, version: 0 }, 'mainnet')
    ).toBe('testnet')
    expect(() =>
      resolvePersistedNetworkMode({ state: { networkMode: 'preview' }, version: 0 }, 'mainnet')
    ).toThrow('Persisted wallet network mode is invalid')
    expect(() => resolvePersistedNetworkMode('{broken', 'mainnet')).toThrow(
      'Persisted wallet settings are corrupted'
    )
  })

  test('uses legacy endpoint settings only until a network-scoped map exists', () => {
    const legacy = { schemaVersion: 1, customEvmNetworks: [], overrides: [] }
    const mainnet = {
      schemaVersion: 1,
      activeEvmChainId: 'eip155:1',
      customEvmNetworks: [],
      overrides: []
    }
    const raw = {
      state: {
        chainEndpointSettings: legacy,
        chainEndpointSettingsByNetwork: { mainnet }
      },
      version: 0
    }

    expect(
      resolvePersistedNetworkChainEndpointSettings(
        { state: { chainEndpointSettings: legacy } },
        'testnet'
      )
    ).toEqual(legacy)
    expect(resolvePersistedNetworkChainEndpointSettings(raw, 'mainnet')).toEqual(mainnet)
    expect(resolvePersistedNetworkChainEndpointSettings(raw, 'testnet')).toBeUndefined()
  })

  test('preserves the settings storage representation while applying patches', () => {
    const objectEnvelope = { state: { autoLockMs: 60_000 }, version: 0 }
    expect(updatePersistedWalletSettings(objectEnvelope, { networkMode: 'testnet' })).toEqual({
      state: { autoLockMs: 60_000, networkMode: 'testnet' },
      version: 0
    })

    const serialized = updatePersistedWalletSettings(JSON.stringify(objectEnvelope), {
      networkMode: 'testnet'
    })
    expect(typeof serialized).toBe('string')
    expect(JSON.parse(serialized)).toEqual({
      state: { autoLockMs: 60_000, networkMode: 'testnet' },
      version: 0
    })
  })

  test('restores RPC preference from the persisted envelope on a cold context read', async () => {
    const originalChrome = globalThis.chrome
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => ({
            wallet_settings: {
              state: { rpcEndpointPreferences: { zcash: 'chainsafe' } },
              version: 0
            }
          })
        }
      }
    }

    try {
      expect(await syncActiveRpcEndpointPreferencesFromStorage()).toEqual({ zcash: 'chainsafe' })
    } finally {
      setActiveRpcEndpointPreferences()
      if (originalChrome === undefined) {
        delete globalThis.chrome
      } else {
        globalThis.chrome = originalChrome
      }
    }
  })

  test('classifies incompatible wallet snapshots without producing loadable bytes', () => {
    expect(inspectWalletDbEntry(new Uint8Array([1, 2, 3]))).toEqual({
      status: 'incompatible',
      reason: 'legacy-format'
    })
    expect(
      inspectWalletDbEntry({
        metadata: { version: 0 },
        data: new Uint8Array([1])
      })
    ).toEqual({
      status: 'incompatible',
      reason: 'version-mismatch',
      storedVersion: 0
    })
    expect(
      inspectWalletDbEntry({
        metadata: { version: 1 },
        chunked: true,
        chunkCount: 2,
        chunkSizes: [1],
        totalBytes: 1
      })
    ).toEqual({
      status: 'incompatible',
      reason: 'invalid-entry'
    })
  })

  test('accepts only internally consistent current wallet snapshot entries', () => {
    expect(
      inspectWalletDbEntry({
        metadata: { version: 1 },
        data: new Uint8Array([1, 2])
      })
    ).toEqual({
      status: 'compatible',
      format: 'single',
      version: 1,
      totalBytes: 2
    })
    expect(
      inspectWalletDbEntry({
        metadata: { version: 1 },
        chunked: true,
        chunkCount: 2,
        chunkSizes: [2, 1],
        totalBytes: 3
      })
    ).toEqual({
      status: 'compatible',
      format: 'chunked',
      version: 1,
      totalBytes: 3
    })
  })

  test('does not delete or overwrite an incompatible snapshot implicitly', () => {
    const loadStart = indexedDbSource.indexOf('export async function loadWalletDb')
    const hasStart = indexedDbSource.indexOf('export async function hasWalletDb', loadStart)
    const loadSource = indexedDbSource.slice(loadStart, hasStart)
    expect(loadSource).not.toContain('deleteWalletDb(')
    expect(loadSource).toContain('throw new IncompatibleWalletDbError')

    const saveStart = indexedDbSource.indexOf('export async function saveWalletDb')
    const chunkLoadStart = indexedDbSource.indexOf('async function loadChunkedWalletDb', saveStart)
    const saveSource = indexedDbSource.slice(saveStart, chunkLoadStart)
    expect(saveSource).toContain("existing.status === 'incompatible'")
    expect(saveSource).toContain('throw new IncompatibleWalletDbError')
  })

  test('creates bounded quarantine records and accumulates recovery reasons', () => {
    const first = createWalletPersistenceQuarantineRecord({
      key: 'mainnet_wallet-1',
      network: 'mainnet',
      walletId: 'wallet-1',
      reason: 'journal-replay-failed',
      snapshotQuarantined: false,
      journalQuarantined: true,
      detectedAt: 100
    })
    const second = createWalletPersistenceQuarantineRecord({
      key: 'mainnet_wallet-1',
      network: 'mainnet',
      walletId: 'wallet-1',
      reason: 'wasm-health-timeout',
      snapshotQuarantined: true,
      journalQuarantined: true,
      detectedAt: 200,
      existing: first
    })

    expect(second).toEqual({
      schemaVersion: 1,
      key: 'mainnet_wallet-1',
      network: 'mainnet',
      walletId: 'wallet-1',
      snapshotQuarantined: true,
      journalQuarantined: true,
      detectedAt: 100,
      reasons: ['journal-replay-failed', 'wasm-health-timeout']
    })
    expect(Object.isFrozen(second)).toBe(true)
    expect(Object.isFrozen(second.reasons)).toBe(true)
  })

  test('rejects malformed or open-ended quarantine data', () => {
    expect(() =>
      parseWalletPersistenceQuarantineRecord({
        schemaVersion: 1,
        key: 'mainnet_wallet-1',
        network: 'mainnet',
        walletId: 'wallet-1',
        snapshotQuarantined: false,
        journalQuarantined: false,
        detectedAt: 100,
        reasons: ['journal-replay-failed']
      })
    ).toThrow(/fields/i)
    expect(() =>
      parseWalletPersistenceQuarantineRecord({
        schemaVersion: 1,
        key: 'mainnet_wallet-1',
        network: 'mainnet',
        walletId: 'wallet-1',
        snapshotQuarantined: true,
        journalQuarantined: true,
        detectedAt: 100,
        reasons: ['unknown-reason']
      })
    ).toThrow(/reasons/i)
  })

  test('quarantines automatic recovery failures instead of deleting evidence', () => {
    expect(offscreenSource).toContain('quarantineWalletPersistence')
    expect(offscreenSource).not.toContain('deleteWalletDb(')
    expect(offscreenSource).not.toContain('clearJournalEntries(')

    const syncStart = zcashWalletRuntimeSource.indexOf('async syncBlocks(')
    const assertionStart = zcashWalletRuntimeSource.indexOf(
      'async assertWasmAccountInvariant',
      syncStart
    )
    const syncSource = zcashWalletRuntimeSource.slice(syncStart, assertionStart)
    expect(syncSource).toContain('quarantineJournalAndFail')
    expect(syncSource).not.toContain('deleteJournal(')
  })

  test('makes legacy migration readiness a Background Zcash runtime invariant', () => {
    expect(zcashWalletRuntimeSource).toContain('await prepareWalletStoreForUse()')
  })

  test('does not persist a stale empty wallet snapshot during default-network startup', () => {
    const initializeStart = zcashWalletRuntimeSource.indexOf('async initialize(')
    const wasmInitializeStart = zcashWalletRuntimeSource.indexOf(
      'async initializeWithWasm',
      initializeStart
    )
    const initializeSource = zcashWalletRuntimeSource.slice(initializeStart, wasmInitializeStart)

    expect(initializeSource).toContain('if (this.store.currentNetwork !== this.network)')
    expect(initializeSource).not.toContain(
      'this.network = network || DEFAULT_NETWORK\n\n    this.store.setCurrentNetwork(this.network)'
    )
  })
})
