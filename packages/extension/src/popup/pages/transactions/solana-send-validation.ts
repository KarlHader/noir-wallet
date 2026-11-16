import { SolanaWalletClientError } from '@/popup/services/solana-wallet-client'

export function getSolanaSendPrepareError(
  error: unknown,
  networkName: string,
  symbol: string
): string {
  if (!(error instanceof SolanaWalletClientError)) {
    return 'The transfer could not be prepared. Please try again.'
  }
  if (error.code === 'network-unavailable') {
    return `${networkName} is unavailable. Check your connection and try again.`
  }
  if (error.code === 'account-unavailable') return 'This Wallet does not have a Solana account.'
  if (error.code === 'insufficient-funds') {
    return `The ${symbol} balance or SOL fee balance is insufficient.`
  }
  if (error.code === 'invalid-request') return 'Check the amount and Solana address.'
  if (error.code === 'expired') return 'The review expired. Prepare the transfer again.'
  return 'The transfer could not be prepared. Please try again.'
}

export function getSolanaSendApprovalError(error: unknown): string {
  if (error instanceof SolanaWalletClientError && error.code === 'expired') {
    return 'The recent blockhash expired. Prepare the transfer again.'
  }
  return 'The transaction could not be signed. Prepare the transfer again and retry.'
}
