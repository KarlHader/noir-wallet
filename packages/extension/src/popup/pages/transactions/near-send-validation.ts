import { NearWalletClientError } from '@/popup/services/near-wallet-client'

export function getNearSendPrepareError(error: unknown, networkName: string): string {
  if (!(error instanceof NearWalletClientError)) {
    return 'The transfer could not be prepared. Please try again.'
  }
  if (error.code === 'network-unavailable') {
    return `${networkName} is unavailable. Check your connection and try again.`
  }
  if (error.code === 'account-unavailable') {
    return 'This Account has no usable full-access NEAR key.'
  }
  if (error.code === 'insufficient-funds') {
    return 'The NEAR balance cannot cover the amount, fee, and storage reserve.'
  }
  if (error.code === 'invalid-request') {
    return 'Check the amount and ensure the recipient account already exists.'
  }
  if (error.code === 'expired') return 'The review expired. Prepare the transfer again.'
  return 'The transfer could not be prepared. Please try again.'
}

export function getNearSendApprovalError(error: unknown): string {
  if (error instanceof NearWalletClientError && error.code === 'expired') {
    return 'The NEAR review expired. Prepare the transfer again.'
  }
  return 'The transaction could not be signed. Prepare the transfer again and retry.'
}
