import { BitcoinWalletClientError } from '@/popup/services/bitcoin-wallet-client'

export function getBitcoinSendPrepareError(error: unknown): string {
  if (!(error instanceof BitcoinWalletClientError)) {
    return 'The transfer could not be prepared. Please try again.'
  }
  if (error.code === 'network-unavailable') {
    return 'The Bitcoin network is unavailable. Check your connection and try again.'
  }
  if (error.code === 'account-unavailable') {
    return 'This Wallet does not have a Bitcoin account.'
  }
  if (error.code === 'expired') return 'The review expired. Prepare the transfer again.'
  if (error.code === 'insufficient-funds') {
    return 'The confirmed Bitcoin balance cannot cover the amount and network fee.'
  }
  if (error.code === 'invalid-request') return 'Check the amount and Bitcoin address.'
  return 'The transfer could not be prepared. Please try again.'
}

export function getBitcoinSendApprovalError(error: unknown): string {
  if (error instanceof BitcoinWalletClientError && error.code === 'expired') {
    return 'The review expired. Prepare the transfer again.'
  }
  return 'The transaction could not be signed. Prepare the transfer again and retry.'
}
