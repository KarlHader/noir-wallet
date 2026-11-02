import { trackEvent } from '@/background/analytics/reporter'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { getEvmNetworkConfig, type EvmNetworkConfig } from '@/config/networks'
import {
  createConfiguredEvmRpcClient,
  loadActiveEvmPortfolioContext
} from '@/infrastructure/chains/evm'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import { dappManager } from '@/core/dapp/dapp-manager'
import { accountContextTransition } from './account-context-transition'
import type { BackgroundEvmTransferController } from './evm-transfer-controller'
import { credentialSession } from './credential-session'
import { dappHandler } from './dapp-handler'
import { BackgroundEvmDAppHandler, type EvmDAppTabInfo } from './evm-dapp-handler'
import type { ParsedEip1193ChainRequest } from '@/core/dapp/eip1193'
import { parseChainId } from '@/core/chains/registry'
import { listDAppChainAccounts } from './dapp-chain-account-catalog'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm/evm-account'
import { PrivateExecutionUnavailableError } from '@/core/dapp/dapp-execution-mode'
import { dappExecutionModeCoordinator } from './dapp-execution-mode'
import { evmDAppOperationStore } from './evm-dapp-operation-store'
import type { RheaSwapService } from '@/core/services/rhea-swap'
import type { RheaSwapEvmSignatureCoordinator } from './rhea-swap-evm-signature'
import { EvmDAppPrivateTransferCoordinator } from './evm-dapp-private-transfer'

async function readPrivateTransferSlippageBps(): Promise<number> {
  const stored = (await chrome.storage.local.get('swap_preferences')).swap_preferences
  const state =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>).state
      : null
  const slippage =
    state && typeof state === 'object' && !Array.isArray(state)
      ? (state as Record<string, unknown>).slippage
      : undefined
  return typeof slippage === 'number' && Number.isFinite(slippage)
    ? Math.round(slippage * 100)
    : 100
}

export function createBackgroundEvmDAppHandler(
  transferController: BackgroundEvmTransferController | null,
  network: EvmNetworkConfig = getEvmNetworkConfig(DEFAULT_NETWORK),
  switchNetwork?: (
    requested: ParsedEip1193ChainRequest,
    origin: string,
    action: 'switch' | 'add',
    tabInfo: EvmDAppTabInfo
  ) => Promise<void>,
  rhea?: Readonly<{
    service: RheaSwapService
    signatureCoordinator: RheaSwapEvmSignatureCoordinator
  }>
): BackgroundEvmDAppHandler {
  const storageRepository = new IndexedDbStorageV2Repository()
  const signer = new EvmMultichainSigningClient({ credentials: credentialSession })
  const privateTransfer =
    transferController && rhea && network.networkMode === 'mainnet'
      ? new EvmDAppPrivateTransferCoordinator({
          analytics: trackEvent,
          network,
          service: rhea.service,
          signatureCoordinator: rhea.signatureCoordinator,
          transferController,
          approval: dappHandler,
          readSlippageBps: readPrivateTransferSlippageBps
        })
      : undefined
  return new BackgroundEvmDAppHandler({
    analytics: trackEvent,
    network,
    manager: dappManager,
    approval: dappHandler,
    loadActiveContext: () => loadActiveEvmPortfolioContext(storageRepository, network.chainId),
    listAccounts: () =>
      listDAppChainAccounts({
        repository: storageRepository,
        chainId: network.chainId,
        family: 'evm',
        resolveAddress: ({ chainAccount }) =>
          parseEvmAccountBinding(
            chainAccount,
            parseChainId(network.chainId).id
          ).address.toLowerCase()
      }),
    hasUnlockSession: () => credentialSession.hasUnlockSession(),
    runActiveOperation: operation => accountContextTransition.runActiveOperation(operation),
    transferController,
    ...(privateTransfer === undefined ? {} : { privateTransfer }),
    operationStore: evmDAppOperationStore,
    signer,
    rpc: createConfiguredEvmRpcClient(DEFAULT_NETWORK, network),
    resolveExecutionIdentity: async ({ context, reference, mainAddress, mainAddressIndex }) => {
      const state = await dappExecutionModeCoordinator.read({
        network: DEFAULT_NETWORK,
        keyDomainId: reference.walletId,
        accountId: reference.accountId
      })
      if (state.mode === 'main') return Object.freeze({ mode: 'main', address: mainAddress })
      if (!supportsEvmPrivateExecution(context.keyDomainSource)) {
        throw new PrivateExecutionUnavailableError()
      }
      const pea = await signer.deriveGlobalPea(
        context.chainAccount.scope.keyDomainId,
        mainAddressIndex
      )
      return Object.freeze({ mode: 'private', address: pea.address })
    },
    ...(switchNetwork === undefined ? {} : { switchNetwork })
  })
}
