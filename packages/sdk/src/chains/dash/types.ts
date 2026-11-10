export const DASH_CHAIN_IDS = Object.freeze({
  mainnet: 'bip122:00000ffd590b1485b3caadc19b22e637',
  testnet: 'bip122:00000bafbc94add76cb75e2ec9289483'
} as const)

export type DashChainId = (typeof DASH_CHAIN_IDS)[keyof typeof DASH_CHAIN_IDS]
export type DashNetwork = 'mainnet' | 'testnet'

/**
 * Canonical integer duff text. A decimal point, sign, exponent, or leading zero is not assignable.
 * `parseDashDuffs` also rejects values above max money.
 */
export type DashDuffString = `${bigint}`

/** Keystone `signMessage` rejects with this code. Ledger mainnet returns a base64 signature. */
export const DASH_UNSUPPORTED_SIGN_MESSAGE = 4200 as const

export type DashProviderErrorCode =
  | 4001
  | 4100
  | typeof DASH_UNSUPPORTED_SIGN_MESSAGE
  | 4900
  | 4901
  | -32602
  | -32603

export interface DashProviderError extends Error {
  readonly code: DashProviderErrorCode
}

export interface DashUnsupportedSignMessageError extends DashProviderError {
  readonly code: typeof DASH_UNSUPPORTED_SIGN_MESSAGE
}

export interface DashRequestArguments {
  readonly method: string
  readonly params?: readonly unknown[]
}

export type DashProviderListener = (value: unknown) => void

/** Same events as the Bitcoin provider. */
export type DashProviderEvent = 'accountsChanged' | 'networkChanged'

export interface DashConnectResult {
  readonly address: string
  /** Compressed secp256k1 public key without a `0x` prefix. */
  readonly publicKey: string
}

/** Safe integer duff counts from `getBalance`. */
export interface DashBalance {
  readonly confirmed: number
  readonly unconfirmed: number
  readonly total: number
}

export interface DashChainInfo {
  readonly chainId: DashChainId
  readonly name: string
  readonly network: DashNetwork
}

export interface DashSignPsbtOptions {
  /** Defaults to true, matching the UniSat/OKX provider convention. */
  readonly autoFinalized?: boolean
}

export interface DashSendOptions {
  /** Canonical integer duffs per kilobyte. The wallet estimates the fee when omitted. */
  readonly feeRate?: DashDuffString
}

/** Noir Wallet's Dash provider, shaped like the supported UniSat-style Bitcoin surface. */
export interface DashProvider {
  request<T = unknown>(args: DashRequestArguments): Promise<T>
  connect(): Promise<DashConnectResult>
  requestAccounts(): Promise<readonly string[]>
  getAccounts(): Promise<readonly string[]>
  getNetwork(): Promise<DashNetwork>
  getChain(): Promise<DashChainInfo>
  getPublicKey(): Promise<string>
  getBalance(): Promise<DashBalance>
  sendDash(recipient: string, duffs: DashDuffString, options?: DashSendOptions): Promise<string>
  /**
   * Software accounts and Ledger mainnet accounts resolve a base64 compact signature.
   * Keystone rejects with {@link DashUnsupportedSignMessageError}.
   */
  signMessage(message: string): Promise<string>
  signPsbt(psbtHex: string, options?: DashSignPsbtOptions): Promise<string>
  signPsbts(
    psbtHexes: readonly string[],
    options?: readonly (DashSignPsbtOptions | undefined)[]
  ): Promise<readonly string[]>
  /** Finalizes and broadcasts a complete PSBT, returning its transaction ID. */
  pushPsbt(psbtHex: string): Promise<string>
  /** Broadcasts a complete raw transaction, returning its transaction ID. */
  pushTx(options: { readonly rawtx: string }): Promise<string>
  on(event: DashProviderEvent, handler: DashProviderListener): DashProvider
  removeListener(event: DashProviderEvent, handler: DashProviderListener): DashProvider
  disconnect(): Promise<void>
}

export interface DetectDashProviderOptions {
  /** Maximum detection time. Defaults to 3 seconds. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
