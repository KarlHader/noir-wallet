import { logger } from '@/lib/logger'
import { SIGNING_ACCOUNT_INDEX } from '@/config/wallet'
import type { ZcashWalletCore } from '../zcash/wallet-core'
import type { Network } from '@/types'

export type IdentitySigningMode = 'derived' | 'current' | 'legacy_index0'

type IdentityCachePurpose = 'publicKey' | 'ping'

export type CachedIdentity = {
  pubkey: string
  address: string
  pingSignature?: string
  originAddress?: string
  signingMode: IdentitySigningMode
  createdAt: number
}

const identityCache = new Map<string, CachedIdentity>()
const identityInFlight = new Map<string, Promise<CachedIdentity>>()

function buildIdentityCacheKey(
  network: Network,
  walletId: string,
  accountId: string,
  signingMode: IdentitySigningMode,
  addressIndex: number | 'current',
  purpose: IdentityCachePurpose
): string {
  return `${network}:${walletId}:${accountId}:${signingMode}:${addressIndex}:${purpose}`
}

async function getOrCreateIdentity(
  key: string,
  factory: () => Promise<CachedIdentity>
): Promise<CachedIdentity> {
  const cached = identityCache.get(key)
  if (cached) {
    logger.log('identity cache hit', key.split(':')[1])
    return cached
  }

  const pending = identityInFlight.get(key)
  if (pending) {
    logger.log('dedup hit', key.split(':')[1])
    return pending
  }

  const promise = factory()
    .then(result => {
      identityCache.set(key, result)
      return result
    })
    .finally(() => {
      if (identityInFlight.get(key) === promise) {
        identityInFlight.delete(key)
      }
    })

  identityInFlight.set(key, promise)
  return promise
}

export async function fetchCachedIdentity(
  network: Network,
  walletId: string,
  accountId: string,
  derivationIndex: number,
  mode: IdentitySigningMode,
  walletCore: ZcashWalletCore,
  options?: { usePing?: boolean }
): Promise<CachedIdentity> {
  const addressIndex =
    mode === 'legacy_index0' ? 0 : mode === 'derived' ? SIGNING_ACCOUNT_INDEX : derivationIndex
  const purpose: IdentityCachePurpose = options?.usePing ? 'ping' : 'publicKey'
  const key = buildIdentityCacheKey(network, walletId, accountId, mode, addressIndex, purpose)
  const usePing = options?.usePing ?? false

  return getOrCreateIdentity(key, async () => {
    if (usePing) {
      if (mode === 'legacy_index0') {
        const result = await walletCore.signMessage('ping', undefined, 0)
        return {
          pubkey: result.pubkey,
          address: result.address,
          pingSignature: result.signature,
          signingMode: mode,
          createdAt: Date.now()
        }
      }
      if (mode === 'derived') {
        const [derived, main] = await Promise.all([
          walletCore.signMessage('ping', SIGNING_ACCOUNT_INDEX),
          walletCore.getPublicKey()
        ])
        return {
          pubkey: derived.pubkey,
          address: derived.address,
          pingSignature: derived.signature,
          originAddress: main.address,
          signingMode: mode,
          createdAt: Date.now()
        }
      }
      const result = await walletCore.signMessage('ping')
      return {
        pubkey: result.pubkey,
        address: result.address,
        pingSignature: result.signature,
        signingMode: mode,
        createdAt: Date.now()
      }
    }

    if (mode === 'legacy_index0') {
      const result = await walletCore.getPublicKey(undefined, 0)
      return {
        pubkey: result.pubkey,
        address: result.address,
        signingMode: mode,
        createdAt: Date.now()
      }
    }
    if (mode === 'derived') {
      const [derived, main] = await Promise.all([
        walletCore.getPublicKey(SIGNING_ACCOUNT_INDEX),
        walletCore.getPublicKey()
      ])
      return {
        pubkey: derived.pubkey,
        address: derived.address,
        originAddress: main.address,
        signingMode: mode,
        createdAt: Date.now()
      }
    }
    const result = await walletCore.getPublicKey()
    return {
      pubkey: result.pubkey,
      address: result.address,
      signingMode: mode,
      createdAt: Date.now()
    }
  })
}

export function clearIdentityCache(walletId?: string, accountId?: string): void {
  if (!walletId) {
    identityCache.clear()
    identityInFlight.clear()
    return
  }

  for (const key of [...identityCache.keys()]) {
    const parts = key.split(':')
    if (parts[1] !== walletId) continue
    if (accountId && parts[2] !== accountId) continue
    identityCache.delete(key)
  }
  for (const key of [...identityInFlight.keys()]) {
    const parts = key.split(':')
    if (parts[1] !== walletId) continue
    if (accountId && parts[2] !== accountId) continue
    identityInFlight.delete(key)
  }
}
