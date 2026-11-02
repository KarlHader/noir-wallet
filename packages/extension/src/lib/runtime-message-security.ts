import { EVM_DAPP_RUNTIME_METHODS, type EvmDAppRuntimeMethod } from '@/core/dapp/eip1193'
import {
  BITCOIN_DAPP_RUNTIME_METHODS,
  type BitcoinDAppRuntimeMethod
} from '@/core/dapp/bitcoin-provider'
import {
  NEAR_DAPP_RUNTIME_METHODS,
  SOLANA_DAPP_RUNTIME_METHODS,
  type NearDAppRuntimeMethod,
  type NativeTransferDAppRuntimeMethod,
  type SolanaDAppRuntimeMethod
} from '@/core/dapp/native-transfer-provider'
import { CAIP25_RUNTIME_METHODS, type Caip25RuntimeMethod } from '@/core/dapp/caip25'
import {
  RHEA_SWAP_CHAIN_CATALOG,
  parseRheaSwapQuoteRequest
} from '@/core/services/rhea-swap/rhea-swap-model'
import { parseRheaSwapTransactionBinding } from '@/core/transactions/domain'
import { isZcashOperationAnalyticsContext } from './analytics/operations'
import { isDiagnosticContextId } from './diagnostic-log'
import type { ZcashTransactionContext } from '@/core/worker/types'

export interface RuntimeMessageSenderLike {
  readonly id?: string
  readonly origin?: string
  readonly url?: string
  readonly documentUrl?: string
  readonly frameId?: number
  readonly tab?: {
    readonly id?: number
    readonly url?: string
    readonly windowId?: number
  }
}

export type OwnExtensionSenderContext = 'service-worker' | 'offscreen-document' | 'extension-page'

export const ZCASH_DAPP_RUNTIME_METHODS = Object.freeze([
  'zcash_getAccounts',
  'zcash_requestAccounts',
  'zcash_getBalance',
  'zcash_getMaxTransfer',
  'zcash_getPublicKey',
  'zcash_getAddresses',
  'zcash_sendTransaction',
  'zcash_signMessage',
  'zcash_shieldFunds',
  'zcash_getTransactionHistory',
  'zcash_switchNetwork',
  'zcash_checkLendingMcaAccount',
  'zcash_disconnect'
] as const)

export const DAPP_RUNTIME_METHODS = Object.freeze([
  ...ZCASH_DAPP_RUNTIME_METHODS,
  ...EVM_DAPP_RUNTIME_METHODS,
  ...BITCOIN_DAPP_RUNTIME_METHODS,
  ...SOLANA_DAPP_RUNTIME_METHODS,
  ...NEAR_DAPP_RUNTIME_METHODS,
  ...CAIP25_RUNTIME_METHODS
] as const)

export type ZcashDAppRuntimeMethod = (typeof ZCASH_DAPP_RUNTIME_METHODS)[number]
export type DAppRuntimeMethod =
  | ZcashDAppRuntimeMethod
  | EvmDAppRuntimeMethod
  | BitcoinDAppRuntimeMethod
  | NativeTransferDAppRuntimeMethod
  | SolanaDAppRuntimeMethod
  | NearDAppRuntimeMethod
  | Caip25RuntimeMethod

export interface DAppRuntimeRequestMessage {
  readonly type: 'DAPP_REQUEST'
  readonly requestId: string
  readonly chainId: 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near' | 'multichain'
  readonly siteMetadata?: {
    readonly faviconUrl: string
  }
  readonly request: {
    readonly method: DAppRuntimeMethod
    readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
  }
}

export interface WorkerRpcRuntimeMessage {
  readonly type: 'WORKER_RPC'
  readonly method: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface KeyringWorkerRpcRuntimeMessage {
  readonly type: 'KEYRING_WORKER_RPC'
  readonly method: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly transactionContext?: ZcashTransactionContext
}

export interface NoirRuntimeEventMessage {
  readonly type: 'NOIR_EVENT'
  readonly chainId: 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near' | 'multichain'
  readonly eventName:
    | 'accountsChanged'
    | 'accountCapabilitiesChanged'
    | 'chainChanged'
    | 'networkChanged'
    | 'connect'
    | 'disconnect'
    | 'wallet_sessionChanged'
  readonly data: unknown
}

export interface DAppApprovalResultMessage {
  readonly type: 'DAPP_APPROVAL_RESULT'
  readonly requestId: string
  readonly success: boolean
  readonly marginalFeeZats?: number
  readonly feeZats?: number
  readonly selectedIds?: readonly string[]
  readonly selectedScopes?: Readonly<Record<string, readonly string[]>>
}

export type HardwareSignResultMessage =
  | {
      readonly type: 'HW_SIGN_RESULT'
      readonly requestId: string
      readonly success: true
      readonly txHash: string
    }
  | {
      readonly type: 'HW_SIGN_RESULT'
      readonly requestId: string
      readonly success: false
      readonly error?: string
    }

type CopyLimits = {
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxStringBytes: number
}

type CopyState = {
  nodes: number
  stringBytes: number
}

type RuntimeFieldValidator = (value: unknown) => boolean

type RuntimeMessageSchema = {
  readonly required?: Readonly<Record<string, RuntimeFieldValidator>>
  readonly optional?: Readonly<Record<string, RuntimeFieldValidator>>
}

const DAPP_LIMITS: CopyLimits = {
  maxDepth: 16,
  maxNodes: 4_096,
  maxStringBytes: 256 * 1024
}

const WORKER_LIMITS: CopyLimits = {
  maxDepth: 32,
  maxNodes: 100_000,
  maxStringBytes: 8 * 1024 * 1024
}

const isBoolean: RuntimeFieldValidator = value => typeof value === 'boolean'
const isFiniteNumber: RuntimeFieldValidator = value =>
  typeof value === 'number' && Number.isFinite(value)
const isNullableNumber: RuntimeFieldValidator = value => value === null || isFiniteNumber(value)
const isShortString: RuntimeFieldValidator = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 4_096
const isWalletBackupVerification: RuntimeFieldValidator = value => {
  if (!isRuntimeRecord(value) || !hasExactRuntimeKeys(value, ['wordIndices', 'words'])) return false
  const { wordIndices, words } = value
  return (
    Array.isArray(wordIndices) &&
    wordIndices.length === 2 &&
    wordIndices.every(index => Number.isInteger(index) && index >= 0 && index < 24) &&
    wordIndices[0] !== wordIndices[1] &&
    Array.isArray(words) &&
    words.length === 2 &&
    words.every(word => typeof word === 'string' && word.length > 0 && word.length <= 64)
  )
}
const isEvmAddress: RuntimeFieldValidator = value =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
const isBoundedString: RuntimeFieldValidator = value =>
  typeof value === 'string' && value.length <= 4_096
const isLegacyPasswordString: RuntimeFieldValidator = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  new TextEncoder().encode(value).byteLength <= 1024 * 1024
const isNullableShortString: RuntimeFieldValidator = value => value === null || isShortString(value)
const isRecord: RuntimeFieldValidator = value => isRuntimeRecord(value)
const isArray: RuntimeFieldValidator = value => Array.isArray(value)
const isChainIdArray: RuntimeFieldValidator = value =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 64 &&
  value.every(
    chainId => typeof chainId === 'string' && /^[a-z0-9-]{3,16}:[A-Za-z0-9._-]{1,64}$/.test(chainId)
  ) &&
  new Set(value).size === value.length
const isPortfolioAction: RuntimeFieldValidator = value => value === 'read' || value === 'refresh'
const rheaSwapTokenListChainIds = new Set(
  RHEA_SWAP_CHAIN_CATALOG.map(chain => chain.tokenListChainId)
)
const isRheaSwapDirection: RuntimeFieldValidator = value =>
  value === 'from' || value === 'cross-chain-to'
const isRheaSwapTokenListChainIdArray: RuntimeFieldValidator = value =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= RHEA_SWAP_CHAIN_CATALOG.length &&
  value.every(
    chainId => Number.isSafeInteger(chainId) && rheaSwapTokenListChainIds.has(chainId as number)
  ) &&
  new Set(value).size === value.length
const isRheaSwapQuoteRequest: RuntimeFieldValidator = value => {
  try {
    parseRheaSwapQuoteRequest(value)
    return true
  } catch {
    return false
  }
}
const isRheaSwapQuoteHandle: RuntimeFieldValidator = value =>
  typeof value === 'string' && /^rhea-quote:[0-9A-Za-z:_-]{1,128}$/.test(value)
const isRheaSwapSourceHash: RuntimeFieldValidator = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(value)
const isRheaSwapBinding: RuntimeFieldValidator = value => {
  try {
    parseRheaSwapTransactionBinding(value)
    return true
  } catch {
    return false
  }
}
const isNetworkFeeTier: RuntimeFieldValidator = value =>
  value === 'low' || value === 'standard' || value === 'fast'
const isEvmFeeSelection: RuntimeFieldValidator = value => {
  if (!isRuntimeRecord(value)) return false
  if (
    value.kind === 'tier' &&
    Object.keys(value).length === 2 &&
    Object.prototype.hasOwnProperty.call(value, 'tier')
  ) {
    return isNetworkFeeTier(value.tier)
  }
  if (
    value.kind === 'custom' &&
    Object.keys(value).length === 2 &&
    Object.prototype.hasOwnProperty.call(value, 'maxPriorityFeePerGasWei') &&
    typeof value.maxPriorityFeePerGasWei === 'string' &&
    /^(?:0|[1-9][0-9]*)$/.test(value.maxPriorityFeePerGasWei)
  ) {
    const priorityFee = BigInt(value.maxPriorityFeePerGasWei)
    return priorityFee > 0n && priorityFee <= 10_000_000_000_000n
  }
  return false
}
const isAssetMarketHistoryRange: RuntimeFieldValidator = value =>
  value === '1d' ||
  value === '1w' ||
  value === '1m' ||
  value === '3m' ||
  value === '1y' ||
  value === 'all'
const isNetworkMode: RuntimeFieldValidator = value => value === 'mainnet' || value === 'testnet'
const isDAppExecutionMode: RuntimeFieldValidator = value => value === 'main' || value === 'private'
const isZcashLendingSigningMode: RuntimeFieldValidator = value =>
  value === 'derived' || value === 'legacy' || value === 'legacy_index0'
const isEvmPayloadFingerprint: RuntimeFieldValidator = value =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isCanonicalBitcoinPsbtBase64: RuntimeFieldValidator = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 2 * 1024 * 1024 &&
  value.length % 4 === 0 &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
const isCanonicalKeystoneEvmSignatureBase64: RuntimeFieldValidator = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 * 1024 &&
  value.length % 4 === 0 &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
const isCanonicalHardwarePcztBase64: RuntimeFieldValidator = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 3 * 1024 * 1024 &&
  value.length % 4 === 0 &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
const isMnemonicWordCount: RuntimeFieldValidator = value => value === 12 || value === 24
const isSoftwareWalletProvisioningMode: RuntimeFieldValidator = value =>
  value === 'create' || value === 'import'
const isMnemonicPhrase: RuntimeFieldValidator = value =>
  typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).byteLength <= 512
