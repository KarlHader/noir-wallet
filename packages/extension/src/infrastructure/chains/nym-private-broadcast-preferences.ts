import { NYM_PRIVATE_BROADCAST } from '@/config/nym-private-broadcast'
import { nymPrewarmOrigins } from '@/core/nym/private-broadcast-protocol'
import {
  decodePersistedWalletSettings,
  patchStoredWalletSettings,
  SETTINGS_STORAGE_KEY
} from '@/lib/wallet-settings-storage'

const NYM_PRIVATE_BROADCAST_SETTING = 'nymPrivateBroadcastEnabled'

/**
 * The user's choice to route Zcash broadcasts through Nym; off until they turn it on.
 * Unreadable settings or a malformed value throw, so callers block the request instead of
 * sending it directly.
 */
export function parseNymPrivateBroadcastEnabled(raw: unknown): boolean {
  const state = decodePersistedWalletSettings(raw)
  if (raw !== undefined && raw !== null && state === null) {
    throw new Error('Persisted wallet settings are corrupted')
  }
  const value = state?.[NYM_PRIVATE_BROADCAST_SETTING]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error('Persisted Nym broadcast preference is invalid')
  return value
}

/** Whether requests are routed through Nym: the tunnel is packaged and the user turned it on. */
export async function readNymPrivateBroadcastEnabled(): Promise<boolean> {
  if (!NYM_PRIVATE_BROADCAST.available) return false
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  return parseNymPrivateBroadcastEnabled(stored[SETTINGS_STORAGE_KEY])
}

export async function writeNymPrivateBroadcastEnabled(enabled: boolean): Promise<void> {
  await patchStoredWalletSettings({ [NYM_PRIVATE_BROADCAST_SETTING]: enabled })
}

/** The offscreen document has no storage access and asks the background before each broadcast. */
export async function readNymPrivateBroadcastEnabledFromBackground(): Promise<boolean> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'GET_NYM_PRIVATE_BROADCAST_ENABLED'
  })
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Private broadcast preference is unavailable')
  }
  const result = response as Record<string, unknown>
  if (result.success !== true || typeof result.enabled !== 'boolean') {
    throw new Error('Private broadcast preference is unavailable')
  }
  return result.enabled
}

/** Destinations to prove before a broadcast, as the background resolves them; empty while off. */
export async function readNymPrewarmOriginsFromBackground(): Promise<string[]> {
  const response: unknown = await chrome.runtime.sendMessage({ type: 'GET_NYM_PREWARM_ORIGINS' })
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Private broadcast destinations are unavailable')
  }
  const result = response as Record<string, unknown>
  if (result.success !== true || !Array.isArray(result.origins)) {
    throw new Error('Private broadcast destinations are unavailable')
  }
  return nymPrewarmOrigins(result.origins)
}
