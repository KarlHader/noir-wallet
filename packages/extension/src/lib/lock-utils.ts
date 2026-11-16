import { SecureStorage } from '@/core/wallet/secure-storage'
import { WALLET_CONFIG } from '@/config/wallet'
import { SETTINGS_STORAGE_KEY, resolvePersistedAutoLockMs } from '@/lib/wallet-settings-storage'
import { hasAttestedCredentialSession } from '@/core/wallet/credential-session-client'

/**
 * Check if unlock is needed based on activity timeout
 * @returns true if manual unlock required, false if already unlocked or can restore from session
 */
export async function needsUnlock(options?: {
  readonly hasUnlockSession?: () => Promise<boolean>
}): Promise<boolean> {
  // 1. Check activity timeout first
  const lastActivityTime = await SecureStorage.getLastActivityTime()

  // No activity time = manual lock or first open → must unlock
  if (!lastActivityTime) {
    console.log('[🔒 Lock] No activity time → unlock required')
    return true
  }

  // Get auto-lock timeout setting
  const settings = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  const autoLockMs = resolvePersistedAutoLockMs(
    settings[SETTINGS_STORAGE_KEY],
    WALLET_CONFIG.SECURITY.AUTO_LOCK.DEFAULT_MS,
    WALLET_CONFIG.SECURITY.AUTO_LOCK.OPTIONS.map(option => option.value)
  )

  if (autoLockMs > 0) {
    const now = Date.now()
    const elapsed = now - lastActivityTime
    const timeoutSeconds = Math.floor(autoLockMs / 1000)
    const elapsedSeconds = Math.floor(elapsed / 1000)

    console.log('[🔒 Lock] Activity check:', {
      lastActivityTime: new Date(lastActivityTime).toLocaleString(),
      now: new Date(now).toLocaleString(),
      timeoutSeconds: `${timeoutSeconds}s`,
      elapsedSeconds: `${elapsedSeconds}s`,
      exceeded: elapsed >= autoLockMs
    })

    if (elapsed >= autoLockMs) {
      console.log('[🔒 Lock] ⏰ Timeout exceeded → unlock required')
      return true
    }
  }

  const hasUnlockSession = await (options?.hasUnlockSession ?? hasAttestedCredentialSession)()
  if (!hasUnlockSession) {
    return true
  }

  // Extension pages only need the non-secret attestation. Background owns the
  // selected credential and binds it directly to its Worker when needed.
  console.log('[🔒 Lock] ✅ Attested session is active')
  return false
}