const isPrivateKey: RuntimeFieldValidator = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 512
const isPrivateKeyChainFamily: RuntimeFieldValidator = value =>
  value === 'eip155' || value === 'bip122' || value === 'solana' || value === 'near'
const isBitcoinAddressType: RuntimeFieldValidator = value =>
  value === 'p2pkh' || value === 'p2sh-p2wpkh' || value === 'p2wpkh' || value === 'p2tr'
const isBirthdayHeight: RuntimeFieldValidator = value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isPositiveBirthdayHeight: RuntimeFieldValidator = value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isFundingSource: RuntimeFieldValidator = value =>
  value === 'shielded' || value === 'transparent'
const isPositiveSafeInteger: RuntimeFieldValidator = value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isAccountReadyTimeout: RuntimeFieldValidator = value =>
  isPositiveSafeInteger(value) && (value as number) <= 60_000
const isLogLevel: RuntimeFieldValidator = value =>
  value === 'log' || value === 'info' || value === 'warn' || value === 'error'
const isForwardWalletLogPayload: RuntimeFieldValidator = value =>
  isRuntimeRecord(value) &&
  hasExactRuntimeKeys(value, ['level', 'walletId', 'message']) &&
  isLogLevel(value.level) &&
  isShortString(value.walletId) &&
  isShortString(value.message)
const isDiagnosticLogDraft: RuntimeFieldValidator = value =>
  isRuntimeRecord(value) &&
  hasExactRuntimeKeys(value, [
    'source',
    'level',
    'message',
    'timestamp',
    'sequence',
    ...(Object.prototype.hasOwnProperty.call(value, 'contextId') ? ['contextId'] : [])
  ]) &&
  (value.contextId === undefined || isDiagnosticContextId(value.contextId)) &&
  (value.source === 'background' ||
    value.source === 'popup' ||
    value.source === 'offscreen' ||
    value.source === 'worker') &&
  (value.level === 'debug' ||
    value.level === 'info' ||
    value.level === 'warn' ||
    value.level === 'error') &&
  isShortString(value.message) &&
  isFiniteNumber(value.timestamp) &&
  Number.isSafeInteger(value.sequence) &&
  (value.sequence as number) >= 0

