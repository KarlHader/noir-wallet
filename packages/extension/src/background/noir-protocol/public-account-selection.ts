import Big from '@/lib/big'
import { getZcashChainId } from '@/core/chains/registry'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import type { Caip25StoredScope } from '@/core/dapp/caip25'
import { dappManager } from '@/core/dapp/dapp-manager'
import { requirePublicConfig } from '@/core/services/noir-protocol/public/config'
import {
  isPublicScopeCandidate,
  choosePublicAccountCandidate,
  publicAccountLookupKey,
  publicScopeAuthorizesAccount,
  type PublicAccountCandidate,
  type PublicNativeGas
} from '@/core/services/noir-protocol/public/account-selection'
import type { NoirPublicAccount } from '@/core/services/noir-protocol/public/types'
import { createConfiguredEvmRpcClient } from '@/infrastructure/chains/evm'
import { readPublicAccountProjection } from '@/infrastructure/noir-protocol/public-account-projection'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { useAccountDataStore } from '@/store/account-data-store'
import {
  assertPublicContext,
  capturePublicContext,
  capturePublicEvmContext,
  type NoirPublicRequestContext
} from './public-context'

async function readNativeGas(context: NoirPublicRequestContext): Promise<PublicNativeGas> {
  if (!context.chainId) {
    const balance = useAccountDataStore
      .getState()
      .getBalance(context.network, context.walletId, context.accountId)
    const amount = balance?.spendable ?? balance?.available
    if (amount === undefined) return 'unknown'
    try {
      return new Big(amount).gt(0) ? 'positive' : 'zero'
    } catch {
      return 'unknown'
    }
  }
  const config = resolveEvmNetworkCatalog(DEFAULT_NETWORK, getActiveChainEndpointSettings()).find(
    network => network.chainId === context.chainId
  )
  if (!config || !context.evmAddress) return 'unknown'
  try {
    const raw = await createConfiguredEvmRpcClient(DEFAULT_NETWORK, config).getNativeBalance(
      context.evmAddress
    )
    const amount = BigInt(raw)
    return amount > 0n ? 'positive' : 'zero'
  } catch {
    return 'unknown'
  }
}

export async function selectPublicAccount(
  origin: string,
  authorizedScopes: readonly Caip25StoredScope[],
  getAccount: (context: NoirPublicRequestContext) => Promise<NoirPublicAccount>
): Promise<{ scope: string; account: NoirPublicAccount }> {
  const parent = requirePublicConfig(DEFAULT_NETWORK).parentContractId
  const zcashScope = getZcashChainId(DEFAULT_NETWORK)
  const eligible = authorizedScopes.filter(scope => isPublicScopeCandidate(scope, zcashScope))
  const contexts = await Promise.all(
    eligible.map(async scope => {
      try {
        const context =
          scope.chainId === zcashScope
            ? await capturePublicContext(origin)
            : await capturePublicEvmContext(origin, scope.chainId)
        const nativeAuthorization =
          scope.chainId === zcashScope ? await dappManager.getAuthorization(origin) : null
        if (nativeAuthorization && nativeAuthorization.revision !== context.authorizationRevision)
          return null
        return publicScopeAuthorizesAccount(
          scope,
          context,
          zcashScope,
          nativeAuthorization?.accounts
        )
          ? { scope: scope.chainId, context }
          : null
      } catch {
        return null
      }
    })
  )
  const authorized = contexts.filter(item => item !== null)
  if (authorized.length === 0) throw new Error('No authorized Public scope for the active account')

  const accounts = new Map<string, Promise<NoirPublicAccount | null>>()
  type CandidateWithContext = PublicAccountCandidate & {
    readonly context: NoirPublicRequestContext
  }
  const candidates = await Promise.all(
    authorized.map(async ({ scope, context }): Promise<CandidateWithContext | null> => {
      const key = publicAccountLookupKey(context)
      let accountPromise = accounts.get(key)
      if (!accountPromise) {
        accountPromise = getAccount(context).catch(async () => {
          const cached = await readPublicAccountProjection(
            context,
            parent,
            context.chainId ? 'evm' : 'zcash-l2'
          )
          return cached &&
            cached.status !== 'inactive' &&
            (!context.evmAddress || cached.publicKey === context.evmAddress)
            ? cached
            : null
        })
        accounts.set(key, accountPromise)
      }
      const account = await accountPromise
      if (!account) return null
      const nativeGas: PublicNativeGas = 'unknown'
      if (
        account.parentContractId !== parent ||
        account.network !== context.network ||
        account.chain !== (context.chainId ? 'evm' : 'zcash-l2') ||
        (context.evmAddress && account.publicKey !== context.evmAddress)
      )
        throw new Error('Public account identity does not match the selected scope')
      await assertPublicContext(context)
      return { scope, account, nativeGas, context }
    })
  )
  const known = candidates.filter(candidate => candidate !== null)
  let selected = choosePublicAccountCandidate(known, candidates.length - known.length)
  if (selected.account.mcaId === null && selected.account.status !== 'activating') {
    const funded = await Promise.all(
      known.map(async candidate => ({
        ...candidate,
        nativeGas: await readNativeGas(candidate.context)
      }))
    )
    selected = choosePublicAccountCandidate(funded, 0)
  }
  await assertPublicContext(selected.context)
  return { scope: selected.scope, account: selected.account }
}
