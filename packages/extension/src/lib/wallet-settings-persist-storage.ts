import type { PersistStorage, StorageValue } from 'zustand/middleware'
import { createChromeStorageAdapter } from './chrome-storage-adapter'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createWalletSettingsPersistStorage<S>(): PersistStorage<S, Promise<void>> {
  const storage = createChromeStorageAdapter('local')

  return {
    async getItem(name) {
      const raw: unknown = await storage.getItem(name)
      if (raw === null || raw === undefined) return null

      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!isRecord(parsed)) throw new Error('Persisted wallet settings are invalid')
      if (!('state' in parsed)) return { state: parsed as S, version: 0 }
      if (!isRecord(parsed.state)) throw new Error('Persisted wallet settings are invalid')
      if (parsed.version !== undefined && typeof parsed.version !== 'number') {
        throw new Error('Persisted wallet settings version is invalid')
      }
      return parsed as StorageValue<S>
    },
    setItem(name, value) {
      return storage.setItem(name, JSON.stringify(value))
    },
    removeItem(name) {
      return storage.removeItem(name)
    }
  }
}