const TRUSTED_RUNTIME_SCHEMAS: Readonly<Record<string, RuntimeMessageSchema>> = Object.freeze({
  PORTFOLIO_UPDATED: { required: { walletId: isShortString, accountId: isShortString } },
  SYNC_PROGRESS: {
    optional: {
      walletId: isShortString,
      accountId: isShortString,
      isSyncing: isBoolean,
      syncProgress: isFiniteNumber,
      currentHeight: isFiniteNumber,
      latestHeight: isFiniteNumber,
      balance: isRecord,
      etaMs: isNullableNumber,
      syncReason: isNullableShortString
    }
  },
  WORKER_LOG: {
    required: { level: isLogLevel, message: isShortString },
    optional: { walletId: isShortString }
  },
  FORWARD_WALLET_LOG: { required: { payload: isForwardWalletLogPayload } },
  APPEND_DIAGNOSTIC_LOG: { required: { entry: isDiagnosticLogDraft } },
  EXPORT_DIAGNOSTIC_LOGS: {},
  ANALYTICS_EVENT: {
    required: { name: isShortString },
    optional: {
      options: isRecord,
      timestamp: isFiniteNumber,
      engagementTimeMsec: value =>
        isFiniteNumber(value) && Number(value) >= 0 && Number(value) <= 3_600_000
    }
  },
  ANALYTICS_PAGE_VIEW: {
    required: { page: isShortString },
    optional: {
      timestamp: isFiniteNumber,
      engagementTimeMsec: value =>
        isFiniteNumber(value) && Number(value) >= 0 && Number(value) <= 3_600_000
    }
  },
  WALLET_UNLOCK: { required: { password: isLegacyPasswordString } },
  GET_BETA_INVITE_ACTIVATION: {},
  CHECK_BETA_INVITE_CODE: { required: { inviteCode: isShortString } },
  BIND_BETA_INVITE_WALLET: {},
  CHANGE_WALLET_PASSWORD: {
    required: { currentPassword: isLegacyPasswordString, newPassword: isShortString }
  },
  GET_CONNECTED_DAPPS: {},
  GET_CURRENT_TAB_DAPP: {},
  GET_DAPP_EXECUTION_MODE: {},
  SET_DAPP_EXECUTION_MODE: {
    required: { mode: isDAppExecutionMode },
    optional: { confirmPrivateSetup: isBoolean, confirmAffectedOperations: isBoolean }
  },
  CONNECT_CURRENT_ACCOUNT_TO_DAPP: { required: { origin: isShortString } },
  DISCONNECT_DAPP: { required: { origin: isShortString } },
  WALLET_CREATED: { required: { password: isLegacyPasswordString } },
  GENERATE_PRIMARY_WALLET_MNEMONIC: {
    required: { wordCount: isMnemonicWordCount, password: isLegacyPasswordString }
  },
  PROVISION_PRIMARY_SOFTWARE_WALLET: {
    required: {
      mnemonic: isMnemonicPhrase,
      password: isLegacyPasswordString,
      accountName: isShortString
    },
    optional: { birthdayHeight: isBirthdayHeight }
  },
  GENERATE_ADD_WALLET_MNEMONIC: { required: { wordCount: isMnemonicWordCount } },
  ADD_SOFTWARE_WALLET: {
    required: {
      mode: isSoftwareWalletProvisioningMode,
      mnemonic: isMnemonicPhrase,
      accountName: isShortString
    },
    optional: { birthdayHeight: isBirthdayHeight }
  },
  PREVIEW_PRIVATE_KEY_WALLET: {
    required: {
      privateKey: isPrivateKey,
      chainFamily: isPrivateKeyChainFamily
    }
  },
  IMPORT_PRIVATE_KEY_WALLET: {
    required: {
      privateKey: isPrivateKey,
      chainFamily: isPrivateKeyChainFamily,
      displayName: isShortString
    }
  },
  EXPORT_PRIVATE_KEY: {
    required: {
      walletId: isShortString,
      accountId: isShortString,
      chainId: isShortString,
      password: isLegacyPasswordString
    },
    optional: { bitcoinAddressType: isBitcoinAddressType }
  },
  RESYNC_ZCASH_WALLET: {
    required: {
      walletId: isShortString,
      accountId: isShortString,
      birthdayHeight: isPositiveBirthdayHeight
    }
  },
  GET_ZCASH_SEED_PHRASE: {
    required: { password: isLegacyPasswordString },
    optional: { walletId: isShortString }
  },
  GET_ZCASH_BLOCK_BY_TIME: { required: { timestamp: isFiniteNumber } },
  GET_ZCASH_BLOCK_TIME: { required: { height: isBirthdayHeight } },
  RESOLVE_ZCASH_BIRTHDAY_HEIGHT: {
    required: { walletId: isShortString, accountId: isShortString }
  },
  ESTIMATE_ZCASH_TRANSFER_FEE: {
    required: {
      to: isShortString,
      amount: isShortString,
      marginalFeeZats: isPositiveSafeInteger,
      fundingSource: isFundingSource
    },
    optional: { memo: isBoundedString, debugRequestId: isShortString }
  },
  ESTIMATE_ZCASH_MAX_TRANSFER: {
    required: {
      to: isShortString,
      marginalFeeZats: isPositiveSafeInteger,
      fundingSource: isFundingSource
    },
    optional: { memo: isBoundedString, debugRequestId: isShortString }
  },
  ESTIMATE_ZCASH_SHIELD_FEE: { required: { marginalFeeZats: isPositiveSafeInteger } },
  WAIT_FOR_ZCASH_ACCOUNT_READY: { required: { timeoutMs: isAccountReadyTimeout } },
  ROTATE_ZCASH_SHIELDED_ADDRESS: {
    required: { walletId: isShortString, accountId: isShortString }
  },
  SET_ZCASH_SHIELDED_ADDRESS: {
    required: { walletId: isShortString, accountId: isShortString, shielded: isShortString }
  },
  PROVISION_KEYSTONE_HARDWARE: {
    required: { credential: isRecord, displayName: isShortString },
    optional: { password: isLegacyPasswordString, birthdayHeight: isBirthdayHeight }
  },
  PROVISION_LEDGER_HARDWARE: {
    required: { credential: isRecord, displayName: isShortString },
    optional: {
      password: isLegacyPasswordString,
      birthdayHeight: isBirthdayHeight,
      existingKeyDomainId: isShortString,
      anchorProof: isRecord
    }
  },
  GET_LEDGER_PROVISIONING_CREDENTIAL: { required: { walletId: isShortString } },
  GET_LEDGER_SIGNING_REQUEST: { required: { requestId: isShortString } },
  SUBMIT_LEDGER_SIGNING_RESPONSE: { required: { requestId: isShortString, response: isRecord } },
  CANCEL_LEDGER_SIGNING_REQUEST: { required: { requestId: isShortString } },
  GET_HARDWARE_TRANSFER_VENDOR: {
    required: {
      transactionId: isShortString,
      family: value => value === 'evm' || value === 'bitcoin'
    }
  },
  GET_WALLET_SESSION_STATE: {},
  GET_BACKGROUND_INITIALIZATION_STATE: {},
  GET_NETWORK_MODE: {},
  GET_ZERO_INDEXER_OPTIONS: { required: { network: isNetworkMode } },
  GET_ZERO_INDEXER_ENABLED: {},
  SET_ZERO_INDEXER_ENABLED: { required: { enabled: isBoolean } },
  GET_ZERO_INDEXER_NODE_STATUS: { optional: { refresh: isBoolean } },
  SELECT_ZERO_INDEXER_NODE: { required: { endpointId: isNullableShortString } },
  ADD_CUSTOM_ZERO_INDEXER_NODE: {
    required: { label: isBoundedString, url: isShortString }
  },
  REMOVE_CUSTOM_ZERO_INDEXER_NODE: { required: { endpointId: isShortString } },
  GET_EXTENSION_DISPLAY_MODE: {},
  SET_EXTENSION_DISPLAY_MODE: { required: { sidePanelMode: isBoolean } },
  SWITCH_NETWORK_MODE: { required: { networkMode: isNetworkMode } },
  GET_ACTIVITY: {
    optional: {
      action: isPortfolioAction,
      executionMode: value => value === 'all' || isDAppExecutionMode(value),
      chainIds: isChainIdArray,
      historyPageCount: value =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10
    }
  },
  GET_BITCOIN_ACTIVITY: { optional: { action: isPortfolioAction } },
  GET_BITCOIN_WALLET_IDENTITY: {},
  GET_ZCASH_LENDING_PUBLIC_KEY: {
    required: {
      walletId: isShortString,
      accountId: isShortString,
      signingMode: isZcashLendingSigningMode
    }
  },
  GET_ASSET_PRICES: {
    required: { action: isPortfolioAction },
    optional: { assetId: isShortString }
  },
  GET_RHEA_SWAP_TOKENS: {
    required: {
      direction: isRheaSwapDirection,
      tokenListChainIds: isRheaSwapTokenListChainIdArray
    }
  },
  QUOTE_RHEA_SWAP: { required: { request: isRheaSwapQuoteRequest } },
  PREPARE_RHEA_SWAP: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  GET_RHEA_SWAP_EVM_PLAN: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  GET_RHEA_SWAP_EVM_SIGNATURE_PLAN: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  PREPARE_RHEA_SWAP_EVM_SIGNATURE: {
    required: { quoteHandle: isRheaSwapQuoteHandle, binding: isRheaSwapBinding },
    optional: { executionMode: value => value === 'main' || value === 'private' }
  },
  CONFIRM_RHEA_SWAP_EVM_SIGNATURE: {
    required: { quoteHandle: isRheaSwapQuoteHandle, payloadFingerprint: isEvmPayloadFingerprint }
  },
  CANCEL_RHEA_SWAP_EVM_SIGNATURE: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  PREPARE_RHEA_SWAP_SOLANA: {
    required: { quoteHandle: isRheaSwapQuoteHandle, binding: isRheaSwapBinding }
  },
  CONFIRM_RHEA_SWAP_SOLANA: {
    required: { quoteHandle: isRheaSwapQuoteHandle, payloadFingerprint: isEvmPayloadFingerprint }
  },
  CANCEL_RHEA_SWAP_SOLANA: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  PREPARE_RHEA_SWAP_NEAR: {
    required: { quoteHandle: isRheaSwapQuoteHandle, binding: isRheaSwapBinding }
  },
  CONFIRM_RHEA_SWAP_NEAR: {
    required: { quoteHandle: isRheaSwapQuoteHandle, payloadFingerprint: isEvmPayloadFingerprint }
  },
  CANCEL_RHEA_SWAP_NEAR: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  RECORD_RHEA_SWAP_SUBMISSION: {
    required: { quoteHandle: isRheaSwapQuoteHandle, sourceHash: isRheaSwapSourceHash }
  },
  REPORT_RHEA_SWAP_SUBMISSION: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  GET_RHEA_SWAP_ORDER_STATUS: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  START_RHEA_SWAP_MONITOR: { required: { transaction: isRecord } },
  DISCARD_RHEA_SWAP: { required: { quoteHandle: isRheaSwapQuoteHandle } },
  PREPARE_CONFIDENTIAL_FUNDING: { required: { request: isRecord } },
  CONFIRM_CONFIDENTIAL_FUNDING: {
    required: { planId: isShortString, payloadFingerprint: isEvmPayloadFingerprint }
  },
  GET_CONFIDENTIAL_FUNDING: { required: { planId: isShortString } },
  CANCEL_CONFIDENTIAL_FUNDING: { required: { planId: isShortString } },
  GET_ASSET_MARKET_HISTORY: {
    required: {
      assetId: isShortString,
      range: isAssetMarketHistoryRange,
      action: isPortfolioAction
    }
  },
  GET_ADDITIONAL_RECEIVE_TARGETS: {
    required: { walletId: isShortString, accountId: isShortString }
  },
  GET_ACCOUNT_NETWORKS: {},
  GET_BITCOIN_ADDRESS_BALANCES: {},
  SET_ACTIVE_BITCOIN_ADDRESS_TYPE: {
    required: {
      walletId: isShortString,
      accountId: isShortString,
      addressType: isBitcoinAddressType
    }
  },
  GET_CHAIN_ENDPOINT_SETTINGS: {},
  APPLY_CHAIN_ENDPOINT_SETTINGS: {
    required: { settings: isRecord },
    optional: { expectedSettings: isRecord }
  },
  SAVE_CUSTOM_EVM_NETWORK: {
    required: { network: isRecord },
    optional: { expectedNetwork: isRecord }
  },
  REMOVE_CUSTOM_EVM_NETWORK: { required: { network: isRecord } },
  SELECT_ACTIVE_EVM_CHAIN: { required: { chainId: isShortString } },
  GET_USER_EVM_ASSETS: {},
  GET_MANAGED_TOKEN_ASSETS: {},
  INSPECT_USER_EVM_ASSET: {
    required: { chainId: isShortString, contractAddress: isShortString }
  },
  ADD_USER_EVM_ASSET: { required: { candidate: isRecord } },
  ENABLE_INTENTS_EVM_ASSETS: {
    required: { assets: isArray, show: isBoolean }
  },
  REMOVE_USER_EVM_ASSET: { required: { assetId: isShortString } },
  SET_TOKEN_HIDDEN: { required: { assetId: isShortString, hidden: isBoolean } },
  REFRESH_INTENTS_PROTOCOL_ASSETS: { optional: { force: isBoolean } },
  GET_PORTFOLIO: {
    required: { action: isPortfolioAction },
    optional: { forceDiscovery: isBoolean, chainIds: isChainIdArray }
  },
  GET_EVM_PORTFOLIO: { required: { action: isPortfolioAction } },
  GET_EVM_TOKEN_ALLOWANCE: {
    required: {
      chainId: isShortString,
      token: isEvmAddress,
      spender: isEvmAddress,
      expectedOwner: isEvmAddress
    },
    optional: { executionMode: value => value === 'main' || value === 'private' }
  },
  PREPARE_EVM_TRANSFER: {
    required: { intent: isRecord },
    optional: {
      nearIntentsBinding: isRecord,
      rheaSwapBinding: isRecord,
      feeTier: isNetworkFeeTier,
      feeSelection: isEvmFeeSelection,
      executionMode: value => value === 'main' || value === 'private',
      debugRequestId: isShortString
    }
  },
  PREPARE_EVM_CONTRACT_CALL: {
    required: { intent: isRecord },
    optional: {
      rheaSwapBinding: isRecord,
      feeTier: isNetworkFeeTier,
      feeSelection: isEvmFeeSelection,
      executionMode: value => value === 'main' || value === 'private',
      debugRequestId: isShortString
    }
  },
  PREPARE_EVM_CANCEL: {
    required: { chainId: isShortString, originalTransactionId: isShortString },
    optional: { executionMode: value => value === 'main' || value === 'private' }
  },
  GET_EVM_NONCE_RECOVERY: {
    required: { chainId: isShortString },
    optional: { executionMode: value => value === 'main' || value === 'private' }
  },
  PREPARE_EVM_NONCE_RECOVERY: {
    required: { chainId: isShortString },
    optional: {
      executionMode: value => value === 'main' || value === 'private',
      feeSelection: isEvmFeeSelection
    }
  },
  GET_PENDING_EVM_TRANSFER: { required: { transactionId: isShortString } },
  APPROVE_EVM_TRANSFER: {
    required: { transactionId: isShortString, payloadFingerprint: isEvmPayloadFingerprint }
  },
  GET_KEYSTONE_EVM_SIGNING_REQUEST: { required: { transactionId: isShortString } },
  SUBMIT_KEYSTONE_EVM_SIGNATURE: {
    required: {
      transactionId: isShortString,
      payloadFingerprint: isEvmPayloadFingerprint,
      signatureCborBase64: value =>
        isCanonicalKeystoneEvmSignatureBase64(value) ||
        (typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value))
    }
  },
  REJECT_EVM_TRANSFER: { required: { transactionId: isShortString } },
  RESUME_EVM_TRANSFER: { required: { transactionId: isShortString } },
  PREPARE_SOLANA_TRANSFER: {
    required: { intent: isRecord },
    optional: { nearIntentsBinding: isRecord }
  },
  GET_PENDING_SOLANA_TRANSFER: { required: { transactionId: isShortString } },
  APPROVE_SOLANA_TRANSFER: {
    required: { transactionId: isShortString, payloadFingerprint: isEvmPayloadFingerprint }
  },
  REJECT_SOLANA_TRANSFER: { required: { transactionId: isShortString } },
  RESUME_SOLANA_TRANSFER: { required: { transactionId: isShortString } },
  PREPARE_NEAR_TRANSFER: {
    required: { intent: isRecord },
    optional: { nearIntentsBinding: isRecord }
  },
  GET_PENDING_NEAR_TRANSFER: { required: { transactionId: isShortString } },
  APPROVE_NEAR_TRANSFER: {
    required: { transactionId: isShortString, payloadFingerprint: isEvmPayloadFingerprint }
  },
  REJECT_NEAR_TRANSFER: { required: { transactionId: isShortString } },
  RESUME_NEAR_TRANSFER: { required: { transactionId: isShortString } },
  PREPARE_BITCOIN_TRANSFER: {
    required: { intent: isRecord },
    optional: {
      nearIntentsBinding: isRecord,
      rheaSwapBinding: isRecord,
      feeTier: isNetworkFeeTier,
      bitcoinAddressType: isBitcoinAddressType
    }
  },
  GET_PENDING_BITCOIN_TRANSFER: { required: { transactionId: isShortString } },
  APPROVE_BITCOIN_TRANSFER: {
    required: { transactionId: isShortString, payloadFingerprint: isEvmPayloadFingerprint }
  },
  GET_KEYSTONE_BITCOIN_SIGNING_REQUEST: { required: { transactionId: isShortString } },
  SUBMIT_KEYSTONE_BITCOIN_SIGNATURE: {
    required: {
      transactionId: isShortString,
      payloadFingerprint: isEvmPayloadFingerprint,
      signedPsbtBase64: isCanonicalBitcoinPsbtBase64
    }
  },
  REJECT_BITCOIN_TRANSFER: { required: { transactionId: isShortString } },
  RESUME_BITCOIN_TRANSFER: { required: { transactionId: isShortString } },
  INSPECT_NEXT_ZCASH_ACCOUNT_HISTORY: {
    required: { walletId: isShortString }
  },
  ADD_ACCOUNT: {
    required: { walletId: isShortString },
    optional: {
      accountName: isShortString,
      birthdayHeight: isPositiveBirthdayHeight,
      expectedDerivationIndex: isBirthdayHeight
    }
  },
  SWITCH_ACCOUNT: {
    required: { walletId: isShortString, accountId: isShortString }
  },
  REMOVE_ACCOUNT: {
    required: { walletId: isShortString, accountId: isShortString },
    optional: { verification: isWalletBackupVerification }
  },
  GET_WALLET_BACKUP_WORD_INDICES: {
    required: { walletId: isShortString }
  },
  CONFIRM_WALLET_BACKUP: {
    required: { walletId: isShortString, verification: isWalletBackupVerification }
  },
  RENAME_ACCOUNT: {
    required: { walletId: isShortString, accountId: isShortString, displayName: isShortString }
  },
  SET_ACCOUNT_PINNED: {
    required: { walletId: isShortString, accountId: isShortString, pinned: isBoolean }
  },
  SET_ACCOUNT_HIDDEN: {
    required: { walletId: isShortString, accountId: isShortString, hidden: isBoolean }
  },
  RENAME_WALLET: {
    required: { walletId: isShortString, displayName: isShortString }
  },
  REMOVE_WALLET: {
    required: { walletId: isShortString },
    optional: { verification: isWalletBackupVerification }
  },
  RESET_WALLET_DATA: {},
  WALLET_LOCKED: {},
  ACCOUNT_SWITCHED: {
    optional: { walletId: isShortString, accountId: isShortString }
  },
  RPC_ENDPOINT_CHANGED: { required: { preferences: isRecord } },
  GET_PENDING_REQUEST: { required: { requestId: isShortString } },
  ESTIMATE_APPROVAL_FEE: { required: { requestId: isShortString } },
  GET_SYNC_STATE: {
    optional: { walletId: isShortString, accountId: isShortString }
  },
  ABORT_SYNC: { optional: { walletId: isShortString } },
  BACKGROUND_SYNC: {},
  BACKGROUND_ZCASH_TX: {
    required: {
      action: isShortString,
      walletId: isShortString,
      accountId: isShortString,
      accountKey: isShortString,
      transactionId: isShortString
    },
    optional: {
      txType: isShortString,
      sendParams: isRecord,
      marginalFeeZats: isFiniteNumber,
      monitorParams: isRecord,
      analytics: isZcashOperationAnalyticsContext
    }
  },
  HW_PCZT_BUILD: {
    required: {
      requestId: isShortString,
      walletId: isShortString,
      accountId: isShortString,
      kind: isShortString
    },
    optional: {
      to: isShortString,
      amount: isShortString,
      memo: value => typeof value === 'string' && value.length <= 4_096,
      fundingSource: isFundingSource,
      maxTransfer: value => typeof value === 'boolean',
      marginalFeeZats: isFiniteNumber
    }
  },
  SUBMIT_HARDWARE_PCZT: {
    required: {
      requestId: isShortString,
      signedPcztBase64: isCanonicalHardwarePcztBase64
    }
  },
  SUBMIT_LEDGER_SIGNATURES: {
    required: { requestId: isShortString, signatures: isRecord }
  },
  START_TRANSACTION_MONITOR: { required: { swap: isRecord } },
  STOP_TRANSACTION_MONITOR: { required: { depositAddress: isShortString } },
  START_ZCASH_TX_MONITOR: { required: { tx: isRecord } },
  RECHECK_PENDING_TRANSACTIONS: { optional: { accountKey: isShortString } },
  RECHECK_FAST_PENDING_TRANSACTIONS: {
    optional: { family: value => value === 'evm' }
  },
  GET_TRANSACTION_HISTORY: {
    required: { walletId: isShortString, accountId: isShortString }
  },
  ADD_TRANSACTION: {
    required: { accountKey: isShortString, transaction: isRecord }
  },
  UPDATE_TRANSACTION: {
    required: {
      accountKey: isShortString,
      transactionId: isShortString,
      updates: isRecord
    }
  }
})

