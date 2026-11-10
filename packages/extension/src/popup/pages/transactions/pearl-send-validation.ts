import { PearlWalletClientError } from '@/popup/services/pearl-wallet-client'

export function getPearlSendPrepareError(error: unknown): string {
  if (!(error instanceof PearlWalletClientError)) {
    return 'The transfer could not be prepared. Please try again.'
  }
  if (error.code === 'network-unavailable') {
    return 'The Pearl network is unavailable. Check your connection and try again.'
  }
  if (error.code === 'account-unavailable') {
    return 'This Wallet does not have a Pearl account.'
  }
  if (error.code === 'expired') return 'The review expired. Prepare the transfer again.'
  if (error.code === 'insufficient-funds') {
    return 'The confirmed Pearl balance cannot cover the amount and network fee.'
  }
  if (error.code === 'invalid-request') return 'Check the amount and Pearl address.'
  return 'The transfer could not be prepared. Please try again.'
}

export function getPearlSendApprovalError(error: unknown): string {
  if (error instanceof PearlWalletClientError && error.code === 'expired') {
    return 'The review expired. Prepare the transfer again.'
  }
  return 'The transaction could not be signed. Prepare the transfer again and retry.'
}
