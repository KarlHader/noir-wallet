import { parseZeroIndexerRuntimeOptions, type ZeroIndexerOptions } from '@/core/zcash/zero-indexer'
import {
  decodePersistedWalletSettings,
  SETTINGS_STORAGE_KEY,
  updatePersistedWalletSettings,
  withWalletSettingsLock
} from '@/lib/wallet-settings-storage'
import type { Network } from '@/types'

export const ZERO_INDEXER_NODES_STORAGE_KEY = 'zero_indexer_nodes_v1'
export const ZERO_INDEXER_RUNTIME_STORAGE_KEY = 'zero_indexer_runtime_v1'
export const ZERO_INDEXER_REGISTRY_CACHE_KEY = 'zero_indexer_registry_cache_v1'

export function parseZeroIndexerEnabled(raw: unknown): boolean {
  const state = decodePersistedWalletSettings(raw)
  return state?.zeroIndexerEnabled !== false
}

export async function readZeroIndexerOptionsForWorker(
  network: Network
): Promise<ZeroIndexerOptions | null> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'GET_ZERO_INDEXER_OPTIONS',
    network
  })
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Invalid privacy broadcast configuration response')
  }
  const result = response as Record<string, unknown>
  if (result.success !== true) {
    throw new Error('Privacy broadcast configuration is unavailable')
  }
  return parseZeroIndexerRuntimeOptions(result.options)
}

export async function readZeroIndexerEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  return parseZeroIndexerEnabled(stored[SETTINGS_STORAGE_KEY])
}

export async function writeZeroIndexerEnabled(enabled: boolean): Promise<void> {
  await withWalletSettingsLock(async () => {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
    const raw = stored[SETTINGS_STORAGE_KEY]
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: updatePersistedWalletSettings(raw, { zeroIndexerEnabled: enabled })
    })
  })
}
