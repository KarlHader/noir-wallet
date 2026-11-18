import type {
  CreateExternalShieldDepositInput,
  ExternalShieldDepositScope
} from '@/core/services/confidential-funding'
import type { AccountContextTransitionCoordinator } from './account-context-transition'
import type { PrepareNativeZecIntentsSwapInput } from '@/core/services/native-zec-intents-swap'
import type {
  ConfidentialFundingCoordinator,
  PrepareConfidentialFundingInput
} from './confidential-funding-coordinator'
import { CONFIDENTIAL_SESSION_REQUIRED_ERROR } from '@/core/services/confidential-funding'
import { ConfidentialFundingApiError } from './confidential-funding-api'
import { useWalletStore } from '@/store/wallet-store'
import { readNativeZecIntentsSwapStatus } from './native-zec-intents-swap'

export type ConfidentialBalanceErrorCode =
  | 'authorization_required'
  | 'account_unavailable'
  | 'balance_unavailable'

function classifyBalanceReadError(error: unknown): ConfidentialBalanceErrorCode {
  if (error instanceof ConfidentialFundingApiError && error.status === 401)
    return 'authorization_required'
  if (error instanceof ConfidentialFundingApiError && error.status === 403)
    return 'account_unavailable'
  const message = error instanceof Error ? error.message : ''
  if (
    message === 'Confidential authorization is required' ||
    message === CONFIDENTIAL_SESSION_REQUIRED_ERROR
  )
    return 'authorization_required'
  if (/account|wallet|network changed|locked|unlock|credential/i.test(message))
    return 'account_unavailable'
  return 'balance_unavailable'
}

interface FundingContext {
  readonly coordinator: ConfidentialFundingCoordinator
  readonly accountContextTransition: Pick<AccountContextTransitionCoordinator, 'runActiveOperation'>
}

interface PrepareMessage {
  readonly request: PrepareConfidentialFundingInput
}

interface PlanMessage {
  readonly planId: string
}

interface ExternalDepositMessage {
  readonly depositId: string
  readonly force?: boolean
}

const handlers = {
  PREPARE_NATIVE_ZEC_INTENTS_SWAP: (
    { coordinator }: FundingContext,
    message: Readonly<{ request: PrepareNativeZecIntentsSwapInput }>
  ) => coordinator.prepareNativeZecIntentsSwap(message.request),
  GET_NATIVE_ZEC_INTENTS_SWAP: (
    { coordinator }: FundingContext,
    message: Readonly<{ quoteId: string }>
  ) => coordinator.getNativeZecIntentsSwap(message.quoteId),
  GET_NATIVE_ZEC_INTENTS_SWAP_STATUS: async (
    { coordinator }: FundingContext,
    message: Readonly<{ quoteId: string }>
  ) => {
    const review = await coordinator.getNativeZecIntentsSwap(message.quoteId)
    if (review.quoteBinding.recipientType !== 'CONFIDENTIAL_INTENTS') {
      throw new Error('Native ZEC Confidential status is unavailable')
    }
    return readNativeZecIntentsSwapStatus(review.quoteBinding)
  },
  CANCEL_NATIVE_ZEC_INTENTS_SWAP: (
    { coordinator }: FundingContext,
    message: Readonly<{ quoteId: string }>
  ) => coordinator.cancelNativeZecIntentsSwap(message.quoteId),
  PREPARE_CONFIDENTIAL_FUNDING: ({ coordinator }: FundingContext, message: PrepareMessage) =>
    coordinator.prepare(message.request),
  PREVIEW_CONFIDENTIAL_FUNDING: ({ coordinator }: FundingContext, message: PrepareMessage) =>
    coordinator.preview(message.request),
  CREATE_EXTERNAL_SHIELD_DEPOSIT: (
    { coordinator }: FundingContext,
    message: Readonly<{ request: CreateExternalShieldDepositInput }>
  ) => coordinator.createExternalDeposit(message.request),
  GET_EXTERNAL_SHIELD_DEPOSIT: ({ coordinator }: FundingContext, message: ExternalDepositMessage) =>
    coordinator.getExternalDeposit(message.depositId),
  LIST_EXTERNAL_SHIELD_DEPOSITS: (
    { coordinator }: FundingContext,
    message: Readonly<{ scope: ExternalShieldDepositScope }>
  ) => coordinator.listExternalDeposits(message.scope),
  REFRESH_EXTERNAL_SHIELD_DEPOSIT: (
    { coordinator }: FundingContext,
    message: ExternalDepositMessage
  ) => coordinator.refreshExternalDeposit(message.depositId, message.force !== false),
  CONFIRM_CONFIDENTIAL_FUNDING: (
    { coordinator }: FundingContext,
    message: PlanMessage & Readonly<{ payloadFingerprint: string }>
  ) => coordinator.confirm(message.planId, message.payloadFingerprint),
  GET_CONFIDENTIAL_FUNDING: ({ coordinator }: FundingContext, message: PlanMessage) =>
    coordinator.getPlan(message.planId),
  CHECK_CONFIDENTIAL_FUNDING_SUBMISSION: (
    { coordinator, accountContextTransition }: FundingContext,
    message: PlanMessage
  ) =>
    accountContextTransition.runActiveOperation(() => coordinator.checkSubmission(message.planId)),
  CANCEL_CONFIDENTIAL_FUNDING: async ({ coordinator }: FundingContext, message: PlanMessage) => {
    await coordinator.cancel(message.planId)
    return true
  },
  REFRESH_CONFIDENTIAL_BALANCES: async (
    { coordinator }: FundingContext,
    message: Readonly<{
      scope: ExternalShieldDepositScope
      authorize: boolean
      notifyPortfolio?: boolean
    }>
  ) => {
    try {
      // Authorization acquires the account queue inside the signer. Holding it
      // here would deadlock that signature and block all subsequent mode reads.
      const balances = await coordinator.refreshBalances(message.scope, message.authorize)
      const { currentNetwork, currentWalletId, currentAccountId } = useWalletStore.getState()
      if (
        message.notifyPortfolio !== false &&
        currentNetwork === message.scope.network &&
        currentWalletId === message.scope.keyDomainId &&
        currentAccountId === message.scope.accountId
      ) {
        void chrome.runtime
          .sendMessage({
            type: 'PORTFOLIO_UPDATED',
            walletId: message.scope.keyDomainId,
            accountId: message.scope.accountId
          })
          .catch(() => {})
      }
      return balances
    } catch (error) {
      const cause = error instanceof Error ? error : new Error('Shield balance unavailable')
      Object.assign(cause, { balanceErrorCode: classifyBalanceReadError(error) })
      throw cause
    }
  }
}

export function getConfidentialFundingMessageHandler(type: string) {
  if (!Object.prototype.hasOwnProperty.call(handlers, type)) return null
  return handlers[type as keyof typeof handlers]
}