const TRUSTED_RUNTIME_CONTEXTS: Readonly<Record<string, readonly OwnExtensionSenderContext[]>> =
  Object.freeze({
    PORTFOLIO_UPDATED: ['service-worker'],
    SYNC_PROGRESS: ['extension-page'],
    WORKER_LOG: ['offscreen-document'],
    FORWARD_WALLET_LOG: ['offscreen-document'],
    APPEND_DIAGNOSTIC_LOG: ['extension-page', 'offscreen-document'],
    EXPORT_DIAGNOSTIC_LOGS: ['extension-page'],
    ANALYTICS_EVENT: ['extension-page'],
    ANALYTICS_PAGE_VIEW: ['extension-page'],
    WALLET_UNLOCK: ['extension-page'],
    GET_BETA_INVITE_ACTIVATION: ['extension-page'],
    CHECK_BETA_INVITE_CODE: ['extension-page'],
    BIND_BETA_INVITE_WALLET: ['extension-page'],
    CHANGE_WALLET_PASSWORD: ['extension-page'],
    GET_CONNECTED_DAPPS: ['extension-page'],
    GET_CURRENT_TAB_DAPP: ['extension-page'],
    CONNECT_CURRENT_ACCOUNT_TO_DAPP: ['extension-page'],
    DISCONNECT_DAPP: ['extension-page'],
    WALLET_CREATED: ['extension-page'],
    GENERATE_PRIMARY_WALLET_MNEMONIC: ['extension-page'],
    PROVISION_PRIMARY_SOFTWARE_WALLET: ['extension-page'],
    GENERATE_ADD_WALLET_MNEMONIC: ['extension-page'],
    ADD_SOFTWARE_WALLET: ['extension-page'],
    PREVIEW_PRIVATE_KEY_WALLET: ['extension-page'],
    IMPORT_PRIVATE_KEY_WALLET: ['extension-page'],
    EXPORT_PRIVATE_KEY: ['extension-page'],
    RESYNC_ZCASH_WALLET: ['extension-page'],
    GET_ZCASH_SEED_PHRASE: ['extension-page'],
    GET_ZCASH_BLOCK_BY_TIME: ['extension-page'],
    GET_ZCASH_BLOCK_TIME: ['extension-page'],
    RESOLVE_ZCASH_BIRTHDAY_HEIGHT: ['extension-page'],
    ESTIMATE_ZCASH_TRANSFER_FEE: ['extension-page'],
    ESTIMATE_ZCASH_MAX_TRANSFER: ['extension-page'],
    ESTIMATE_ZCASH_SHIELD_FEE: ['extension-page'],
    WAIT_FOR_ZCASH_ACCOUNT_READY: ['extension-page'],
    ROTATE_ZCASH_SHIELDED_ADDRESS: ['extension-page'],
    SET_ZCASH_SHIELDED_ADDRESS: ['extension-page'],
    PROVISION_KEYSTONE_HARDWARE: ['extension-page'],
    PROVISION_LEDGER_HARDWARE: ['extension-page'],
    GET_LEDGER_PROVISIONING_CREDENTIAL: ['extension-page'],
    GET_LEDGER_SIGNING_REQUEST: ['extension-page'],
    SUBMIT_LEDGER_SIGNING_RESPONSE: ['extension-page'],
    CANCEL_LEDGER_SIGNING_REQUEST: ['extension-page'],
    GET_HARDWARE_TRANSFER_VENDOR: ['extension-page'],
    GET_WALLET_SESSION_STATE: ['extension-page'],
    GET_BACKGROUND_INITIALIZATION_STATE: ['extension-page'],
    GET_NETWORK_MODE: ['extension-page'],
    GET_ZERO_INDEXER_OPTIONS: ['offscreen-document'],
    GET_ZERO_INDEXER_ENABLED: ['extension-page'],
    SET_ZERO_INDEXER_ENABLED: ['extension-page'],
    GET_ZERO_INDEXER_NODE_STATUS: ['extension-page'],
    SELECT_ZERO_INDEXER_NODE: ['extension-page'],
    ADD_CUSTOM_ZERO_INDEXER_NODE: ['extension-page'],
    REMOVE_CUSTOM_ZERO_INDEXER_NODE: ['extension-page'],
    GET_EXTENSION_DISPLAY_MODE: ['extension-page'],
    SET_EXTENSION_DISPLAY_MODE: ['extension-page'],
    GET_DAPP_EXECUTION_MODE: ['extension-page'],
    SET_DAPP_EXECUTION_MODE: ['extension-page'],
    SWITCH_NETWORK_MODE: ['extension-page'],
    GET_ACTIVITY: ['extension-page'],
    GET_BITCOIN_ACTIVITY: ['extension-page'],
    GET_BITCOIN_WALLET_IDENTITY: ['extension-page'],
    GET_ZCASH_LENDING_PUBLIC_KEY: ['extension-page'],
    GET_ASSET_PRICES: ['extension-page'],
    GET_RHEA_SWAP_TOKENS: ['extension-page'],
    QUOTE_RHEA_SWAP: ['extension-page'],
    PREPARE_RHEA_SWAP: ['extension-page'],
    GET_RHEA_SWAP_EVM_PLAN: ['extension-page'],
    GET_RHEA_SWAP_EVM_SIGNATURE_PLAN: ['extension-page'],
    PREPARE_RHEA_SWAP_EVM_SIGNATURE: ['extension-page'],
    CONFIRM_RHEA_SWAP_EVM_SIGNATURE: ['extension-page'],
    CANCEL_RHEA_SWAP_EVM_SIGNATURE: ['extension-page'],
    PREPARE_RHEA_SWAP_SOLANA: ['extension-page'],
    CONFIRM_RHEA_SWAP_SOLANA: ['extension-page'],
    CANCEL_RHEA_SWAP_SOLANA: ['extension-page'],
    PREPARE_RHEA_SWAP_NEAR: ['extension-page'],
    CONFIRM_RHEA_SWAP_NEAR: ['extension-page'],
    CANCEL_RHEA_SWAP_NEAR: ['extension-page'],
    RECORD_RHEA_SWAP_SUBMISSION: ['extension-page'],
    REPORT_RHEA_SWAP_SUBMISSION: ['extension-page'],
    GET_RHEA_SWAP_ORDER_STATUS: ['extension-page'],
    START_RHEA_SWAP_MONITOR: ['extension-page'],
    DISCARD_RHEA_SWAP: ['extension-page'],
    PREPARE_CONFIDENTIAL_FUNDING: ['extension-page'],
    CONFIRM_CONFIDENTIAL_FUNDING: ['extension-page'],
    GET_CONFIDENTIAL_FUNDING: ['extension-page'],
    CANCEL_CONFIDENTIAL_FUNDING: ['extension-page'],
    GET_ASSET_MARKET_HISTORY: ['extension-page'],
    GET_ADDITIONAL_RECEIVE_TARGETS: ['extension-page'],
    GET_ACCOUNT_NETWORKS: ['extension-page'],
    GET_BITCOIN_ADDRESS_BALANCES: ['extension-page'],
    SET_ACTIVE_BITCOIN_ADDRESS_TYPE: ['extension-page'],
    GET_CHAIN_ENDPOINT_SETTINGS: ['extension-page'],
    APPLY_CHAIN_ENDPOINT_SETTINGS: ['extension-page'],
    SAVE_CUSTOM_EVM_NETWORK: ['extension-page'],
    REMOVE_CUSTOM_EVM_NETWORK: ['extension-page'],
    SELECT_ACTIVE_EVM_CHAIN: ['extension-page'],
    GET_USER_EVM_ASSETS: ['extension-page'],
    GET_MANAGED_TOKEN_ASSETS: ['extension-page'],
    INSPECT_USER_EVM_ASSET: ['extension-page'],
    ADD_USER_EVM_ASSET: ['extension-page'],
    ENABLE_INTENTS_EVM_ASSETS: ['extension-page'],
    REMOVE_USER_EVM_ASSET: ['extension-page'],
    SET_TOKEN_HIDDEN: ['extension-page'],
    REFRESH_INTENTS_PROTOCOL_ASSETS: ['extension-page'],
    GET_PORTFOLIO: ['extension-page'],
    GET_EVM_PORTFOLIO: ['extension-page'],
    GET_EVM_TOKEN_ALLOWANCE: ['extension-page'],
    PREPARE_EVM_TRANSFER: ['extension-page'],
    PREPARE_EVM_CONTRACT_CALL: ['extension-page'],
    PREPARE_EVM_CANCEL: ['extension-page'],
    GET_EVM_NONCE_RECOVERY: ['extension-page'],
    PREPARE_EVM_NONCE_RECOVERY: ['extension-page'],
    GET_PENDING_EVM_TRANSFER: ['extension-page'],
    APPROVE_EVM_TRANSFER: ['extension-page'],
    GET_KEYSTONE_EVM_SIGNING_REQUEST: ['extension-page'],
    SUBMIT_KEYSTONE_EVM_SIGNATURE: ['extension-page'],
    REJECT_EVM_TRANSFER: ['extension-page'],
    RESUME_EVM_TRANSFER: ['extension-page'],
    PREPARE_SOLANA_TRANSFER: ['extension-page'],
    GET_PENDING_SOLANA_TRANSFER: ['extension-page'],
    APPROVE_SOLANA_TRANSFER: ['extension-page'],
    REJECT_SOLANA_TRANSFER: ['extension-page'],
    RESUME_SOLANA_TRANSFER: ['extension-page'],
    PREPARE_NEAR_TRANSFER: ['extension-page'],
    GET_PENDING_NEAR_TRANSFER: ['extension-page'],
    APPROVE_NEAR_TRANSFER: ['extension-page'],
    REJECT_NEAR_TRANSFER: ['extension-page'],
    RESUME_NEAR_TRANSFER: ['extension-page'],
    PREPARE_BITCOIN_TRANSFER: ['extension-page'],
    GET_PENDING_BITCOIN_TRANSFER: ['extension-page'],
    APPROVE_BITCOIN_TRANSFER: ['extension-page'],
    GET_KEYSTONE_BITCOIN_SIGNING_REQUEST: ['extension-page'],
    SUBMIT_KEYSTONE_BITCOIN_SIGNATURE: ['extension-page'],
    REJECT_BITCOIN_TRANSFER: ['extension-page'],
    RESUME_BITCOIN_TRANSFER: ['extension-page'],
    INSPECT_NEXT_ZCASH_ACCOUNT_HISTORY: ['extension-page'],
    ADD_ACCOUNT: ['extension-page'],
    SWITCH_ACCOUNT: ['extension-page'],
    REMOVE_ACCOUNT: ['extension-page'],
    GET_WALLET_BACKUP_WORD_INDICES: ['extension-page'],
    CONFIRM_WALLET_BACKUP: ['extension-page'],
    RENAME_ACCOUNT: ['extension-page'],
    SET_ACCOUNT_PINNED: ['extension-page'],
    SET_ACCOUNT_HIDDEN: ['extension-page'],
    RENAME_WALLET: ['extension-page'],
    REMOVE_WALLET: ['extension-page'],
    RESET_WALLET_DATA: ['extension-page'],
    WALLET_LOCKED: ['extension-page'],
    ACCOUNT_SWITCHED: ['extension-page'],
    RPC_ENDPOINT_CHANGED: ['extension-page'],
    GET_PENDING_REQUEST: ['extension-page'],
    ESTIMATE_APPROVAL_FEE: ['extension-page'],
    GET_SYNC_STATE: ['extension-page'],
    ABORT_SYNC: ['extension-page'],
    BACKGROUND_SYNC: ['extension-page'],
    BACKGROUND_ZCASH_TX: ['extension-page'],
    HW_PCZT_BUILD: ['extension-page'],
    SUBMIT_HARDWARE_PCZT: ['extension-page'],
    SUBMIT_LEDGER_SIGNATURES: ['extension-page'],
    START_TRANSACTION_MONITOR: ['extension-page'],
    STOP_TRANSACTION_MONITOR: ['extension-page'],
    START_ZCASH_TX_MONITOR: ['extension-page'],
    RECHECK_PENDING_TRANSACTIONS: ['extension-page'],
    RECHECK_FAST_PENDING_TRANSACTIONS: ['extension-page'],
    GET_TRANSACTION_HISTORY: ['extension-page'],
    ADD_TRANSACTION: ['extension-page'],
    UPDATE_TRANSACTION: ['extension-page']
  })

