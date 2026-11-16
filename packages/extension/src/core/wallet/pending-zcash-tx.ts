import { resolveAccountScope } from './account-scope'
import { useWalletStore, waitForHydration } from '@/store/wallet-store'

const PENDING_ZCASH_TX_KEY = 'pending_zcash_transactions'

export async function hasPendingZcashTxForWallet(walletId: string): Promise<boolean> {
  try {
    await waitForHydration()
    const result = await chrome.storage.local.get(PENDING_ZCASH_TX_KEY)
    const stored = result[PENDING_ZCASH_TX_KEY]
    if (!Array.isArray(stored)) return false

    const wallets = useWalletStore.getState().wallets
    return stored.some(tx => {
      if (!tx || typeof tx !== 'object') return false
      return resolveAccountScope(tx, wallets)?.walletId === walletId
    })
  } catch {
    return false
  }
}
