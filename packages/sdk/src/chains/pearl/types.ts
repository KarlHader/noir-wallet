export interface PearlRequestArguments {
  readonly method: string
  readonly params?: readonly unknown[]
}

export type PearlProviderListener = (value: unknown) => void
export type PearlNetwork = 'mainnet' | 'testnet'
export type PearlChain = 'PEARL_MAINNET' | 'PEARL_TESTNET'

export interface PearlConnectResult {
  readonly address: string
  /** Compressed secp256k1 public key without a `0x` prefix. */
  readonly publicKey: string
}

export interface PearlBalance {
  readonly confirmed: number
  readonly unconfirmed: number
  readonly total: number
}

export interface PearlChainInfo {
  readonly enum: PearlChain
  readonly name: string
  readonly network: PearlNetwork
}

export interface PearlSendOptions {
  readonly feeRate?: number
}

export interface PearlSignPsbtOptions {
  readonly autoFinalized?: boolean
}

/**
 * Noir Wallet's Pearl provider. Software accounts can connect, read balances,
 * send native PRL, sign BIP-322 messages, sign PSBTs, and broadcast finalized
 * transactions. Hardware Pearl signing remains unsupported.
 */
export interface PearlProvider {
  request<T = unknown>(args: PearlRequestArguments): Promise<T>
  connect(): Promise<PearlConnectResult>
  requestAccounts(): Promise<readonly string[]>
  getAccounts(): Promise<readonly string[]>
  getNetwork(): Promise<PearlNetwork>
  getChain(): Promise<PearlChainInfo>
  getPublicKey(): Promise<string>
  getBalance(): Promise<PearlBalance>
  sendPearl(recipient: string, satoshis: number, options?: PearlSendOptions): Promise<string>
  /** Returns the BIP-322 simple signature as canonical base64. */
  signMessage(message: string, type?: 'bip322-simple'): Promise<string>
  signPsbt(psbtHex: string, options?: PearlSignPsbtOptions): Promise<string>
  signPsbts(
    psbtHexes: readonly string[],
    options?: readonly (PearlSignPsbtOptions | undefined)[]
  ): Promise<readonly string[]>
  pushPsbt(psbtHex: string): Promise<string>
  pushTx(options: { readonly rawtx: string }): Promise<string>
  /** Validates the requested network; global network mode is changed in wallet settings. */
  switchNetwork(network: PearlNetwork): Promise<null>
  /** Validates the requested chain; global network mode is changed in wallet settings. */
  switchChain(chain: { readonly enum: PearlChain }): Promise<null>
  on(event: string, handler: PearlProviderListener): PearlProvider
  removeListener(event: string, handler: PearlProviderListener): PearlProvider
  disconnect(): Promise<void>
}

export interface DetectPearlProviderOptions {
  /** Maximum detection time. Defaults to 3 seconds. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
