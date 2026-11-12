import { trackEvent } from '@/background/analytics/reporter'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import { resolveQuantusDerivationScheme } from '@/core/chains/quantus'
import { getQuantusNetworkConfig } from '@/config/networks'
import { getQuantusChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { createConfiguredQuantusRpcClient } from '@/infrastructure/chains/quantus'
import { QuantusMultichainDerivationClient } from '@/infrastructure/keyring/multichain/quantus-derivation-client'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { dappManager } from '@/core/dapp/dapp-manager'
import { accountContextTransition } from './account-context-transition'
import { credentialSession } from './credential-session'
import { dappHandler } from './dapp-handler'
import { BackgroundQuantusDAppHandler, type ActiveQuantusDAppAccount } from './quantus-dapp-handler'
import type { BackgroundQuantusTransferController } from './quantus-transfer-controller'

const MAXIMUM_CACHED_PUBLIC_KEYS = 32

/**
 * Quantus dApp reads resolve the active Account's persisted ChainAccount, so the
 * provider and the wallet display the same identity. The ML-DSA public key is
 * not part of the persisted projection; it is re-derived through the Worker and
 * checked against the stored address. Only public material is memoized.
 */
export function createBackgroundQuantusDAppHandler(
  customRpcUrl?: string,
  transferController?: BackgroundQuantusTransferController
): BackgroundQuantusDAppHandler {
  const baseNetwork = getQuantusNetworkConfig(DEFAULT_NETWORK)
  const network = Object.freeze({
    ...baseNetwork,
    ...(customRpcUrl === undefined ? {} : { rpcUrl: customRpcUrl })
  })
  const storageRepository = new IndexedDbStorageV2Repository()
  const derivation = new QuantusMultichainDerivationClient({ credentials: credentialSession })
  const publicKeys = new Map<string, Readonly<{ address: string; publicKey: string }>>()

  const readPublicKey = async (
    keyDomainId: string,
    accountIndex: number,
    chainId: string,
    scheme: unknown,
    expectedAddress: string
  ): Promise<string> => {
    const cacheKey = `${keyDomainId}:${accountIndex}:${chainId}:${String(scheme)}`
    const cached = publicKeys.get(cacheKey)
    if (cached?.address === expectedAddress) return cached.publicKey
    const derived = await derivation.deriveAddress(parseKeyDomainId(keyDomainId), {
      chainId,
      scheme: resolveQuantusDerivationScheme(scheme),
      accountIndex,
      change: false,
      addressIndex: 0
    })
    if (derived.address !== expectedAddress) {
      throw new Error('Derived Quantus account does not match the persisted account')
    }
    if (publicKeys.size >= MAXIMUM_CACHED_PUBLIC_KEYS) {
      publicKeys.delete(publicKeys.keys().next().value as string)
    }
    publicKeys.set(
      cacheKey,
      Object.freeze({ address: expectedAddress, publicKey: derived.publicKey })
    )
    return derived.publicKey
  }

  const loadActiveAccount = async (): Promise<ActiveQuantusDAppAccount | null> => {
    const pointer = await storageRepository.getActivePointer()
    if (!pointer) return null
    const snapshot = await storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) return null
    const active = snapshot.manifest.activeAccount
    if (!active) return null
    const account = snapshot.accounts.find(
      candidate => candidate.id === active.accountId && candidate.keyDomainId === active.keyDomainId
    )
    if (!account) return null
    const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
    if (
      keyDomain.source.kind !== 'software' ||
      !keySourceSupportsChainFamily(keyDomain.source, 'quantus')
    ) {
      return null
    }
    const chainId = getQuantusChainId(DEFAULT_NETWORK)
    const chainAccount = snapshot.chainAccounts.find(
      candidate =>
        candidate.scope.keyDomainId === active.keyDomainId &&
        candidate.scope.accountId === active.accountId &&
        candidate.scope.chainId === chainId
    )
    if (
      !chainAccount ||
      chainAccount.identity.kind !== 'account-identifier' ||
      (chainAccount.derivation.scheme !== 'ml-dsa-87' &&
        chainAccount.derivation.scheme !== 'ml-dsa-65')
    ) {
      return null
    }
    const address = chainAccount.identity.value
    const publicKey = await readPublicKey(
      active.keyDomainId,
      account.accountIndex,
      chainId,
      chainAccount.derivation.scheme,
      address
    )
    return Object.freeze({
      keyDomainId: active.keyDomainId,
      accountId: active.accountId,
      accountIndex: account.accountIndex,
      address,
      publicKey,
      reference: Object.freeze({
        walletId: active.keyDomainId,
        accountId: active.accountId
      })
    })
  }

  return new BackgroundQuantusDAppHandler({
    analytics: trackEvent,
    network,
    manager: dappManager,
    approval: dappHandler,
    ...(transferController === undefined ? {} : { transferController }),
    loadActiveAccount,
    hasUnlockSession: () => credentialSession.hasUnlockSession(),
    runActiveOperation: operation => accountContextTransition.runActiveOperation(operation),
    rpc: createConfiguredQuantusRpcClient(network)
  })
}
