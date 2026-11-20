/** Only these public failure categories may cross the page messaging boundary. */
const messages = {
  signing_unavailable: 'Multisig signing is unavailable. Review this action again.',
  journal_unavailable:
    'Signing history could not be read or saved. Reopen the wallet and try again.',
  intent_not_settleable:
    'A previous signing record needs recovery. Check Activity before trying again.',
  credential_not_bound: 'Your wallet session needs to be unlocked again.',
  account_not_initialized: 'This account is still getting ready. Try again shortly.',
  fee_quote_unavailable: 'The network fee quote is unavailable. Please try again.',
  fee_quote_timeout: 'The network fee quote timed out. Please try again.',
  worker_unavailable: 'The signing runtime is unavailable. Reopen the wallet and try again.',
  roster_unavailable: 'The signing device list is unavailable. Prepare this transfer again.',
  session_initialization_failed:
    'Signing recovery could not finish. Reopen the wallet and try again.'
} as const

export type MultisigSendErrorCode = keyof typeof messages

export function isMultisigSendErrorCode(value: unknown): value is MultisigSendErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(messages, value)
}

export class MultisigSendError extends Error {
  constructor(readonly code: MultisigSendErrorCode) {
    super(messages[code])
    this.name = 'MultisigSendError'
  }
}

export function decodeMultisigSendError(code: unknown): MultisigSendError {
  return new MultisigSendError(isMultisigSendErrorCode(code) ? code : 'signing_unavailable')
}

export function getMultisigSendErrorCode(error: unknown): MultisigSendErrorCode | null {
  return error instanceof MultisigSendError && isMultisigSendErrorCode(error.code)
    ? error.code
    : null
}

export function toMultisigSendError(
  error: unknown,
  fallback: MultisigSendErrorCode = 'signing_unavailable'
): MultisigSendError {
  const code = getMultisigSendErrorCode(error)
  if (code) return new MultisigSendError(code)
  // Legacy Worker failures have fixed messages; never forward arbitrary engine/RPC text.
  if (error instanceof Error) {
    if (
      [
        'Wallet credential session is locked',
        'Wallet is locked',
        'Credential is not unlocked'
      ].includes(error.message)
    )
      return new MultisigSendError('credential_not_bound')
    if (error.message === 'Account not initialized')
      return new MultisigSendError('account_not_initialized')
  }
  return new MultisigSendError(fallback)
}

export function getMultisigSendErrorMessage(error: unknown): string {
  const safe = toMultisigSendError(error)
  return `${safe.message} (${safe.code})`
}
