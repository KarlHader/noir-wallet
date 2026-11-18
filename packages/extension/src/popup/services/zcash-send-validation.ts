import { parseZcashAddress } from '@/core/address-book/address-book'
import { WALLET_CONFIG } from '@/config/wallet'
import {
  getFundingAmountError,
  getFundingAmountErrorCopy,
  getFundingBalance,
  type FundingBalance
} from '@/core/wallet/funding-balance'
import {
  getShieldableTransparentBalance,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import { safeBig } from '@/lib/big'
import { isZnsName } from '@/lib/zns'
import type { AccountAddresses, Network, ZcashBalance } from '@/types/wallet'

function isNonZnsAddressInput(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/i.test(value)
}

export function resolveZcashSendRecipientInput(
  input: string,
  network: Network
): Readonly<{
  resolvedAddress: string
  znsInput: string
  formatError: string | null
}> {
  const trimmed = input.trim()
  if (!trimmed) {
    return { resolvedAddress: '', znsInput: '', formatError: null }
  }
  if (isNonZnsAddressInput(trimmed)) {
    return {
      resolvedAddress: '',
      znsInput: '',
      formatError: 'Enter a valid Zcash address.'
    }
  }
  if (isZnsName(trimmed)) {
    return { resolvedAddress: '', znsInput: trimmed, formatError: null }
  }
  try {
    const parsed = parseZcashAddress(trimmed, network)
    return { resolvedAddress: parsed.address, znsInput: '', formatError: null }
  } catch {
    return {
      resolvedAddress: '',
      znsInput: '',
      formatError: 'Enter a valid Zcash address.'
    }
  }
}

/** Drop recipient when switching funding source if it is own or not a valid Zcash address. */
export function shouldRetainZcashSendRecipient(
  recipient: string,
  accountAddresses: AccountAddresses | undefined
): boolean {
  const trimmed = recipient.trim()
  if (!trimmed) return true
  const ownAddresses = accountAddresses
    ? (Object.values(accountAddresses).filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      ) as string[])
    : []
  if (ownAddresses.includes(trimmed)) return false
  return true
}

export function isZcashSendRecipientReady(
  resolvedAddress: string,
  formatError: string | null,
  znsLoading: boolean
): boolean {
  return Boolean(resolvedAddress) && formatError === null && !znsLoading
}

/** Cap transparent sends at shieldable confirmed funds when locked UTXOs are present. */
export function resolveZcashTransparentShieldFundingBalance(
  balance: ZcashBalance | null | undefined
): FundingBalance {
  const funding = getFundingBalance(balance, 'transparent')
  const shieldable = getShieldableTransparentBalance(balance)
  return safeBig(funding.available).gt(shieldable)
    ? { available: shieldable, pending: funding.pending }
    : funding
}

export function getZcashTransparentToShieldMoveAmountError(
  amount: string,
  balance: ZcashBalance | null | undefined,
  maximumAmount?: string | null
): string | undefined {
  const fundingError = getFundingAmountError(
    amount,
    resolveZcashTransparentShieldFundingBalance(balance),
    maximumAmount
  )
  if (fundingError) return getFundingAmountErrorCopy(fundingError)
  const value = safeBig(amount || '0')
  if (value.gt(0) && value.lt(WALLET_CONFIG.SHIELDING_THRESHOLD)) {
    return MIN_SHIELDING_BALANCE_MESSAGE
  }
  return undefined
}
