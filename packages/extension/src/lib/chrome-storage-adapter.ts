/**
 * Chrome Storage Adapter for Zustand persist middleware
 * Implements Storage API interface backed by chrome.storage
 */

type StorageArea = 'local' | 'session'
import { SETTINGS_STORAGE_KEY, withWalletSettingsLock } from './wallet-settings-storage'

interface StorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/**
 * Creates a chrome.storage adapter for Zustand persist middleware
 * @param area - 'local' for persistent storage, 'session' for ephemeral storage
 */
export function createChromeStorageAdapter(
  area: StorageArea = 'local',
  options: { strictRead?: boolean } = {}
): StorageAdapter {
  const storage = area === 'local' ? chrome.storage.local : chrome.storage.session

  return {
    getItem: async (key: string): Promise<string | null> => {
      if (area === 'local' && key === WALLET_STATE_KEY) {
        return (await readWalletMetadata()) as unknown as string | null
      }
      try {
        const result = await storage.get(key)
        return result[key] ?? null
      } catch (error) {
        console.error('[ChromeStorageAdapter] getItem error:', error)
        if (options.strictRead) throw error
        return null
      }
    },

    setItem: async (key: string, value: string): Promise<void> => {
      if (area === 'local' && key === WALLET_STATE_KEY) {
        await writeWalletMetadata(value)
        return
      }
      const write = async () => {
        try {
          if (area === 'local' && key === SETTINGS_STORAGE_KEY) {
            const latest = (await storage.get(key))[key]
            const parse = (raw: unknown): Record<string, unknown> => {
              try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : {}
              } catch {
                return {}
              }
            }
            const incoming = parse(value)
            const previous = parse(latest)
            if (incoming.state && typeof incoming.state === 'object') {
              const state = parse(incoming.state)
              const previousState = previous.state ? parse(previous.state) : previous
              // Network definitions are committed by Background; page stores only mirror them.
              // Preserve absence too, so an empty partition cannot mask legacy settings.
              for (const field of ['chainEndpointSettings', 'chainEndpointSettingsByNetwork']) {
                if (Object.prototype.hasOwnProperty.call(previousState, field)) {
                  state[field] = previousState[field]
                } else {
                  delete state[field]
                }
              }
              if (Object.prototype.hasOwnProperty.call(previousState, 'networkMode')) {
                state.networkMode = previousState.networkMode
              }
              value = JSON.stringify({
                ...incoming,
                state: { ...state, zeroIndexerEnabled: previousState.zeroIndexerEnabled !== false }
              })
            }
          }
          await storage.set({ [key]: value })
        } catch (error: any) {
          // Handle quota exceeded
          if (error.message?.includes('QUOTA_BYTES')) {
            console.warn('[ChromeStorageAdapter] Quota exceeded, attempting cleanup...')
            await clearOldCacheEntries(storage)
            await storage.set({ [key]: value })
          } else {
            console.error('[ChromeStorageAdapter] setItem error:', error)
            throw error
          }
        }
      }
      if (area === 'local' && key === SETTINGS_STORAGE_KEY) await withWalletSettingsLock(write)
      else await write()
    },

    removeItem: async (key: string): Promise<void> => {
      const remove = async () => {
        try {
          await storage.remove(key)
        } catch (error) {
          console.error('[ChromeStorageAdapter] removeItem error:', error)
          throw error
        }
      }
      if (area === 'local' && key === SETTINGS_STORAGE_KEY) await withWalletSettingsLock(remove)
      else await remove()
    }
  }
}

/**
 * Clear oldest cache entries when quota is exceeded
 * Targets balance_cache_* keys first
 */
async function clearOldCacheEntries(storage: chrome.storage.StorageArea): Promise<void> {
  try {
    const items = await storage.get(null)
    const cacheKeys = Object.keys(items).filter(key => key.startsWith('balance_cache_'))

    if (cacheKeys.length > 0) {
      // Sort by timestamp (assuming format: balance_cache_<timestamp>_<accountId>)
      const sorted = cacheKeys.sort()
      const toRemove = sorted.slice(0, Math.max(1, Math.floor(cacheKeys.length / 2)))
      await storage.remove(toRemove)
      console.log('[ChromeStorageAdapter] Cleared cache entries:', toRemove.length)
    }
  } catch (error) {
    console.error('[ChromeStorageAdapter] clearOldCacheEntries error:', error)
  }
}
import {
  WALLET_STATE_KEY,
  readWalletMetadata,
  writeWalletMetadata
} from './wallet-metadata-storage'
