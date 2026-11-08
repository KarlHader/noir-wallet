import type {
  CreateExternalShieldDepositInput,
  ExternalShieldDepositScope
} from '@/core/services/confidential-funding'
import type { AccountContextTransitionCoordinator } from './account-context-transition'
import type {
  ConfidentialFundingCoordinator,
  PrepareConfidentialFundingInput
} from './confidential-funding-coordinator'

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
}

const handlers = {
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
  ) => coordinator.refreshExternalDeposit(message.depositId),
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
  REFRESH_CONFIDENTIAL_BALANCES: (
    { coordinator }: FundingContext,
    message: Readonly<{ scope: ExternalShieldDepositScope; authorize: boolean }>
  ) => coordinator.refreshBalances(message.scope, message.authorize)
}

export function getConfidentialFundingMessageHandler(type: string) {
  if (!Object.prototype.hasOwnProperty.call(handlers, type)) return null
  return handlers[type as keyof typeof handlers]
}
