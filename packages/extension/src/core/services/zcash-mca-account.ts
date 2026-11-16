import { getMcaByWallet } from '@rhea-finance/cross-chain-sdk'
import { getMcaCacheKey, runMcaCheckDeduped } from './zcash-mca-cache'

export type McaSigningMode = 'derived' | 'legacy' | 'legacy_index0'
export type ResolveZcashMcaPublicKey = (mode: McaSigningMode) => Promise<string>

export interface McaAccountStatus {
  mcaId: string | null
  publicKey: string | null
  signingMode: McaSigningMode
}

/**
 * Auto-detect MCA account with priority:
 * 1. legacy BIP-44 index 0 pubkey -> if bound MCA exists, use it
 * 2. derived pubkey -> if bound MCA exists, use it
 * 3. no MCA found -> default to derived mode for new users
 */
export async function checkZcashMcaAccount(
  walletId?: string,
  accountId?: string,
  resolveZcashPublicKey?: ResolveZcashMcaPublicKey
): Promise<McaAccountStatus> {
  if (!walletId || !accountId || !resolveZcashPublicKey) {
    throw new Error('Wallet, account ID and identity resolver required for MCA check')
  }

  const cacheKey = getMcaCacheKey(walletId, accountId)

  return runMcaCheckDeduped(cacheKey, async () => {
    const legacyPublicKey = await resolveZcashPublicKey('legacy')
    if (legacyPublicKey) {
      const mcaId = await getMcaByWallet({
        chain: 'zcash',
        identityKey: legacyPublicKey
      })
      if (mcaId) {
        return { mcaId, publicKey: legacyPublicKey, signingMode: 'legacy_index0' }
      }
    }

    const derivedPublicKey = await resolveZcashPublicKey('derived')
    if (derivedPublicKey) {
      const mcaId = await getMcaByWallet({
        chain: 'zcash',
        identityKey: derivedPublicKey
      })
      if (mcaId) {
        return { mcaId, publicKey: derivedPublicKey, signingMode: 'derived' }
      }
    }

    return {
      mcaId: null,
      publicKey: derivedPublicKey || null,
      signingMode: 'derived'
    }
  })
}
