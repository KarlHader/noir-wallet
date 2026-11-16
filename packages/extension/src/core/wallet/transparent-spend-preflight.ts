import { safeBig } from '@/lib/big'
import { getShieldableTransparentBalance } from '@/core/zcash/shielding'
import type { ZcashBalance } from '@/types'

export const TRANSPARENT_FUNDS_NOT_READY_MESSAGE =
  'Some transparent funds are not spendable yet. Wait for a confirmation and try again.'

interface TransparentSpendCore {
  syncSessionSetup(): Promise<void>
  getBalance(accountIndex?: number): Promise<ZcashBalance>
}

export function usesPendingTransparentFunds(amount: string, balance: ZcashBalance): boolean {
  const requested = safeBig(amount)
  return (
    requested.gt(getShieldableTransparentBalance(balance)) && requested.lte(balance.transparent)
  )
}

/** Refresh transparent UTXOs at the current chain tip before selecting inputs. */
export async function prepareTransparentSpend(
  core: TransparentSpendCore,
  amount?: string,
  accountIndex?: number
): Promise<ZcashBalance> {
  await core.syncSessionSetup()
  const balance = await core.getBalance(accountIndex)

  if (amount && usesPendingTransparentFunds(amount, balance)) {
    throw new Error(TRANSPARENT_FUNDS_NOT_READY_MESSAGE)
  }

  return balance
}
