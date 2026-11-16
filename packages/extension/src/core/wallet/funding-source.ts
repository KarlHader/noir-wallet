import type { FundingSource, KeySource, ZcashBalance } from '../../types/wallet'
import { getFundingBalance, type FundingBalance } from './funding-balance'

export interface FundingSourceOption extends FundingBalance {
  readonly type: FundingSource
  readonly address: string
  readonly disabledReason?: string
}

export function getFundingSourceUnavailableReason(
  keySource: KeySource | undefined,
  source: FundingSource
): string | undefined {
  return keySource === 'keystone' && source === 'transparent'
    ? 'Transparent funding is not supported by Keystone.'
    : undefined
}

export function getFundingSourceOptions(
  balance: ZcashBalance | null | undefined,
  addresses: Readonly<Partial<Record<FundingSource, string>>>,
  keySource: KeySource | undefined
): FundingSourceOption[] {
  return (['shielded', 'transparent'] as const).map(type => ({
    type,
    address: addresses[type] ?? '',
    ...getFundingBalance(balance, type),
    disabledReason:
      getFundingSourceUnavailableReason(keySource, type) ??
      (addresses[type] ? undefined : 'Address is not available yet.')
  }))
}
