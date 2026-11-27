import type { EvmNetworkConfig } from '@/config/networks'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import type { AssetDefinitionInput } from '@/core/chains/registry'
import { isShieldUnlockRetryError } from '@/core/dapp/shield-provider'
import type { SwapToken } from '@/core/services/intents-api'
import type { CreateExternalShieldDepositInput } from '@/core/services/confidential-funding'
import { ExternalShieldDepositError } from '@/core/services/confidential-funding/confidential-external-deposit'
import { isAccountNetworkEnabled } from '@/core/wallet/account-network-selection'
import { mergeShieldedReceiveAddressHistory } from '@/core/wallet/shielded-address-history'
import { developmentErrorArgs } from '@/lib/development-console'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { accountContextTransition } from './account-context-transition'
import { createBackgroundConfidentialFundingCoordinator } from './confidential-funding'
import type {
  ConfidentialFundingCoordinator,
  PrepareConfidentialFundingInput
} from './confidential-funding-coordinator'
import { getConfidentialFundingMessageHandler } from './confidential-funding-messages'
import type { ChromeConfidentialFundingStore } from './confidential-funding-store'
import { credentialSession } from './credential-session'
import type { createBackgroundPortfolioCoordinator } from './portfolio'
import { handleShieldDAppRequest, resolveShieldDappScope } from './shield-dapp-handler'
import { broadcastShieldZcashDeposit } from './shield-zcash-deposit-broadcast'
import type { transactionMonitor } from './transaction-monitor'

type BackgroundPortfolioCoordinator = ReturnType<typeof createBackgroundPortfolioCoordinator>

export function createBackgroundShieldFundingRuntime(deps: {
  readonly evmNetworks: readonly EvmNetworkConfig[]
  readonly customEvmNetworks: readonly EvmNetworkConfig[]
  readonly userEvmAssets: readonly AssetDefinitionInput[]
  readonly protocolAssets: readonly AssetDefinitionInput[]
  readonly protocolTokens: readonly SwapToken[]
  readonly endpointSettings: ChainEndpointSettings
  readonly store: ChromeConfidentialFundingStore
  readonly getPortfolioCoordinator: () => BackgroundPortfolioCoordinator | null
}): ConfidentialFundingCoordinator | null {
  return createBackgroundConfidentialFundingCoordinator(
    deps.evmNetworks,
    deps.customEvmNetworks,
    deps.userEvmAssets,
    deps.protocolAssets,
    deps.protocolTokens,
    deps.endpointSettings,
    async target => {
      const coordinator = deps.getPortfolioCoordinator()
      if (!coordinator) return
      if (target.balanceUpdated) {
        if (await coordinator.isActiveAccount(target)) {
          await chrome.runtime
            .sendMessage({
              type: 'PORTFOLIO_UPDATED',
              walletId: target.keyDomainId,
              accountId: target.accountId
            })
            .catch(() => {})
        }
        return
      }
      await coordinator.invalidate(
        {
          network: DEFAULT_NETWORK,
          keyDomainId: target.keyDomainId,
          accountId: target.accountId
        },
        target.chainIds,
        { domain: target.domain ?? 'chain' }
      )
    },
    deps.store,
    {
      broadcastZcashShieldDeposit: broadcastShieldZcashDeposit,
      getNativeZecActiveAccount: () => {
        const state = useWalletStore.getState()
        const walletId = state.currentWalletId
        const accountId = state.currentAccountId
        const network = state.currentNetwork
        const account = walletId && accountId ? state.getAccount(walletId, accountId) : undefined
        const zcashAccount =
          account && isAccountNetworkEnabled(account, network, 'zcash') ? account : undefined
        const addresses = zcashAccount?.addresses
        const history = mergeShieldedReceiveAddressHistory(
          zcashAccount?.networkShieldedReceiveAddressHistory?.[network]
        )
        return {
          network,
          walletId,
          accountId,
          refundAddresses: [
            addresses?.transparent,
            addresses?.shielded,
            addresses?.fullUnified
          ].filter((address): address is string => Boolean(address)),
          shieldedRefundAddressHistory: history.flatMap(({ shielded, fullUnified }) => [
            shielded,
            fullUnified
          ])
        }
      }
    }
  )
}

export function attachShieldFundingRuntime(
  coordinator: ConfidentialFundingCoordinator | null,
  options: {
    readonly transactionMonitor: Pick<typeof transactionMonitor, 'setConfidentialBalanceRefresher'>
    readonly resumeRecovery: boolean
  }
): void {
  options.transactionMonitor.setConfidentialBalanceRefresher(
    coordinator
      ? scope =>
          coordinator.refreshBalances(
            {
              network: DEFAULT_NETWORK,
              keyDomainId: scope.walletId,
              accountId: scope.accountId
            },
            false
          )
      : undefined
  )
  if (options.resumeRecovery) {
    void coordinator?.resumeAll().catch(error => {
      console.warn(
        '[Confidential Funding] Startup recovery failed:',
        error instanceof Error ? error.name : 'UnknownError'
      )
    })
  }
}

