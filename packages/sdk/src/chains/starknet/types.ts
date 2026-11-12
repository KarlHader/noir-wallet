/**
 * Phase 1 Starknet request and response types.
 * Not exported from the package root. Wallet API 0.10.4 subset.
 * STRK20 methods are intentionally absent.
 */

/** Internal ids. Mainnet Mode and Testnet Mode, one at a time. */
export const STARKNET_CHAIN_IDS = Object.freeze({
  mainnet: 'starknet:SN_MAIN',
  sepolia: 'starknet:SN_SEPOLIA'
} as const)

/** Felt chain ids returned by wallet_requestChainId. */
export const STARKNET_FELT_CHAIN_IDS = Object.freeze({
  mainnet: '0x534e5f4d41494e',
  sepolia: '0x534e5f5345504f4c4941'
} as const)

/** Starknet Wallet Standard chain ids. */
export const STARKNET_WALLET_STANDARD_CHAIN_IDS = Object.freeze({
  mainnet: 'starknet:0x534e5f4d41494e',
  sepolia: 'starknet:0x534e5f5345504f4c4941'
} as const)

export type StarknetChainId = (typeof STARKNET_CHAIN_IDS)[keyof typeof STARKNET_CHAIN_IDS]
export type StarknetFeltChainId =
  (typeof STARKNET_FELT_CHAIN_IDS)[keyof typeof STARKNET_FELT_CHAIN_IDS]
export type StarknetWalletStandardChainId =
  (typeof STARKNET_WALLET_STANDARD_CHAIN_IDS)[keyof typeof STARKNET_WALLET_STANDARD_CHAIN_IDS]

export const STARKNET_WALLET_API_VERSION = '0.10.4' as const

export const STARKNET_WALLET_METHODS = Object.freeze({
  supportedWalletApi: 'wallet_supportedWalletApi',
  supportedSpecs: 'wallet_supportedSpecs',
  getPermissions: 'wallet_getPermissions',
  requestAccounts: 'wallet_requestAccounts',
  requestChainId: 'wallet_requestChainId',
  deploymentData: 'wallet_deploymentData',
  switchStarknetChain: 'wallet_switchStarknetChain',
  watchAsset: 'wallet_watchAsset',
  addInvokeTransaction: 'wallet_addInvokeTransaction',
  signTypedData: 'wallet_signTypedData'
} as const)

export type StarknetWalletMethod =
  (typeof STARKNET_WALLET_METHODS)[keyof typeof STARKNET_WALLET_METHODS]

export type StarknetFelt = `0x${string}`

export type StarknetWalletPermission = 'accounts'

export interface StarknetRequestAccountsParams {
  readonly silent_mode?: boolean
  readonly api_version?: typeof STARKNET_WALLET_API_VERSION
}

export interface StarknetSwitchChainParams {
  readonly chainId: StarknetFeltChainId
  readonly silent_mode?: boolean
  readonly api_version?: typeof STARKNET_WALLET_API_VERSION
}

export interface StarknetWatchAssetParams {
  readonly type: 'ERC20'
  readonly options: {
    readonly address: StarknetFelt
    readonly symbol?: string
    readonly decimals?: number
    readonly image?: string
    readonly name?: string
  }
}

/** One call inside wallet_addInvokeTransaction. The entry point is a selector name. */
export interface StarknetInvokeCall {
  readonly contract_address: StarknetFelt
  readonly entry_point: string
  readonly calldata?: readonly StarknetFelt[]
}

export interface StarknetAddInvokeTransactionParams {
  readonly invoke_transaction: readonly StarknetInvokeCall[]
  readonly api_version?: typeof STARKNET_WALLET_API_VERSION
}

export interface StarknetInvokeTransactionResult {
  readonly transaction_hash: StarknetFelt
}

/**
 * Account deployment data. `version` is the Cairo version (0 or 1), not the Argent release.
 * Phase 1 presets are Cairo 1. `sigdata` is omitted for those presets.
 */
export interface StarknetAccountDeploymentData {
  readonly address: StarknetFelt
  readonly class_hash: StarknetFelt
  readonly salt: StarknetFelt
  readonly calldata: readonly StarknetFelt[]
  readonly version: 0 | 1
  readonly sigdata?: readonly StarknetFelt[]
}

export interface StarknetTypeField {
  readonly name: string
  readonly type: string
}

export interface StarknetDomain {
  readonly name?: string
  readonly version?: string
  readonly chainId?: string | number
  readonly revision?: '2' | 0 | 1
}

/** SNIP-12 typed data accepted by wallet_signTypedData. */
export interface StarknetTypedData {
  readonly types: Readonly<Record<string, readonly StarknetTypeField[]>>
  readonly primaryType: string
  readonly domain: StarknetDomain
  readonly message: Readonly<Record<string, unknown>>
}

export interface StarknetWindowObjectInfo {
  readonly id: 'noirwallet'
  readonly name: string
  readonly version: string
  readonly icon: string
}

export type StarknetProviderEvent = 'accountsChanged' | 'networkChanged'

export type StarknetProviderListener = (data: unknown) => void

export interface StarknetProviderRequest {
  readonly type: string
  readonly params?: Readonly<Record<string, unknown>>
}

export interface StarknetProvider extends StarknetWindowObjectInfo {
  request<T = unknown>(args: StarknetProviderRequest): Promise<T>
  on(event: StarknetProviderEvent, handler: StarknetProviderListener): void
  off(event: StarknetProviderEvent, handler: StarknetProviderListener): void
}

export interface DetectStarknetProviderOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
