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
  readonly supportsSessionChain: (chainId: string) => boolean
  readonly connectEvm: (origin: string) => Promise<void>
  readonly connectZcash: (origin: string) => Promise<void>
  readonly connectPublic?: (origin: string) => Promise<void>
  readonly connectSession: (origin: string) => Promise<void>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
}

const PUBLIC_CHAIN_ID = 'noir:mainnet'

/** Keeps wallet-side connection status and authorization on the same account scope. */
export class WalletDAppConnectionCoordinator {
  constructor(private readonly options: WalletDAppConnectionOptions) {}

  private targets(dapp: ConnectedDApp, active: WalletDAppActiveAccount) {
    const evmChainId = this.options.getEvmChainId()
    const hasZcash = active.chainIds.includes(this.options.getZcashChainId())
    const sessionScopes = dapp.caip25Session?.scopes.filter(scope =>
      this.options.supportsSessionChain(scope.chainId)
    )
    const includesNativeChain = (chainId: string) =>
      sessionScopes === undefined || sessionScopes.some(scope => scope.chainId === chainId)
    const sessionAuthorized = sessionScopes?.every(scope =>
      dapp.chainAuthorizations
        ?.find(authorization => authorization.chainId === scope.chainId)
        ?.accounts.some(
          account =>
            account.walletId === active.reference.walletId &&
            account.accountId === active.reference.accountId
        )
    )
    return {
      evm:
        active.chainIds.includes(evmChainId) && includesNativeChain(evmChainId)
          ? dapp.chainAuthorizations?.find(authorization => authorization.chainId === evmChainId)
          : undefined,
      zcash:
        hasZcash &&
        includesNativeChain(this.options.getZcashChainId()) &&
        (dapp.authorizedAccounts !== undefined || dapp.boundWalletId !== undefined),
      public: hasZcash
        ? dapp.chainAuthorizations?.find(authorization => authorization.chainId === PUBLIC_CHAIN_ID)
        : undefined,
      session: sessionScopes?.length ? dapp.caip25Session : undefined,
      sessionAuthorized
    }
  }

  getCurrentTabDAppStatus() {
    return this.options.runActiveOperation(async () => {
      const dapp = await this.options.getCurrentTabDApp()
      if (!dapp) return { dapp: null, currentAccountAuthorized: false }
      const active = await this.options.loadActiveAccount()
      if (!active) return { dapp, currentAccountAuthorized: false }
      const targets = this.targets(dapp, active)
      const matches = (account: AccountRef) =>
        account.walletId === active.reference.walletId &&
        account.accountId === active.reference.accountId
      const grantsAuthorized =
        targets.evm || targets.zcash || targets.public
          ? (!targets.evm || targets.evm.accounts.some(matches)) &&
            (!targets.zcash || connectionAuthorizesAccount(dapp, active.reference)) &&
            (!targets.public || targets.public.accounts.some(matches))
          : targets.session
            ? targets.sessionAuthorized === true
            : !dapp.caip25Session &&
              connectionAuthorizesAccountForWalletStatus(dapp, active.reference)
      const currentAccountAuthorized =
        grantsAuthorized && (!targets.session || targets.sessionAuthorized === true)
      return { dapp, currentAccountAuthorized }
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
        if (!targets.evm && !targets.zcash && !targets.public && !targets.session) {
          throw new Error('Reconnect from the site to update this network permission')
        }
        return targets
      })
      .then(async targets => {
        // Connection callbacks may open approval and must acquire their own account
        // transition lock when committing after the approval returns.
        if (targets.session) {
          if (!targets.sessionAuthorized) await this.options.connectSession(origin)
        } else {
          if (targets.evm) await this.options.connectEvm(origin)
          if (targets.zcash) await this.options.connectZcash(origin)
        }
        if (targets.public) {
          if (!this.options.connectPublic) {
            throw new Error('Public connection is unavailable')
          }
          await this.options.connectPublic(origin)
        }
      })
  }
}
