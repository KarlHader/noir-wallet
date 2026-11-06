import { dappManager } from '@/core/dapp/dapp-manager'
import { publicIdentityAddressIndex } from '@/core/services/noir-protocol/public/identity'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import type { Network } from '@/types'
import { credentialSession } from '../credential-session'
import { accountContextTransition } from '../account-context-transition'
import { loadActiveEvmPortfolioContext, parseEvmAccountBinding } from '@/infrastructure/chains/evm'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import { dappExecutionModeCoordinator, dappExecutionModeRequestGate } from '../dapp-execution-mode'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import { parseChainId } from '@/core/chains/registry'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'

const evmStorage = new IndexedDbStorageV2Repository()
const evmSigner = new EvmMultichainSigningClient({ credentials: credentialSession })

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
  readonly chainId?: string
  readonly evmAddress?: string
  readonly evmExecutionMode?: 'main' | 'private'
  readonly generationId?: string
  readonly executionModeRevision?: number
}

async function activeEvmIdentity(chainId: string) {
  const active = await loadActiveEvmPortfolioContext(evmStorage, chainId)
  if (!active) throw new Error('No active EVM account')
  if (!supportsEvmPrivateExecution(active.keyDomainSource))
    throw new Error('Public requires a supported EVM signing account')
  const binding = parseEvmAccountBinding(active.chainAccount, parseChainId(chainId).id)
  const reference = active.chainAccount.scope
  const modeToken = dappExecutionModeRequestGate.capture({
    network: DEFAULT_NETWORK,
    keyDomainId: reference.keyDomainId,
    accountId: reference.accountId
  })
  await dappExecutionModeRequestGate.waitForStable(modeToken)
  const mode = await dappExecutionModeCoordinator.read({
    network: DEFAULT_NETWORK,
    keyDomainId: reference.keyDomainId,
    accountId: reference.accountId
  })
  const address =
    mode.mode === 'private'
      ? (await evmSigner.deriveGlobalPea(reference.keyDomainId, binding.addressIndex)).address
      : binding.address
  await dappExecutionModeRequestGate.waitForStable(modeToken)
  return { active, binding, address: address.toLowerCase(), mode: mode.mode, modeToken }
}

export async function capturePublicEvmContext(
  origin: string,
  chainIdValue: string
): Promise<NoirPublicRequestContext> {
  const chain = parseChainId(chainIdValue)
  if (chain.namespace !== 'eip155') throw new Error('Public EVM requires an EVM scope')
  if (!(await credentialSession.hasUnlockSession()))
    throw new Error('Unlock the wallet to continue')
  const identity = await activeEvmIdentity(chain.id)
  const reference = identity.active.chainAccount.scope
  const context: NoirPublicRequestContext = {
    walletId: reference.keyDomainId,
    accountId: reference.accountId,
    derivationIndex: identity.binding.addressIndex,
    network: DEFAULT_NETWORK,
    origin,
    internal: false,
    authorizationRevision: await dappManager.getAuthorizationRevision(origin),
    requestEpoch,
    chainId: chain.id,
    evmAddress: identity.address,
    evmExecutionMode: identity.mode,
    generationId: identity.active.generationId,
    executionModeRevision: identity.modeToken.revision
  }
  await assertPublicContext(context)
  return context
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
  if (context.chainId) {
    if (
      context.network !== DEFAULT_NETWORK ||
      !context.evmAddress ||
      !context.generationId ||
      context.executionModeRevision === undefined
    )
      throw new Error('Invalid Public EVM account context')
    if (!(await credentialSession.hasUnlockSession()))
      throw new Error('Unlock the wallet to continue')
    const modeToken = {
      scope: {
        network: DEFAULT_NETWORK,
        keyDomainId: parseKeyDomainId(context.walletId),
        accountId: parseAccountId(context.accountId)
      },
      revision: context.executionModeRevision
    }
    await dappExecutionModeRequestGate.waitForStable(modeToken)
    const identity = await activeEvmIdentity(context.chainId)
    const scope = identity.active.chainAccount.scope
    if (
      context.requestEpoch !== requestEpoch ||
      scope.keyDomainId !== context.walletId ||
      scope.accountId !== context.accountId ||
      identity.active.generationId !== context.generationId ||
      identity.binding.addressIndex !== context.derivationIndex ||
      identity.modeToken.revision !== context.executionModeRevision ||
      identity.mode !== context.evmExecutionMode ||
      identity.address !== context.evmAddress
    )
      throw new Error('EVM account or execution mode changed. Review the request again.')
    const [revision, authorization] = await Promise.all([
      dappManager.getAuthorizationRevision(context.origin),
      dappManager.getChainAuthorization(context.origin, context.chainId)
    ])
    if (
      revision !== context.authorizationRevision ||
      !authorization?.accounts.some(
        account => account.walletId === context.walletId && account.accountId === context.accountId
      )
    )
      throw new Error('Wallet connection changed. Reconnect and try again.')
    await dappExecutionModeRequestGate.waitForStable(modeToken)
    return
  }
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
