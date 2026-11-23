export { assertShieldAmount, shieldAmountToRaw } from './amount'
export { normalizeEvmChainId, normalizeShieldChainId } from './chain-id'
export {
  assertNearConfidentialLayer,
  prepareReceive,
  prepareTransfer
} from './layers/near-confidential'
export {
  SHIELD_CONFIDENTIAL_TRANSFER_NOT_CONFIRMED,
  ShieldProviderError,
  shieldErrorFromProviderFailure,
  shieldErrorToProviderError,
  toShieldProviderErrorShape,
  type ShieldProviderErrorCode
} from './provider-error'
export {
  projectConfidentialPlanStatus,
  projectExternalShieldDepositStatus,
  type ShieldDepositStatusInput,
  type ShieldPlanStatusInput,
  type ShieldProjectedStatus
} from './status-projection'
export { NEAR_CONFIDENTIAL_LAYER, ShieldError, type ShieldPublicStatus } from './types'

/** Methods accepted on the wallet Shield provider channel. */
export const SHIELD_DAPP_RUNTIME_METHODS = Object.freeze([
  'shield_connect',
  'shield_disconnect',
  'shield_receive',
  'shield_transfer',
  'shield_getSupportedChains',
  'shield_getSupportedTokens',
  'shield_getQuote',
  'shield_getTransactionStatus',
  'shield_refreshBalances'
] as const)

export type ShieldDAppRuntimeMethod = (typeof SHIELD_DAPP_RUNTIME_METHODS)[number]