export async function handleShieldDappChainRequest(input: {
  readonly method: string
  readonly params: unknown
  readonly origin: string
  readonly getCoordinator: () => ConfidentialFundingCoordinator | null
  readonly promptUnlock: () => Promise<void>
  readonly readActiveAccount: () => Promise<Readonly<{
    reference: Readonly<{ walletId: string; accountId: string }>
  }> | null>
  readonly requestExternalApproval: (
    origin: string,
    action: string,
    summary: Readonly<Record<string, string>>
  ) => Promise<Readonly<{ approved: boolean }>>
}): Promise<unknown> {
  if (!(await credentialSession.hasUnlockSession())) await input.promptUnlock()
  await rehydrateWalletStore()
  const readShieldScope = async () => {
    const wallet = useWalletStore.getState()
    if (wallet.currentNetwork !== DEFAULT_NETWORK) return null
    const active = await input.readActiveAccount()
    return resolveShieldDappScope({
      network: wallet.currentNetwork,
      activeAccount: active
        ? {
            walletId: active.reference.walletId,
            accountId: active.reference.accountId
          }
        : null,
      retainedWalletId: wallet.currentWalletId,
      retainedAccountId: wallet.currentAccountId
    })
  }
  // Signing acquires this same account-context lock. Holding it around
  // the handler deadlocks the first connect and drops the dApp response.
  const requestShield = async () =>
    handleShieldDAppRequest({
      method: input.method,
      params: input.params,
      coordinator: input.getCoordinator(),
      origin: input.origin,
      scope: await readShieldScope(),
      readScope: readShieldScope,
      requestApproval: async (action, summary) => {
        const decision = await input.requestExternalApproval(input.origin, action, summary)
        return decision.approved
      },
      unlock: async () => {
        await input.promptUnlock()
        await rehydrateWalletStore()
      }
    })
  try {
    return await requestShield()
  } catch (error) {
    if (!isShieldUnlockRetryError(error)) throw error
    await input.promptUnlock()
    await rehydrateWalletStore()
    return await requestShield()
  }
}

/**
 * Routes confidential funding runtime messages. Returns false when the message
 * type is not owned by confidential funding so the caller keeps dispatching.
 */
export function routeConfidentialFundingMessage(
  message: Readonly<Record<string, unknown>> & { readonly type: string },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
  deps: {
    readonly getCoordinator: () => ConfidentialFundingCoordinator | null
    readonly refreshIntentsProtocolAssets: (force: boolean) => Promise<void>
  }
): boolean {
  const handler = getConfidentialFundingMessageHandler(message.type)
  if (!handler) return false
  if (
    (message.type === 'PREPARE_NATIVE_ZEC_INTENTS_SWAP' ||
      message.type === 'GET_NATIVE_ZEC_INTENTS_SWAP' ||
      message.type === 'GET_NATIVE_ZEC_INTENTS_SWAP_STATUS' ||
      message.type === 'CANCEL_NATIVE_ZEC_INTENTS_SWAP') &&
    getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'extension-page'
  ) {
    sendResponse({ error: 'Unauthorized native ZEC Intents Swap request' })
    return true
  }
  const coordinator = deps.getCoordinator()
  if (!coordinator) {
    sendResponse({ error: 'Confidential funding is unavailable in this network' })
    return true
  }
  if (
    message.type === 'CHECK_CONFIDENTIAL_FUNDING_SUBMISSION' &&
    getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'extension-page'
  ) {
    sendResponse({ error: 'Unauthorized confidential funding request' })
    return true
  }
  const operation = Promise.resolve().then(async () => {
    if (
      message.type === 'CREATE_EXTERNAL_SHIELD_DEPOSIT' &&
      !coordinator.hasExternalDepositAsset(
        (message.request as CreateExternalShieldDepositInput).source
      )
    ) {
      // The receive page can refresh its catalog after this runtime was constructed.
      await deps.refreshIntentsProtocolAssets(true)
    }
    if (
      (message.type === 'PREVIEW_CONFIDENTIAL_FUNDING' ||
        message.type === 'PREPARE_CONFIDENTIAL_FUNDING') &&
      !coordinator.hasCurrentFundingAssets(message.request as PrepareConfidentialFundingInput)
    ) {
      await deps.refreshIntentsProtocolAssets(true)
    }
    const currentCoordinator = deps.getCoordinator()
    if (!currentCoordinator) throw new Error('Confidential funding is unavailable in this network')
    return handler({ coordinator: currentCoordinator, accountContextTransition }, message as never)
  })
  void operation
    .then(result => sendResponse({ result }))
    .catch(error => {
      console.error(
        '[Confidential Funding] Request failed',
        {
          operation: message.type,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          ...(error instanceof ExternalShieldDepositError ? { failureStage: error.stage } : {})
        },
        ...developmentErrorArgs(error)
      )
      sendResponse({
        error: error instanceof Error ? error.message : 'Confidential funding request failed',
        ...(message.type === 'REFRESH_CONFIDENTIAL_BALANCES' &&
        error instanceof Error &&
        'balanceErrorCode' in error &&
        ['authorization_required', 'account_unavailable', 'balance_unavailable'].includes(
          String(error.balanceErrorCode)
        )
          ? { balanceErrorCode: error.balanceErrorCode }
          : {}),
        ...(error instanceof ExternalShieldDepositError ? { depositStage: error.stage } : {})
      })
    })
  return true
}
