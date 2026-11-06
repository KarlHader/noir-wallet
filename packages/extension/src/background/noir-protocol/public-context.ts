import { dappManager } from '@/core/dapp/dapp-manager'
import { publicIdentityAddressIndex } from '@/core/services/noir-protocol/public/identity'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import type { Network } from '@/types'
import { credentialSession } from '../credential-session'
import { accountContextTransition } from '../account-context-transition'

// In-flight requests must stay invalid after an account switches away and back.
let requestEpoch = 0
export function getPublicRequestEpoch(): number {
  return requestEpoch
}
export function invalidatePublicRequestContexts(): void {
  requestEpoch += 1
}
accountContextTransition.registerInvalidator({
  invalidate: async () => invalidatePublicRequestContexts()
})
useWalletStore.subscribe((state, previous) => {
  if (
    state.currentWalletId !== previous.currentWalletId ||
    state.currentAccountId !== previous.currentAccountId ||
    state.currentNetwork !== previous.currentNetwork
  )
    invalidatePublicRequestContexts()
})

export interface NoirPublicRequestContext {
  readonly walletId: string
  readonly accountId: string
  readonly derivationIndex: number
  readonly network: Network
  readonly origin: string
  readonly internal: boolean
  readonly authorizationRevision: number
  readonly requestEpoch: number
}

export function publicTransactionScope(
  context: Pick<NoirPublicRequestContext, 'walletId' | 'accountId'>
) {
  return {
    keyDomainId: parseKeyDomainId(context.walletId),
    accountId: parseAccountId(context.accountId)
  }
}

export function publicInternalOrigin(): string {
  return `chrome-extension://${chrome.runtime.id}`
}

export async function capturePublicContext(
  origin: string,
  internal = false
): Promise<NoirPublicRequestContext> {
  await rehydrateWalletStore()
  const state = useWalletStore.getState()
  const wallet = state.getCurrentWallet()
  const account = wallet?.accounts.find(item => item.id === state.currentAccountId)
  if (!wallet || !account) throw new Error('No active wallet account')
  const context: NoirPublicRequestContext = {
    walletId: wallet.id,
    accountId: account.id,
    derivationIndex: publicIdentityAddressIndex(account.derivationIndex),
    network: state.currentNetwork,
    origin,
    internal,
    requestEpoch,
    authorizationRevision: await dappManager.getAuthorizationRevision(origin)
  }
  await assertPublicContext(context)
  return context
}

export async function assertPublicContext(context: NoirPublicRequestContext): Promise<void> {
  if (context.requestEpoch !== requestEpoch)
    throw new Error('Wallet context changed. Review the request again.')
  const state = useWalletStore.getState()
  const wallet = state.getWallet(context.walletId)
  const account = state.getAccount(context.walletId, context.accountId)
  if (
    state.currentNetwork !== context.network ||
    context.network !== DEFAULT_NETWORK ||
    state.currentWalletId !== context.walletId ||
    state.currentAccountId !== context.accountId ||
    !wallet ||
    !account ||
    account.derivationIndex !== context.derivationIndex
  )
    throw new Error('Wallet account or network changed. Review the request again.')
  if (wallet.keySource !== undefined && wallet.keySource !== 'software') {
    throw new Error('Public requires a recovery phrase wallet')
  }
  if (!(await credentialSession.hasUnlockSession()))
    throw new Error('Unlock the wallet to continue')
  if (context.internal) {
    if (context.origin !== publicInternalOrigin()) throw new Error('Invalid wallet request origin')
    if (context.requestEpoch !== requestEpoch) throw new Error('Wallet context changed')
    return
  }
  const authorization = await dappManager.getAuthorization(context.origin)
  if (
    context.requestEpoch !== requestEpoch ||
    authorization.revision !== context.authorizationRevision ||
    !authorization.accounts.some(
      account => account.walletId === context.walletId && account.accountId === context.accountId
    )
  )
    throw new Error('Wallet connection changed. Reconnect and try again.')
}
