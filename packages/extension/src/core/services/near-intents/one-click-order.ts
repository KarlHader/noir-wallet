export type OneClickChainFamily = 'evm' | 'solana' | 'near' | 'btc' | 'zcash'

export interface OneClickViewer {
  readonly chainFamily: OneClickChainFamily
  readonly walletAddress: string
  readonly signingMode?: 'derived' | 'transparent' | 'public' | 'private'
}

export interface OneClickOrder {
  readonly depositAddress: string
  readonly depositMemo?: string
  readonly viewer?: OneClickViewer
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const STRING_LIMIT = 512

export function parseOneClickDepositMemo(value: unknown, label = '1Click deposit memo'): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > STRING_LIMIT ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

export function parseOneClickViewer(value: unknown): OneClickViewer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('1Click viewer must be an object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('1Click viewer must be an object')
  }
  const { chainFamily, signingMode, walletAddress } = value as Record<string, unknown>
  const required =
    signingMode === undefined
      ? ['chainFamily', 'walletAddress']
      : ['chainFamily', 'walletAddress', 'signingMode']
  if (
    Object.keys(value).length !== required.length ||
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error('1Click viewer has invalid fields')
  }
  if (
    (chainFamily !== 'evm' &&
      chainFamily !== 'solana' &&
      chainFamily !== 'near' &&
      chainFamily !== 'btc' &&
      chainFamily !== 'zcash') ||
    (signingMode !== undefined &&
      signingMode !== 'derived' &&
      signingMode !== 'transparent' &&
      signingMode !== 'public' &&
      signingMode !== 'private')
  ) {
    throw new Error('1Click viewer is invalid')
  }
  if (
    typeof walletAddress !== 'string' ||
    !walletAddress ||
    walletAddress.trim() !== walletAddress ||
    walletAddress.length > STRING_LIMIT ||
    CONTROL_CHARACTERS.test(walletAddress)
  ) {
    throw new Error('1Click viewer address must be a bounded non-empty string')
  }
  return Object.freeze({
    chainFamily,
    walletAddress,
    ...(signingMode === undefined ? {} : { signingMode })
  })
}

export function createOneClickOrder(
  depositAddress: string,
  depositMemo?: string,
  viewer?: OneClickViewer
): OneClickOrder {
  return Object.freeze({
    depositAddress,
    ...(depositMemo === undefined ? {} : { depositMemo: parseOneClickDepositMemo(depositMemo) }),
    ...(viewer ? { viewer: Object.freeze({ ...viewer }) } : {})
  })
}
