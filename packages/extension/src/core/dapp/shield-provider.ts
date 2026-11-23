import { Eip1193ProviderError } from './eip1193'

export const SHIELD_DAPP_RUNTIME_METHODS = Object.freeze([
  'shield_connect',
  'shield_disconnect',
  'shield_getQuote',
  'shield_getSupportedChains',
  'shield_getSupportedTokens',
  'shield_getTransactionStatus',
  'shield_receive',
  'shield_transfer',
  'shield_refreshBalances'
] as const)

export type ShieldDAppRuntimeMethod = (typeof SHIELD_DAPP_RUNTIME_METHODS)[number]

export type ShieldProviderErrorCode = 4001 | 4100 | 4200 | 4900 | -32602 | -32603

const GENERIC_SHIELD_MESSAGE = 'Noir Wallet could not complete the Shield request.'

export class ShieldProviderError extends Error {
  readonly code: ShieldProviderErrorCode

  constructor(code: ShieldProviderErrorCode, message: string) {
    super(message)
    this.name = 'ShieldProviderError'
    this.code = code
  }
}

const UNLOCK_MESSAGE = 'Unlock the wallet before using Shield.'
const SOFTWARE_ACCOUNT_MESSAGE = 'Shield requires an unlocked software EVM account.'

function safePublicMessage(message: string): string | null {
  const text = message.trim()
  if (text.length === 0 || text.length > 240) return null
  if (
    /0x[0-9a-fA-F]{8,}|bearer\s+|eyJ[A-Za-z0-9_-]{12,}|secp256k1:|accessToken|refreshToken|private key|seed phrase|mnemonic/i.test(
      text
    )
  ) {
    return null
  }
  return text
}

function errorStatus(error: Error): number | null {
  if (!('status' in error)) return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

/** A locked credential can be recovered by showing the unlock window once. */
export function isShieldUnlockRetryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'KeyringError' && 'code' in error && error.code === 'CREDENTIAL_LOCKED') {
    return true
  }
  return /wallet is locked|credential is not unlocked/i.test(error.message)
}

export function toShieldProviderErrorShape(
  error: unknown
): Readonly<{ code: number; message: string }> {
  if (error instanceof ShieldProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  if (error instanceof Eip1193ProviderError && error.code === 4001) {
    return Object.freeze({ code: 4001, message: error.message })
  }
  if (!(error instanceof Error)) {
    return Object.freeze({ code: -32603, message: GENERIC_SHIELD_MESSAGE })
  }
  const message = safePublicMessage(error.message) ?? GENERIC_SHIELD_MESSAGE
  if (error.name === 'KeyringError' && 'code' in error) {
    if (error.code === 'USER_REJECTED' || error.code === 'SIGNING_COMMAND_CANCELLED') {
      return Object.freeze({ code: 4001, message })
    }
    if (error.code === 'CREDENTIAL_LOCKED') {
      return Object.freeze({ code: 4100, message: UNLOCK_MESSAGE })
    }
    if (
      error.code === 'WORKER_UNAVAILABLE' ||
      error.code === 'WORKER_CRASHED' ||
      error.code === 'COMMAND_TIMEOUT'
    ) {
      return Object.freeze({ code: 4900, message })
    }
  }
  if (error.name === 'ConfidentialFundingApiError') {
    const status = errorStatus(error)
    if (status === 401 || status === 403) {
      return Object.freeze({ code: 4100, message: 'Shield session authorization was rejected.' })
    }
    return Object.freeze({
      code: 4900,
      message:
        message === GENERIC_SHIELD_MESSAGE ? 'Shield session service is unavailable.' : message
    })
  }
  if (/wallet is locked|credential is not unlocked/i.test(error.message)) {
    return Object.freeze({ code: 4100, message: UNLOCK_MESSAGE })
  }
  if (/software evm account/i.test(error.message)) {
    return Object.freeze({ code: 4100, message: SOFTWARE_ACCOUNT_MESSAGE })
  }
  if (/^Shield (amount|token|chain|destination|quote) /i.test(error.message)) {
    return Object.freeze({ code: -32602, message })
  }
  if (/authorization is required|active account|account changed/i.test(error.message)) {
    return Object.freeze({ code: 4100, message })
  }
  if (
    /network changed|network is unavailable|service is temporarily unavailable|nonce salt|session response|access token expiry|keyring worker|keyring command timed out/i.test(
      error.message
    )
  ) {
    return Object.freeze({ code: 4900, message })
  }
  return Object.freeze({ code: -32603, message })
}