const trustedRuntimeSchemaTypes = Object.keys(TRUSTED_RUNTIME_SCHEMAS).sort()
const trustedRuntimeContextTypes = Object.keys(TRUSTED_RUNTIME_CONTEXTS).sort()
if (
  trustedRuntimeSchemaTypes.length !== trustedRuntimeContextTypes.length ||
  trustedRuntimeSchemaTypes.some((type, index) => type !== trustedRuntimeContextTypes[index])
) {
  throw new Error('Trusted runtime message schemas and sender contexts are inconsistent')
}

const textEncoder = new TextEncoder()
const dappMethodSet = new Set<string>(DAPP_RUNTIME_METHODS)
const zcashDappMethodSet = new Set<string>(ZCASH_DAPP_RUNTIME_METHODS)
const evmDappMethodSet = new Set<string>(EVM_DAPP_RUNTIME_METHODS)
const bitcoinDappMethodSet = new Set<string>(BITCOIN_DAPP_RUNTIME_METHODS)
const solanaDappMethodSet = new Set<string>(SOLANA_DAPP_RUNTIME_METHODS)
const nearDappMethodSet = new Set<string>(NEAR_DAPP_RUNTIME_METHODS)
const caip25DappMethodSet = new Set<string>(CAIP25_RUNTIME_METHODS)
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactRuntimeKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function copyBoundedRuntimeValue(
  value: unknown,
  limits: CopyLimits,
  state: CopyState,
  depth: number
): unknown {
  state.nodes += 1
  if (state.nodes > limits.maxNodes || depth > limits.maxDepth) {
    throw new Error('Runtime message exceeds structural limits')
  }

  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Runtime message contains a non-finite number')
    }
    return value
  }
  if (typeof value === 'string') {
    state.stringBytes += textEncoder.encode(value).byteLength
    if (state.stringBytes > limits.maxStringBytes) {
      throw new Error('Runtime message exceeds string limits')
    }
    return value
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > limits.maxStringBytes) {
      throw new Error('Runtime message binary payload is too large')
    }
    return new Uint8Array(value)
  }
  if (Array.isArray(value)) {
    return value.map(item => copyBoundedRuntimeValue(item, limits, state, depth + 1))
  }
  if (!isRuntimeRecord(value)) {
    throw new Error('Runtime message contains an unsupported value')
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new Error('Runtime message contains a forbidden key')
      }
      return [key, copyBoundedRuntimeValue(item, limits, state, depth + 1)]
    })
  )
}

