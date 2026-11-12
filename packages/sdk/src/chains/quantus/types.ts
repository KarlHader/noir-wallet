export interface QuantusRequestArguments {
  readonly method: string
  readonly params?: readonly unknown[]
}

export type QuantusProviderListener = (value: unknown) => void
export type QuantusNetwork = 'mainnet' | 'testnet'
export type QuantusChain = 'QUANTUS_MAINNET' | 'QUANTUS_PLANCK'

export interface QuantusConnectResult {
  readonly address: string
  /** ML-DSA public key without a `0x` prefix. */
  readonly publicKey: string
}

/**
 * Quantus balances are u128 raw units (12 decimals), returned as decimal
 * strings so they survive the wallet messaging boundary losslessly.
 */
export interface QuantusBalance {
  readonly free: string
  readonly reserved: string
  readonly nonce: number
}

export interface QuantusChainInfo {
  readonly enum: QuantusChain
  readonly name: string
  readonly network: QuantusNetwork
}

/**
 * Noir Wallet's Quantus provider. Software accounts can connect, read
 * balances, request a reviewed native QTC/PLK transfer that the wallet signs and
 * submits, request a reviewed native transfer signature the site submits itself,
 * and broadcast an already-signed Substrate extrinsic. Generic call and message
 * signing are not exposed yet.
 */
export interface QuantusProvider {
  request<T = unknown>(args: QuantusRequestArguments): Promise<T>
  connect(): Promise<QuantusConnectResult>
  requestAccounts(): Promise<readonly string[]>
  getAccounts(): Promise<readonly string[]>
  getNetwork(): Promise<QuantusNetwork>
  getChain(): Promise<QuantusChainInfo>
  getPublicKey(): Promise<string>
  getBalance(): Promise<QuantusBalance>
  /**
   * Asks the wallet to review, sign, and submit a native QTC/PLK transfer to
   * `recipient`. `amountRaw` is a canonical positive u128 decimal string in
   * 12-decimal base units; the recipient must be an SS58-189 address. The
   * wallet keeps the current network and account, fixes keep-alive, and uses its
   * own fee ceiling. Resolves with the extrinsic hash once submission is
   * recorded; it is not a finality guarantee.
   */
  sendQuantus(recipient: string, amountRaw: string): Promise<string>
  /**
   * Asks the wallet to review and sign the same native transfer **without
   * submitting it**, and resolves with the `0x`-prefixed signed extrinsic. A
   * signed extrinsic is transferable: the site can submit it later without
   * another wallet approval, and the wallet never broadcasts it or reports it as
   * sent. The approval states this consequence. The site owns submission and
   * chain observation; the wallet only records the signed transfer in Activity.
   */
  signQuantusTransfer(recipient: string, amountRaw: string): Promise<string>
  /** Submits a signed extrinsic hex via `author_submitExtrinsic`; returns the extrinsic hash. */
  broadcastExtrinsic(extrinsicHex: string): Promise<string>
  /** Validates the requested network; global network mode is changed in wallet settings. */
  switchNetwork(network: QuantusNetwork): Promise<null>
  /** Validates the requested chain; global network mode is changed in wallet settings. */
  switchChain(chain: { readonly enum: QuantusChain }): Promise<null>
  on(event: string, handler: QuantusProviderListener): QuantusProvider
  removeListener(event: string, handler: QuantusProviderListener): QuantusProvider
  disconnect(): Promise<void>
}

export interface DetectQuantusProviderOptions {
  /** Maximum detection time. Defaults to 3 seconds. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
