import { trackEvent } from '@/background/analytics/reporter'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveSolanaRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { dappManager } from '@/core/dapp/dapp-manager'
import { NativeTransferProviderError } from '@/core/dapp/native-transfer-provider'
import {
  createConfiguredSolanaRpcClient,
  parseSolanaPublicKey
} from '@/infrastructure/chains/solana'
import { SolanaMultichainSigningClient } from '@/infrastructure/keyring/multichain/solana-signing-client'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'

import { accountContextTransition } from './account-context-transition'
import { credentialSession } from './credential-session'
import { solanaLedgerSigningBridge } from './ledger-signing-bridge'
import { dappHandler } from './dapp-handler'
import { BackgroundNativeTransferDAppHandler } from './native-transfer-dapp-handler'
import { BackgroundSolanaDAppHandler } from './solana-dapp-handler'
import { loadActiveSolanaTransferContext } from './solana-transfer'
import {
  filterEnabledDAppContext,
  isDAppNetworkEnabled,
  listDAppChainAccounts
} from './dapp-chain-account-catalog'

export function createBackgroundSolanaDAppHandler(
  endpointSettings?: ChainEndpointSettings
): BackgroundSolanaDAppHandler {
  const network = resolveSolanaRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const storageRepository = new IndexedDbStorageV2Repository()
  const native = new BackgroundNativeTransferDAppHandler({
    analytics: trackEvent,
    providerId: 'solana',
    familyName: 'Solana',
    chainId: network.chainId,
    chainName: network.displayName,
    iconChain: 'solana',
    connectApprovalAction: 'solanaConnect',
    manager: dappManager,
    approval: dappHandler,
    loadActiveContext: async () =>
      filterEnabledDAppContext(
        await loadActiveSolanaTransferContext(storageRepository, network.chainId),
        'solana'
      ),
    listAccounts: () =>
      listDAppChainAccounts({
        repository: storageRepository,
        chainId: network.chainId,
        family: 'solana',
        isNetworkEnabled: isDAppNetworkEnabled,
        resolveAddress: ({ chainAccount }) =>
          chainAccount.identity.kind === 'account-identifier'
            ? parseSolanaPublicKey(chainAccount.identity.value)
            : null
      }),
    hasUnlockSession: () => credentialSession.hasUnlockSession(),
    runActiveOperation: operation => accountContextTransition.runActiveOperation(operation),
    parseAddress: parseSolanaPublicKey
  })
  const rpc = createConfiguredSolanaRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
  return new BackgroundSolanaDAppHandler({
    analytics: trackEvent,
    native,
    network,
    signer: new SolanaMultichainSigningClient({
      credentials: credentialSession,
      rpc,
      ledger: solanaLedgerSigningBridge
    }),
    rpc,
    requestApproval: (origin, action, data) =>
      dappHandler.requestExternalApproval(origin, action, data),
    runActiveOperation: operation => accountContextTransition.runActiveOperation(operation),
    loadAuthorizedAccount: async origin => {
      if (!(await credentialSession.hasUnlockSession())) {
        throw new NativeTransferProviderError(4100, 'Unlock Noir Wallet before signing.')
      }
      const context = await filterEnabledDAppContext(
        await loadActiveSolanaTransferContext(storageRepository, network.chainId),
        'solana'
      )
      if (!context || context.chainAccount.identity.kind !== 'account-identifier') {
        throw new NativeTransferProviderError(4100, 'The active wallet has no Solana account.')
      }
      const reference = Object.freeze({
        walletId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      })
      const authorization = await dappManager.getChainAuthorization(origin, network.chainId)
      if (
        !authorization?.accounts.some(
          account =>
            account.walletId === reference.walletId && account.accountId === reference.accountId
        )
      ) {
        throw new NativeTransferProviderError(4100, 'This site is not authorized for Solana.')
      }
      return Object.freeze({
        context,
        reference,
        address: parseSolanaPublicKey(context.chainAccount.identity.value)
      })
    }
  })
}