function copyRuntimeRecord(
  value: Record<string, unknown>,
  limits: CopyLimits
): Record<string, unknown> {
  const copied = copyBoundedRuntimeValue(value, limits, { nodes: 0, stringBytes: 0 }, 0)
  if (!isRuntimeRecord(copied)) {
    throw new Error('Runtime message payload must be an object')
  }
  return copied
}

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isOwnExtensionUrl(url: URL | null, extensionId: string): url is URL {
  return url?.protocol === 'chrome-extension:' && url.hostname === extensionId
}

export function getOwnExtensionSenderUrl(
  sender: RuntimeMessageSenderLike,
  extensionId: string
): URL | null {
  if (sender.id !== extensionId) return null

  const explicitUrls = [sender.url, sender.documentUrl, sender.tab?.url].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  if (explicitUrls.length > 0) {
    const parsed = explicitUrls.map(parseUrl)
    if (parsed.some(url => !isOwnExtensionUrl(url, extensionId))) {
      return null
    }
    return parsed[0]
  }

  const originUrl = parseUrl(sender.origin)
  return isOwnExtensionUrl(originUrl, extensionId) ? originUrl : null
}

export function isTrustedExtensionSender(
  sender: RuntimeMessageSenderLike,
  extensionId: string
): boolean {
  return getOwnExtensionSenderUrl(sender, extensionId) !== null
}

