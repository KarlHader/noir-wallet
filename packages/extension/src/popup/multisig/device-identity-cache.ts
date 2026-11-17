import { multisigDebug } from '@/core/multisig/debug-log'
import type { DeviceIdentity } from '@/core/multisig/identity'

// Kept apart from the create-session store so pages outside the create flow (clearing multisig
// data) can drop the memo without pulling the store, and its mock transport, into every build.

// One load for the whole page: load-or-create is not atomic, so two concurrent first loads could
// each generate a key, and the one persisted last might not be the one in use.
let identityLoad: Promise<DeviceIdentity> | null = null
let loadedIdentity: DeviceIdentity | null = null

/** The page's device identity, loaded once and shared by every caller. */
export function loadSharedIdentity(load: () => Promise<DeviceIdentity>): Promise<DeviceIdentity> {
  if (identityLoad) return identityLoad
  const loading = Promise.resolve().then(load)
  identityLoad = loading
  loading.then(
    loaded => {
      if (identityLoad === loading) loadedIdentity = loaded
    },
    () => {
      // A failed load is forgotten so the next session can try again.
      if (identityLoad === loading) identityLoad = null
    }
  )
  return loading
}

/** The identity once a shared load has resolved, so callers can use it synchronously. */
export function peekSharedIdentity(): DeviceIdentity | null {
  return loadedIdentity
}

/** Drops the memo; a load still in flight no longer fills it when it resolves. */
export function forgetSharedIdentity(): void {
  identityLoad = null
  loadedIdentity = null
}

// The IndexedDB identity store is imported on first use only, so Node tests that inject their own
// loader never load it.
export async function defaultLoadIdentity(): Promise<DeviceIdentity> {
  const [{ loadOrCreateDeviceIdentity }, { createIndexedDbIdentityStore }] = await Promise.all([
    import('@/core/multisig/identity'),
    import('@/lib/multisig-identity-storage')
  ])
  // A new key means every phone paired before must pair again, so it is worth a trace.
  return loadOrCreateDeviceIdentity(createIndexedDbIdentityStore(), undefined, () =>
    multisigDebug('identity', { result: 'regenerated' })
  )
}
