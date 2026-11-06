import {
  connectionAuthorizesAccount,
  connectionAuthorizesAccountForWalletStatus,
  type AccountRef,
  type ConnectedDApp
} from '@/core/dapp/dapp-manager'

export interface WalletDAppActiveAccount {
  readonly reference: AccountRef
  readonly chainIds: readonly string[]
}

interface WalletDAppConnectionOptions {
  readonly getCurrentTabDApp: () => Promise<ConnectedDApp | null>
  readonly getConnection: (origin: string) => Promise<ConnectedDApp | null>
  readonly loadActiveAccount: () => Promise<WalletDAppActiveAccount | null>
  readonly getEvmChainId: () => string
  readonly getZcashChainId: () => string
  readonly connectEvm: (origin: string) => Promise<void>
  readonly connectZcash: (origin: string) => Promise<void>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
}

/** Keeps wallet-side connection status and authorization on the same account scope. */
export class WalletDAppConnectionCoordinator {
  constructor(private readonly options: WalletDAppConnectionOptions) {}

  private targets(dapp: ConnectedDApp, active: WalletDAppActiveAccount) {
    const evmChainId = this.options.getEvmChainId()
    return {
      evm: active.chainIds.includes(evmChainId)
        ? dapp.chainAuthorizations?.find(authorization => authorization.chainId === evmChainId)
        : undefined,
      zcash:
        active.chainIds.includes(this.options.getZcashChainId()) &&
        (dapp.authorizedAccounts !== undefined || dapp.boundWalletId !== undefined)
    }
  }

  getCurrentTabDAppStatus() {
    return this.options.runActiveOperation(async () => {
      const dapp = await this.options.getCurrentTabDApp()
      if (!dapp)
        return { dapp: null, currentAccountAuthorized: false, canConnectCurrentAccount: false }
      const active = await this.options.loadActiveAccount()
      if (!active) return { dapp, currentAccountAuthorized: false, canConnectCurrentAccount: false }
      const targets = this.targets(dapp, active)
      const canConnectCurrentAccount = !dapp.caip25Session && Boolean(targets.evm || targets.zcash)
      const matches = (account: AccountRef) =>
        account.walletId === active.reference.walletId &&
        account.accountId === active.reference.accountId
      const currentAccountAuthorized = canConnectCurrentAccount
        ? (!targets.evm || targets.evm.accounts.some(matches)) &&
          (!targets.zcash || connectionAuthorizesAccount(dapp, active.reference))
        : connectionAuthorizesAccountForWalletStatus(dapp, active.reference)
      return { dapp, currentAccountAuthorized, canConnectCurrentAccount }
    })
  }

  connectCurrentAccount(origin: string): Promise<void> {
    return this.options.runActiveOperation(async () => {
      const dapp = await this.options.getConnection(origin)
      if (!dapp) throw new Error('No connection found for this site')
      if (dapp.caip25Session) {
        throw new Error('Reconnect from the site to update this multichain session')
      }
      const active = await this.options.loadActiveAccount()
      if (!active) throw new Error('No active account')
      const targets = this.targets(dapp, active)
      if (!targets.evm && !targets.zcash) {
        throw new Error('Reconnect from the site to update this network permission')
      }
      // Both grants are updated under one account-transition lock. On failure,
      // status remains disconnected until every applicable grant is present.
      if (targets.evm) await this.options.connectEvm(origin)
      if (targets.zcash) await this.options.connectZcash(origin)
    })
  }
}
