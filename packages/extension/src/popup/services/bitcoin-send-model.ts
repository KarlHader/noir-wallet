import type { BitcoinPsbtSummary } from '@/core/keyring/domain'
import { formatInsufficientBalance } from '@/lib/format'
import { BitcoinWalletClientError } from './bitcoin-wallet-client'

type BitcoinSigningInput = BitcoinPsbtSummary['fields']['inputs'][number]

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
    return formatInsufficientBalance('BTC')
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

export function isBitcoinBalanceKnown(updatedAt: number): boolean {
  return Number.isSafeInteger(updatedAt) && updatedAt > 0
}

export function isBitcoinSendAmountValid(input: {
  readonly sendMaximum: boolean
  readonly amountRaw: string | null
  readonly availableRaw: string
  readonly balanceKnown: boolean
}): boolean {
  if (input.sendMaximum) return true
  if (input.amountRaw === null || BigInt(input.amountRaw) <= 0n) return false
  return !input.balanceKnown || BigInt(input.amountRaw) <= BigInt(input.availableRaw)
}

export function formatBitcoinInputAddressType(inputs: readonly BitcoinSigningInput[]): string {
  const scriptTypes = new Set(inputs.map(input => input.scriptType))
  if (scriptTypes.size === 0) return 'Bitcoin'
  if (scriptTypes.size > 1) return 'Mixed Bitcoin inputs'
  switch (inputs[0]?.scriptType) {
    case 'p2pkh':
      return 'Legacy · BIP-44'
    case 'p2sh-p2wpkh':
      return 'Nested SegWit · BIP-49'
    case 'p2wpkh':
      return 'Native SegWit · BIP-84'
    case 'p2tr':
      return 'Taproot · BIP-86'
    default:
      return 'Bitcoin'
  }
}
