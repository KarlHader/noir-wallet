import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { credentialLifecycle } from './credential-lifecycle'
import { accountContextTransition, type WalletAccountContext } from './account-context-transition'

export async function switchActiveAccountPersistently(walletId: string, accountId: string) {
  await rehydrateWalletStore()
  await backgroundZcashWalletRuntime.initialize()

  const target = Object.freeze({ walletId, accountId })
  let previous: WalletAccountContext | null = null
  return accountContextTransition.runAccountSwitch(target, {
    readCurrent: () => {
      const state = useWalletStore.getState()
      previous =
        state.currentWalletId && state.currentAccountId
          ? { walletId: state.currentWalletId, accountId: state.currentAccountId }
          : null
      return previous
    },
    validateTarget: () => {
      const wallet = useWalletStore.getState().getWallet(walletId)
      if (!wallet) throw new Error('Wallet not found')
      if (!wallet.accounts.some(account => account.id === accountId)) {
        throw new Error('Account not found')
      }
    },
    commit: async () => {
      await backgroundZcashWalletRuntime.switchAccountAuthoritatively(walletId, accountId)
      try {
        return await credentialLifecycle.selectActiveAccount(walletId, accountId)
      } catch (error) {
        if (previous && (previous.walletId !== walletId || previous.accountId !== accountId)) {
          try {
            await backgroundZcashWalletRuntime.switchAccountAuthoritatively(
              previous.walletId,
              previous.accountId
            )
          } catch {
            throw new Error('Active Account selection failed and the V1 pointer rollback failed')
          }
        }
        throw error
      }
    }
  })
}
