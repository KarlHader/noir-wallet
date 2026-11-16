import type { UnlockResult } from './zcash-wallet-runtime-client'

export function getUnlockFailureMessage(result: UnlockResult): string {
  if (result.failure === 'credential_missing') {
    return 'Wallet access data is missing. Restore from your secret phrase.'
  }
  if (result.failure === 'credential_invalid') {
    return 'Wallet access data is damaged. Restore from your secret phrase.'
  }
  if (result.failure === 'operation_failed') {
    return 'Wallet could not be unlocked. Try again.'
  }
  if (result.remainingAttempts !== undefined && result.remainingAttempts <= 2) {
    return `Incorrect password. ${result.remainingAttempts} attempts remaining.`
  }
  return 'Incorrect password'
}