export function getOwnExtensionSenderContext(
  sender: RuntimeMessageSenderLike,
  extensionId: string
): OwnExtensionSenderContext | null {
  const url = getOwnExtensionSenderUrl(sender, extensionId)
  if (!url) return null
  if (sender.tab === undefined && url.pathname === '/service-worker-loader.js') {
    return 'service-worker'
  }
  if (sender.tab === undefined && url.pathname === '/src/offscreen/index.html') {
    return 'offscreen-document'
  }
  if (url.pathname === '/index.html') {
    return 'extension-page'
  }
  return null
}

export function isTrustedRuntimeMessageSender(
  messageType: string,
  sender: RuntimeMessageSenderLike,
  extensionId: string
): boolean {
  const context = getOwnExtensionSenderContext(sender, extensionId)
  return context !== null && (TRUSTED_RUNTIME_CONTEXTS[messageType]?.includes(context) ?? false)
}

export function getContentScriptSenderOrigin(
  sender: RuntimeMessageSenderLike,
  extensionId: string
): string | null {
  if (
    sender.id !== extensionId ||
    !Number.isInteger(sender.tab?.id) ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  ) {
    return null
  }

  const candidates = [sender.url, sender.documentUrl, sender.tab?.url, sender.origin].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  if (candidates.length === 0) return null

  const origins = candidates.map(value => {
    const url = parseUrl(value)
    return url && (url.protocol === 'https:' || url.protocol === 'http:') ? url.origin : null
  })
  if (origins.some(origin => origin === null)) return null

  const origin = origins[0]
  return origin && origins.every(candidate => candidate === origin) ? origin : null
}

export function isOwnExtensionRouteSender(
  sender: RuntimeMessageSenderLike,
  extensionId: string,
  route: string,
  expected?: { readonly tabId?: number; readonly windowId?: number }
): boolean {
  const url = getOwnExtensionSenderUrl(sender, extensionId)
  if (!url || url.pathname !== '/index.html') return false

  const hashRoute = url.hash.slice(1).split('?')[0]
  const normalizedRoute = hashRoute.startsWith('/') ? hashRoute : `/${hashRoute}`
  if (normalizedRoute !== route) return false
  if (expected?.tabId !== undefined && sender.tab?.id !== expected.tabId) return false
  if (expected?.windowId !== undefined && sender.tab?.windowId !== expected.windowId) return false
  return true
}

export function isOwnExtensionServiceWorkerSender(
  sender: RuntimeMessageSenderLike,
  extensionId: string,
  serviceWorkerPath: string | undefined
): boolean {
  if (!serviceWorkerPath || sender.tab !== undefined) return false
  const url = getOwnExtensionSenderUrl(sender, extensionId)
  if (!url) return false

  const normalizedPath = serviceWorkerPath.startsWith('/')
    ? serviceWorkerPath
    : `/${serviceWorkerPath}`
  return url.pathname === normalizedPath
}

export function parseDAppRuntimeRequestMessage(value: unknown): DAppRuntimeRequestMessage {
  const messageKeys =
    isRuntimeRecord(value) && Object.prototype.hasOwnProperty.call(value, 'siteMetadata')
      ? ['type', 'requestId', 'chainId', 'request', 'siteMetadata']
      : ['type', 'requestId', 'chainId', 'request']
  if (
    !isRuntimeRecord(value) ||
    !hasExactRuntimeKeys(value, messageKeys) ||
    value.type !== 'DAPP_REQUEST' ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.length > 128 ||
    typeof value.chainId !== 'string' ||
    value.chainId.length === 0 ||
    value.chainId.length > 128 ||
    !isRuntimeRecord(value.request)
  ) {
    throw new Error('Invalid dApp runtime request')
  }

  let siteMetadata: DAppRuntimeRequestMessage['siteMetadata']
  if (value.siteMetadata !== undefined) {
    if (
      !isRuntimeRecord(value.siteMetadata) ||
      !hasExactRuntimeKeys(value.siteMetadata, ['faviconUrl']) ||
      typeof value.siteMetadata.faviconUrl !== 'string' ||
      value.siteMetadata.faviconUrl.length === 0 ||
      value.siteMetadata.faviconUrl.length > 128 * 1024
    ) {
      throw new Error('Invalid dApp site metadata')
    }
    const faviconUrl = value.siteMetadata.faviconUrl
    if (!faviconUrl.startsWith('data:image/')) {
      if (faviconUrl.length > 4_096) {
        throw new Error('Invalid dApp favicon URL')
      }
      let parsed: URL
      try {
        parsed = new URL(faviconUrl)
      } catch {
        throw new Error('Invalid dApp favicon URL')
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Invalid dApp favicon URL')
      }
    }
    siteMetadata = Object.freeze({ faviconUrl })
  }

  const requestKeys = Object.prototype.hasOwnProperty.call(value.request, 'params')
    ? ['method', 'params']
    : ['method']
  if (
    !hasExactRuntimeKeys(value.request, requestKeys) ||
    typeof value.request.method !== 'string' ||
    !dappMethodSet.has(value.request.method)
  ) {
    throw new Error('Invalid dApp runtime method')
  }
  if (
    (value.chainId === 'zcash' && !zcashDappMethodSet.has(value.request.method)) ||
    (value.chainId === 'evm' && !evmDappMethodSet.has(value.request.method)) ||
    (value.chainId === 'bitcoin' && !bitcoinDappMethodSet.has(value.request.method)) ||
    (value.chainId === 'solana' && !solanaDappMethodSet.has(value.request.method)) ||
    (value.chainId === 'near' && !nearDappMethodSet.has(value.request.method)) ||
    (value.chainId === 'multichain' && !caip25DappMethodSet.has(value.request.method)) ||
    (value.chainId !== 'zcash' &&
      value.chainId !== 'evm' &&
      value.chainId !== 'bitcoin' &&
      value.chainId !== 'solana' &&
      value.chainId !== 'near' &&
      value.chainId !== 'multichain')
  ) {
    throw new Error('dApp runtime method does not match its provider')
  }
  const paramsAreArray = Array.isArray(value.request.params)
  const paramsAreEvmRecord = value.chainId === 'evm' && isRuntimeRecord(value.request.params)
  const paramsAreMultichainRecord =
    value.chainId === 'multichain' && isRuntimeRecord(value.request.params)
  if (
    value.request.params !== undefined &&
    ((!paramsAreArray && !paramsAreEvmRecord && !paramsAreMultichainRecord) ||
      (paramsAreArray && (value.request.params as unknown[]).length > 16))
  ) {
    throw new Error('Invalid dApp runtime params')
  }

  const params =
    value.request.params === undefined
      ? undefined
      : (copyBoundedRuntimeValue(
          value.request.params,
          DAPP_LIMITS,
          { nodes: 0, stringBytes: 0 },
          0
        ) as readonly unknown[] | Readonly<Record<string, unknown>>)
  return {
    type: 'DAPP_REQUEST',
    requestId: value.requestId,
    chainId: value.chainId,
    ...(siteMetadata === undefined ? {} : { siteMetadata }),
    request: {
      method: value.request.method as DAppRuntimeMethod,
      ...(params === undefined ? {} : { params })
    }
  }
}

export function parseWorkerRpcRuntimeMessage(value: unknown): WorkerRpcRuntimeMessage {
  const parsed = parseWorkerRpcMessage(value, 'WORKER_RPC')
  return { ...parsed, type: 'WORKER_RPC' }
}

export function parseKeyringWorkerRpcRuntimeMessage(
  value: unknown
): KeyringWorkerRpcRuntimeMessage {
  const parsed = parseWorkerRpcMessage(value, 'KEYRING_WORKER_RPC')
  return { ...parsed, type: 'KEYRING_WORKER_RPC' }
}

