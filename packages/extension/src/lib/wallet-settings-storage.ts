export const SETTINGS_STORAGE_KEY = 'wallet_settings'
const SETTINGS_LOCK_NAME = 'noir-wallet-settings'

export async function withWalletSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Wallet settings coordination is unavailable')
  return navigator.locks.request(SETTINGS_LOCK_NAME, operation)
}

export type PersistedWalletSettings = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Decodes the Zustand persist envelope stored by every extension context.
 * Direct state objects are accepted only for compatibility with pre-envelope
 * values; new writes continue to use `{ state, version }`.
 */
export function decodePersistedWalletSettings(raw: unknown): PersistedWalletSettings | null {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }

  if (!isRecord(parsed)) return null
  if (!('state' in parsed)) return parsed
  return isRecord(parsed.state) ? parsed.state : null
}

export function resolvePersistedAutoLockMs(
  raw: unknown,
  defaultMs: number,
  allowedMs: readonly number[]
): number {
  const value = decodePersistedWalletSettings(raw)?.autoLockMs
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultMs
  return value === 0 || allowedMs.includes(value) ? value : defaultMs
}

export type PersistedNetworkMode = 'mainnet' | 'testnet'

export function resolvePersistedNetworkChainEndpointSettings(
  raw: unknown,
  network: PersistedNetworkMode
): unknown {
  const state = decodePersistedWalletSettings(raw)
  const byNetwork = state?.chainEndpointSettingsByNetwork
  if (isRecord(byNetwork)) return byNetwork[network]
  return state?.chainEndpointSettings
}

export function resolvePersistedNetworkMode(
  raw: unknown,
  fallback: PersistedNetworkMode
): PersistedNetworkMode {
  const state = decodePersistedWalletSettings(raw)
  if (raw !== undefined && state === null) {
    throw new Error('Persisted wallet settings are corrupted')
  }
  if (!state || state.networkMode === undefined) return fallback
  if (state.networkMode !== 'mainnet' && state.networkMode !== 'testnet') {
    throw new Error('Persisted wallet network mode is invalid')
  }
  return state.networkMode
}

export function updatePersistedWalletSettings(
  raw: unknown,
  patch: PersistedWalletSettings
): string | PersistedWalletSettings {
  const preserveSerializedRepresentation = typeof raw === 'string'
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Persisted wallet settings are corrupted')
    }
  }

  if (parsed === undefined || parsed === null) {
    return { state: { ...patch }, version: 0 }
  }
  if (!isRecord(parsed)) throw new Error('Persisted wallet settings are corrupted')
  let updated: PersistedWalletSettings
  if (!Object.prototype.hasOwnProperty.call(parsed, 'state')) {
    updated = { ...parsed, ...patch }
  } else {
    if (!isRecord(parsed.state)) throw new Error('Persisted wallet settings are corrupted')
    updated = { ...parsed, state: { ...parsed.state, ...patch } }
  }
  return preserveSerializedRepresentation ? JSON.stringify(updated) : updated
}
