import {
  connectionAuthorizesAccount,
  connectionAuthorizesAccountForWalletStatus,
  getConnectionChainAuthorization,
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
  readonly supportsSessionChain: (chainId: string) => boolean
  readonly connectEvm: (origin: string) => Promise<void>
  readonly connectZcash: (origin: string) => Promise<void>
  readonly connectSession: (
    origin: string,
    chainIds: readonly string[],
    account: AccountRef
  ) => Promise<void>
  readonly notifyChainAccountsChanged: (
    origin: string,
    chainIds: readonly string[]
  ) => Promise<void>
  readonly notifySessionChanged: (origin: string) => Promise<void>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
}

/** Keeps wallet-side connection status and authorization on the same account scope. */
export class WalletDAppConnectionCoordinator {
  constructor(private readonly options: WalletDAppConnectionOptions) {}

  private targets(dapp: ConnectedDApp, active: WalletDAppActiveAccount) {
    const evmChainId = this.options.getEvmChainId()
    const zcashChainId = this.options.getZcashChainId()
    const hasZcash = active.chainIds.includes(zcashChainId)
    const sessionChains = dapp.caip25Session?.scopes
      .filter(
        scope =>
          active.chainIds.includes(scope.chainId) &&
          this.options.supportsSessionChain(scope.chainId)
      )
      .map(scope => scope.chainId)
    return {
      evm:
        !dapp.caip25Session && active.chainIds.includes(evmChainId)
          ? getConnectionChainAuthorization(dapp, evmChainId)
          : null,
      zcash:
        !dapp.caip25Session &&
        hasZcash &&
        (dapp.authorizedAccounts !== undefined || dapp.boundWalletId !== undefined),
      sessionChains: sessionChains ?? [],
      sessionConnectable:
        sessionChains !== undefined &&
        sessionChains.length > 0 &&
        sessionChains.every(chainId => getConnectionChainAuthorization(dapp, chainId) !== null),
      sessionAuthorized:
        sessionChains !== undefined &&
        sessionChains.length > 0 &&
        sessionChains.every(chainId =>
          getConnectionChainAuthorization(dapp, chainId)?.accounts.some(
            account =>
              account.walletId === active.reference.walletId &&
              account.accountId === active.reference.accountId
          )
        )
    }
  }

  getCurrentTabDAppStatus() {
    return this.options.runActiveOperation(async () => {
      const dapp = await this.options.getCurrentTabDApp()
      if (!dapp) {
        return { dapp: null, currentAccountAuthorized: false, currentAccountConnectable: false }
      }
      const active = await this.options.loadActiveAccount()
      if (!active) {
        return { dapp, currentAccountAuthorized: false, currentAccountConnectable: false }
      }
      const targets = this.targets(dapp, active)
      const matches = (account: AccountRef) =>
        account.walletId === active.reference.walletId &&
        account.accountId === active.reference.accountId
      const currentAccountAuthorized = dapp.caip25Session
        ? targets.sessionAuthorized
        : targets.evm || targets.zcash
          ? (!targets.evm || targets.evm.accounts.some(matches)) &&
            (!targets.zcash || connectionAuthorizesAccount(dapp, active.reference))
          : connectionAuthorizesAccountForWalletStatus(dapp, active.reference)
      return {
        dapp,
        currentAccountAuthorized,
        currentAccountConnectable: Boolean(
          dapp.caip25Session ? targets.sessionConnectable : targets.evm || targets.zcash
        )
      }
    })
  }

  connectCurrentAccount(origin: string): Promise<void> {
    return this.options
      .runActiveOperation(async () => {
        const dapp = await this.options.getConnection(origin)
        if (!dapp) throw new Error('No connection found for this site')
        const active = await this.options.loadActiveAccount()
        if (!active) throw new Error('No active account')
        const targets = this.targets(dapp, active)
        if (!(dapp.caip25Session ? targets.sessionConnectable : targets.evm || targets.zcash)) {
          throw new Error('Reconnect from the site to update this network permission')
        }
        return { targets, account: active.reference, hasSession: Boolean(dapp.caip25Session) }
      })
      .then(async ({ targets, account, hasSession }) => {
        // Approval callbacks can acquire the account-transition lock when committing.
        if (hasSession) {
          if (targets.sessionConnectable && !targets.sessionAuthorized) {
            await this.options.connectSession(origin, targets.sessionChains, account)
            await this.options.notifyChainAccountsChanged(origin, targets.sessionChains)
            await this.options.notifySessionChanged(origin)
            return
          }
        } else {
          if (targets.evm) await this.options.connectEvm(origin)
          if (targets.zcash) await this.options.connectZcash(origin)
        }
      })
  }
}
