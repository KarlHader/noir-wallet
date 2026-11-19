import { parseNearAccountId } from '@/core/chains/near'
import type { NearReadRpc } from '@/infrastructure/chains/near/near-rpc-types'
import { getMcaCacheKey, runMcaCheckDeduped } from './zcash-mca-cache'

const RHEA_MCA_CONTRACT = 'multica.near'

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
  walletId: string,
  accountId: string,
  resolveZcashPublicKey: ResolveZcashMcaPublicKey,
  rpc: Pick<NearReadRpc, 'viewFunction'>
): Promise<McaAccountStatus> {
  if (!walletId || !accountId || !resolveZcashPublicKey) {
    throw new Error('Wallet, account ID and identity resolver required for MCA check')
  }

  const cacheKey = getMcaCacheKey(walletId, accountId)
  const getMcaByPublicKey = async (publicKey: string): Promise<string | null> => {
    const result = await rpc.viewFunction(
      RHEA_MCA_CONTRACT,
      'get_mca_by_wallet',
      { wallet: { Zcash: publicKey } },
      { finality: 'optimistic' }
    )
    return result === null ? null : parseNearAccountId(result, 'MCA account ID')
  }

  return runMcaCheckDeduped(cacheKey, async () => {
    const legacyPublicKey = await resolveZcashPublicKey('legacy')
    if (legacyPublicKey) {
      const mcaId = await getMcaByPublicKey(legacyPublicKey)
      if (mcaId) {
        return { mcaId, publicKey: legacyPublicKey, signingMode: 'legacy_index0' }
      }
    }

    const derivedPublicKey = await resolveZcashPublicKey('derived')
    if (derivedPublicKey) {
      const mcaId = await getMcaByPublicKey(derivedPublicKey)
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
