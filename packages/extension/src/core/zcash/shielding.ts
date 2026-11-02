import { WALLET_CONFIG, ZEC_DECIMALS } from '@/config/wallet'
import { safeBig } from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { ZcashBalance } from '@/types'
import type { WasmTransactionEntry } from '@/core/worker/types'

type ShieldingBalance = string | number | null | undefined

export const MIN_SHIELDING_BALANCE_MESSAGE = `At least ${WALLET_CONFIG.SHIELDING_THRESHOLD} ZEC of confirmed transparent funds is required to shield.`

export function hasEnoughTransparentBalanceToShield(balance: ShieldingBalance): boolean {
  return safeBig(balance).gte(WALLET_CONFIG.SHIELDING_THRESHOLD)
}

export function getShieldableTransparentBalance(balance: ZcashBalance | null | undefined): string {
  if (!balance) return '0'
  if (balance.shieldable != null) return safeBig(balance.shieldable).toFixed()

  const confirmedFallback = safeBig(balance.transparent).minus(balance.pending?.transparent ?? '0')
  return confirmedFallback.gt(0) ? confirmedFallback.toFixed() : '0'
}

export function canShieldTransparentFunds(balance: ZcashBalance | null | undefined): boolean {
  return hasEnoughTransparentBalanceToShield(getShieldableTransparentBalance(balance))
}

function wasmTxidToHex(txid: number[]): string {
  return Array.from(txid)
    .reverse()
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function getShieldInputAmountFromHistory(
  entries: WasmTransactionEntry[],
  txid: string
): string | null {
  const normalizedTxid = txid.toLowerCase()
  const entry = entries.find(
    transaction =>
      transaction.kind === 'shield' &&
      wasmTxidToHex(transaction.txid).toLowerCase() === normalizedTxid
  )
  if (!entry) return null

  const inputZatoshis = safeBig(entry.amount_zatoshis).plus(entry.fee_zatoshis ?? 0)
  return inputZatoshis.gt(0)
    ? formatBaseUnitDecimalAmount(inputZatoshis.toFixed(), ZEC_DECIMALS)
    : null
}
