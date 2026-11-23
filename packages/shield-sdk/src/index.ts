export { NoirShieldSDK } from './client'
export { assertShieldAmount, shieldAmountToRaw } from './amount'
export { normalizeEvmChainId, normalizeShieldChainId } from './chain-id'
export { projectShieldStatusReport } from './operation'
export { NEAR_CONFIDENTIAL_LAYER, ShieldError } from './types'
export type {
  ShieldAction,
  ShieldAmount,
  ShieldBalance,
  ShieldChainIdInput,
  ShieldChainInfo,
  ShieldErrorCode,
  ShieldLayer,
  ShieldOperationHandle,
  ShieldOperationParty,
  ShieldOperationReferences,
  ShieldOperationSnapshot,
  ShieldPublicStatus,
  ShieldTransactionStatus,
  ShieldQuote,
  ShieldReceiveParams,
  ShieldTokenInfo,
  ShieldTokenRef,
  ShieldTransferDestination,
  ShieldTransferParams,
  ShieldWaitOptions
} from './types'
