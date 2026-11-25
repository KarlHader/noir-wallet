import { trackEvent } from '@/background/analytics/reporter'
import { EXTENSION_ACTIVITY_ROUTE, EXTENSION_POPUP_PATH } from '@/config/extension'
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
import {
  BackgroundEvmDAppHandler,
  type EvmDAppSendQueueBlock,
  type EvmDAppTabInfo
} from './evm-dapp-handler'
import { Eip1193ProviderError, type ParsedEip1193ChainRequest } from '@/core/dapp/eip1193'
import { readWalletMetadata, setAccountNetworkSelection } from '@/lib/wallet-metadata-storage'
import { rehydrateWalletStore } from '@/store/wallet-store'
import { parseChainId } from '@/core/chains/registry'
import {
  filterEnabledDAppContext,
  isDAppNetworkEnabled,
  listDAppChainAccounts
} from './dapp-chain-account-catalog'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm/evm-account'
import { PrivateExecutionUnavailableError } from '@/core/dapp/dapp-execution-mode'
import { dappExecutionModeCoordinator } from './dapp-execution-mode'
import { evmDAppOperationStore } from './evm-dapp-operation-store'
import type { RheaSwapService } from '@/core/services/rhea-swap'
import type { RheaSwapEvmSignatureCoordinator } from './rhea-swap-evm-signature'
import { EvmDAppPrivateTransferCoordinator } from './evm-dapp-private-transfer'
import { EVM_TRANSACTION_MONITOR_ALARM } from './evm-transaction-monitor'
import { NEAR_INTENTS_TRANSACTION_MONITOR_ALARM } from './near-intents-transaction-monitor'

const SEND_QUEUE_NOTIFICATION_ID = 'evm-dapp-send-queue'

export function registerEvmDAppSendQueueNotification(): void {
  chrome.notifications.onClicked.addListener(notificationId => {
    if (notificationId !== SEND_QUEUE_NOTIFICATION_ID) return
    void chrome.tabs
      .create({ url: chrome.runtime.getURL(`${EXTENSION_POPUP_PATH}#${EXTENSION_ACTIVITY_ROUTE}`) })
      .catch(() => {})
    chrome.notifications.clear(notificationId, () => void chrome.runtime.lastError)
  })
}

async function notifySendQueueBlocked(reason: EvmDAppSendQueueBlock): Promise<void> {
  await chrome.notifications.create(SEND_QUEUE_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Transaction not sent',
    message:
      reason === 'nonce-recovery-required'
        ? 'Open Activity to review the pending transaction before retrying.'
        : 'Unable to verify the send queue. Try again.'
  })
}

async function notifyTransactionSubmitted(confidential = false): Promise<void> {
  await Promise.all([
    chrome.alarms.create(EVM_TRANSACTION_MONITOR_ALARM, { when: Date.now() + 100 }),
    ...(confidential
      ? [chrome.alarms.create(NEAR_INTENTS_TRANSACTION_MONITOR_ALARM, { when: Date.now() + 100 })]
      : []),
    chrome.runtime.sendMessage({ type: 'TRANSACTION_ADDED' }).catch(() => {})
  ])
}

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
          readSlippageBps: readPrivateTransferSlippageBps,
          onExactOutputSubmitted: () => notifyTransactionSubmitted(true)
        })
      : undefined
  return new BackgroundEvmDAppHandler({
    analytics: trackEvent,
    network,
    manager: dappManager,
    approval: dappHandler,
    loadActiveContext: async () =>
      filterEnabledDAppContext(
        await loadActiveEvmPortfolioContext(storageRepository, network.chainId),
        'evm'
      ),
    readDisabledNetworkAccount: async () => {
      const context = await loadActiveEvmPortfolioContext(storageRepository, network.chainId)
      return context?.keyDomainSource.kind === 'software' ? context : null
    },
    enableAccountNetwork: async ({ walletId, accountId }) => {
      const snapshot = await readWalletMetadata()
      const state = snapshot?.state
      const wallet = state?.wallets.find(item => item.id === walletId)
      const account = wallet?.accounts.find(item => item.id === accountId)
      if (
        state?.currentWalletId !== walletId ||
        state.currentAccountId !== accountId ||
        state.currentNetwork !== network.networkMode ||
        !account ||
        (wallet?.keySource !== undefined && wallet.keySource !== 'software')
      ) {
        throw new Eip1193ProviderError(4100, 'Wallet account changed. Connect again.')
      }
      const families = account.networkSelections?.[network.networkMode]
      if (!families || families.includes('evm')) return
      const chainIds = account.networkChainSelections?.[network.networkMode]
      await setAccountNetworkSelection(
        walletId,
        accountId,
        network.networkMode,
        [...families, 'evm'],
        undefined,
        chainIds ? [...new Set([...chainIds, network.chainId])] : undefined
      )
      await rehydrateWalletStore()
      void chrome.runtime.sendMessage({ type: 'ACCOUNT_CONTEXT_CHANGED' }).catch(() => {})
    },
    listAccounts: () =>
      listDAppChainAccounts({
        repository: storageRepository,
        chainId: network.chainId,
        family: 'evm',
        isNetworkEnabled: isDAppNetworkEnabled,
        resolveAddress: ({ chainAccount }) =>
          parseEvmAccountBinding(
            chainAccount,
            parseChainId(network.chainId).id
          ).address.toLowerCase()
      }),
    hasUnlockSession: () => credentialSession.hasUnlockSession(),
    runActiveOperation: operation => accountContextTransition.runActiveOperation(operation),
    transferController,
    onTransactionSubmitted: () => notifyTransactionSubmitted(),
    onSendQueueBlocked: notifySendQueueBlocked,
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
