import { ShieldError, type ShieldErrorCode } from './types'

/** JSON-RPC style codes returned by the wallet Shield provider. */
export type ShieldProviderErrorCode = 4001 | 4100 | 4200 | 4900 | 4901 | -32602 | -32603

const GENERIC_PROVIDER_MESSAGE = 'Noir Wallet could not complete the Shield request.'

/**
 * Another confidential account is not a confirmed 1Click route.
 * The wallet reports this instead of submitting a deposit or withdraw.
 */
export const SHIELD_CONFIDENTIAL_TRANSFER_NOT_CONFIRMED =
  'Shield transfer to another confidential account is not confirmed by the protocol.'

export class ShieldProviderError extends Error {
  readonly code: ShieldProviderErrorCode

  constructor(code: ShieldProviderErrorCode, message: string) {
    super(message)
    this.name = 'ShieldProviderError'
    this.code = code
  }
}

export function shieldErrorToProviderError(error: ShieldError): ShieldProviderError {
  return new ShieldProviderError(providerCodeForShieldError(error.code), error.message)
}

export function toShieldProviderErrorShape(
  error: unknown
): Readonly<{ code: number; message: string }> {
  if (error instanceof ShieldProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  if (error instanceof ShieldError) {
    const provider = shieldErrorToProviderError(error)
    return Object.freeze({ code: provider.code, message: provider.message })
  }
  return Object.freeze({ code: -32603, message: GENERIC_PROVIDER_MESSAGE })
}

/**
 * Map a wallet provider failure onto the client error.
 * The unconfirmed-transfer message stays NOT_CONFIRMED ahead of the generic 4200 code.
 */
export function shieldErrorFromProviderFailure(code: unknown, message: string): ShieldError {
  if (code === 4001) return new ShieldError('REJECTED', message)
  if (/not confirmed by the protocol/i.test(message)) {
    return new ShieldError('NOT_CONFIRMED', message)
  }
  if (code === 4200) return new ShieldError('UNSUPPORTED', message)
  if (code === 4100) return new ShieldError('UNAUTHORIZED', message)
  if (code === 4900 || code === 4901) return new ShieldError('UNAVAILABLE', message)
  if (code === -32602) return new ShieldError('INVALID_PARAMS', message)
  if (code === -32603 && !/0x[0-9a-fA-F]{8,}/.test(message)) {
    return new ShieldError('UNKNOWN', message)
  }
  return new ShieldError('UNKNOWN', GENERIC_PROVIDER_MESSAGE)
}

function providerCodeForShieldError(code: ShieldErrorCode): ShieldProviderErrorCode {
  switch (code) {
    case 'REJECTED':
      return 4001
    case 'UNAUTHORIZED':
      return 4100
    case 'UNSUPPORTED':
    case 'NOT_CONFIRMED':
      return 4200
    case 'UNAVAILABLE':
      return 4900
    case 'INVALID_PARAMS':
      return -32602
    default:
      return -32603
  }
}