export function parseNoirRuntimeEventMessage(value: unknown): NoirRuntimeEventMessage {
  if (
    !isRuntimeRecord(value) ||
    !hasExactRuntimeKeys(value, ['type', 'chainId', 'eventName', 'data']) ||
    value.type !== 'NOIR_EVENT' ||
    (value.chainId !== 'zcash' &&
      value.chainId !== 'evm' &&
      value.chainId !== 'bitcoin' &&
      value.chainId !== 'solana' &&
      value.chainId !== 'near' &&
      value.chainId !== 'multichain') ||
    (value.eventName !== 'accountsChanged' &&
      value.eventName !== 'accountCapabilitiesChanged' &&
      value.eventName !== 'chainChanged' &&
      value.eventName !== 'networkChanged' &&
      value.eventName !== 'connect' &&
      value.eventName !== 'disconnect' &&
      value.eventName !== 'wallet_sessionChanged')
  ) {
    throw new Error('Invalid Noir runtime event')
  }
  if (value.eventName === 'accountCapabilitiesChanged' && value.chainId !== 'solana')
    throw new Error('Invalid account capability event chain')

  return {
    type: 'NOIR_EVENT',
    chainId: value.chainId,
    eventName: value.eventName,
    data: copyBoundedRuntimeValue(value.data, DAPP_LIMITS, { nodes: 0, stringBytes: 0 }, 0)
  }
}

export function parseTrustedExtensionRuntimeMessage(
  value: unknown
): Readonly<Record<string, unknown>> {
  if (!isRuntimeRecord(value) || typeof value.type !== 'string') {
    throw new Error('Invalid trusted runtime message')
  }
  const schema = TRUSTED_RUNTIME_SCHEMAS[value.type]
  if (!schema) {
    throw new Error('Unsupported trusted runtime message')
  }

  const required = schema.required ?? {}
  const optional = schema.optional ?? {}
  const allowedKeys = new Set(['type', ...Object.keys(required), ...Object.keys(optional)])
  if (
    Object.keys(value).some(key => !allowedKeys.has(key)) ||
    Object.entries(required).some(
      ([key, validator]) =>
        !Object.prototype.hasOwnProperty.call(value, key) || !validator(value[key])
    ) ||
    Object.entries(optional).some(
      ([key, validator]) =>
        Object.prototype.hasOwnProperty.call(value, key) && !validator(value[key])
    )
  ) {
    throw new Error('Invalid trusted runtime message schema')
  }

  return copyRuntimeRecord(value, WORKER_LIMITS)
}

function parseWorkerRpcMessage(
  value: unknown,
  expectedType: WorkerRpcRuntimeMessage['type'] | KeyringWorkerRpcRuntimeMessage['type']
): Omit<KeyringWorkerRpcRuntimeMessage, 'type'> {
  const hasTransactionContext =
    isRuntimeRecord(value) && Object.prototype.hasOwnProperty.call(value, 'transactionContext')
  if (
    !isRuntimeRecord(value) ||
    !hasExactRuntimeKeys(
      value,
      hasTransactionContext
        ? ['type', 'method', 'payload', 'transactionContext']
        : ['type', 'method', 'payload']
    ) ||
    value.type !== expectedType ||
    typeof value.method !== 'string' ||
    value.method.length === 0 ||
    value.method.length > 128 ||
    value.method.trim() !== value.method ||
    !isRuntimeRecord(value.payload)
  ) {
    throw new Error('Invalid Worker RPC message')
  }

  let transactionContext: ZcashTransactionContext | undefined
  if (hasTransactionContext) {
    const context = value.transactionContext
    if (
      expectedType !== 'KEYRING_WORKER_RPC' ||
      (value.method !== 'transaction.send' && value.method !== 'transaction.oneclick_shield') ||
      !isRuntimeRecord(context) ||
      !hasExactRuntimeKeys(context, ['accountKey', 'transactionId']) ||
      typeof context.accountKey !== 'string' ||
      context.accountKey.length === 0 ||
      context.accountKey.length > 256 ||
      typeof context.transactionId !== 'string' ||
      context.transactionId.length === 0 ||
      context.transactionId.length > 256
    ) {
      throw new Error('Invalid Worker RPC transaction context')
    }
    transactionContext = {
      accountKey: context.accountKey,
      transactionId: context.transactionId
    }
  }

  return {
    method: value.method,
    payload: copyRuntimeRecord(value.payload, WORKER_LIMITS),
    ...(transactionContext ? { transactionContext } : {})
  }
}

export function parseDAppApprovalResultMessage(
  value: unknown,
  expectedRequestId: string
): DAppApprovalResultMessage {
  if (!isRuntimeRecord(value)) throw new Error('Invalid approval result')

  const allowedKeys = new Set([
    'type',
    'requestId',
    'success',
    'marginalFeeZats',
    'feeZats',
    'selectedIds',
    'selectedScopes'
  ])
  if (
    Object.keys(value).some(key => !allowedKeys.has(key)) ||
    value.type !== 'DAPP_APPROVAL_RESULT' ||
    value.requestId !== expectedRequestId ||
    typeof value.success !== 'boolean'
  ) {
    throw new Error('Invalid approval result')
  }
  if (
    value.marginalFeeZats !== undefined &&
    (!Number.isSafeInteger(value.marginalFeeZats) || (value.marginalFeeZats as number) < 0)
  ) {
    throw new Error('Invalid approval fee')
  }
  if (
    value.feeZats !== undefined &&
    (!Number.isSafeInteger(value.feeZats) || (value.feeZats as number) <= 0)
  ) {
    throw new Error('Invalid approval fee')
  }
  if (
    value.selectedIds !== undefined &&
    (!Array.isArray(value.selectedIds) ||
      value.selectedIds.length > 100 ||
      value.selectedIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 256))
  ) {
    throw new Error('Invalid approval account selection')
  }
  let selectedScopes: Readonly<Record<string, readonly string[]>> | undefined
  if (value.selectedScopes !== undefined) {
    if (!isRuntimeRecord(value.selectedScopes) || Object.keys(value.selectedScopes).length > 16) {
      throw new Error('Invalid approval scope selection')
    }
    const parsed: Record<string, readonly string[]> = Object.create(null)
    for (const [scope, ids] of Object.entries(value.selectedScopes)) {
      if (
        FORBIDDEN_OBJECT_KEYS.has(scope) ||
        scope.length === 0 ||
        scope.length > 128 ||
        !Array.isArray(ids) ||
        ids.length > 100 ||
        ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 256) ||
        new Set(ids).size !== ids.length
      ) {
        throw new Error('Invalid approval scope selection')
      }
      parsed[scope] = Object.freeze([...(ids as string[])])
    }
    selectedScopes = Object.freeze(parsed)
  }
  if (
    value.success === false &&
    (value.marginalFeeZats !== undefined ||
      value.feeZats !== undefined ||
      value.selectedIds !== undefined ||
      value.selectedScopes !== undefined)
  ) {
    throw new Error('Rejected approval cannot include approval data')
  }

  return {
    type: 'DAPP_APPROVAL_RESULT',
    requestId: expectedRequestId,
    success: value.success,
    ...(value.marginalFeeZats === undefined
      ? {}
      : { marginalFeeZats: value.marginalFeeZats as number }),
    ...(value.feeZats === undefined ? {} : { feeZats: value.feeZats as number }),
    ...(value.selectedIds === undefined
      ? {}
      : { selectedIds: Object.freeze([...(value.selectedIds as string[])]) }),
    ...(selectedScopes === undefined ? {} : { selectedScopes })
  }
}

export function parseHardwareSignResultMessage(
  value: unknown,
  expectedRequestId: string
): HardwareSignResultMessage {
  if (!isRuntimeRecord(value)) throw new Error('Invalid hardware sign result')

  const allowedKeys = new Set(['type', 'requestId', 'success', 'txHash', 'error'])
  if (
    Object.keys(value).some(key => !allowedKeys.has(key)) ||
    value.type !== 'HW_SIGN_RESULT' ||
    value.requestId !== expectedRequestId ||
    typeof value.success !== 'boolean'
  ) {
    throw new Error('Invalid hardware sign result')
  }
  if (value.success) {
    if (
      typeof value.txHash !== 'string' ||
      value.txHash.length === 0 ||
      value.txHash.length > 256 ||
      value.error !== undefined
    ) {
      throw new Error('Invalid successful hardware sign result')
    }
    return {
      type: 'HW_SIGN_RESULT',
      requestId: expectedRequestId,
      success: true,
      txHash: value.txHash
    }
  }
  if (
    value.txHash !== undefined ||
    (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 1_024))
  ) {
    throw new Error('Invalid failed hardware sign result')
  }
  return {
    type: 'HW_SIGN_RESULT',
    requestId: expectedRequestId,
    success: false,
    ...(value.error === undefined ? {} : { error: value.error as string })
  }
}
