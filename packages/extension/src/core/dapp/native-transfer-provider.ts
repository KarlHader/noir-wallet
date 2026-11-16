export const NATIVE_TRANSFER_DAPP_RUNTIME_METHODS = Object.freeze([
  'connect',
  'requestAccounts',
  'getAccounts',
  'disconnect'
] as const)

export const SOLANA_DAPP_RUNTIME_METHODS = Object.freeze([
  ...NATIVE_TRANSFER_DAPP_RUNTIME_METHODS,
  'signTransaction',
  'signAllTransactions',
  'signAndSendTransaction',
  'signMessage'
] as const)
export const NEAR_DAPP_RUNTIME_METHODS = Object.freeze([
  ...NATIVE_TRANSFER_DAPP_RUNTIME_METHODS,
  'signTransaction',
  'requestSignTransactions',
  'signAndSendTransaction',
  'signAndSendTransactions',
  'signMessage'
] as const)

export type NativeTransferDAppRuntimeMethod = (typeof NATIVE_TRANSFER_DAPP_RUNTIME_METHODS)[number]
export type SolanaDAppRuntimeMethod = (typeof SOLANA_DAPP_RUNTIME_METHODS)[number]
export type NearDAppRuntimeMethod = (typeof NEAR_DAPP_RUNTIME_METHODS)[number]

export type NativeTransferProviderErrorCode = 4001 | 4100 | 4200 | 4900 | 4901 | -32602 | -32603

export interface NativeTransferProviderErrorShape {
  readonly code: NativeTransferProviderErrorCode
  readonly message: string
}

export class NativeTransferProviderError extends Error {
  readonly code: NativeTransferProviderErrorCode

  constructor(code: NativeTransferProviderErrorCode, message: string) {
    super(message)
    this.name = 'NativeTransferProviderError'
    this.code = code
  }
}

export function toNativeTransferProviderErrorShape(
  error: unknown
): NativeTransferProviderErrorShape {
  if (error instanceof NativeTransferProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  return Object.freeze({ code: -32603, message: 'Noir Wallet could not complete the request.' })
}

export function parseNativeTransferNoParams(params: readonly unknown[] | undefined): void {
  if (params !== undefined && (!Array.isArray(params) || params.length !== 0)) {
    throw new NativeTransferProviderError(-32602, 'This method does not accept parameters.')
  }
}
