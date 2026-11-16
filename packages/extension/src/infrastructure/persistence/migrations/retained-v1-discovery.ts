import { isNativeHardwareWalletId } from '@/core/wallet/native-hardware-identity'
import type { StorageV2Snapshot } from '@/ports/repositories'
import type { V1MetadataDiscovery } from './v1-metadata-discovery'

export function excludeNativeV2HardwareShadows(
  discovery: V1MetadataDiscovery,
  snapshot: StorageV2Snapshot
): V1MetadataDiscovery {
  const nativeHardwareIds = new Set<string>(
    snapshot.keyDomains
      .filter(
        keyDomain => keyDomain.source.kind === 'hardware' && isNativeHardwareWalletId(keyDomain.id)
      )
      .map(keyDomain => keyDomain.id)
  )
  const wallets = discovery.wallets.filter(wallet => {
    if (!nativeHardwareIds.has(wallet.id)) return true
    const keyDomain = snapshot.keyDomains.find(item => item.id === wallet.id)
    return keyDomain?.source.kind !== 'hardware' || wallet.keySource !== keyDomain.source.vendor
  })
  return wallets.length === discovery.wallets.length
    ? discovery
    : Object.freeze({ ...discovery, wallets: Object.freeze(wallets) })
}
