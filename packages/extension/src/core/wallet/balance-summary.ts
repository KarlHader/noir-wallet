import { WALLET_CONFIG, ZEC_DECIMALS } from '../../config/wallet.ts'
import { formatBaseUnitDecimalAmount } from '../../lib/number-format.ts'
import type { ZcashBalance } from '../../types/wallet.ts'

export type WasmAccountBalanceSummary = {
  sapling_balance?: bigint | number | string
  orchard_balance?: bigint | number | string
  ironwood_balance?: bigint | number | string
  unshielded_balance?: bigint | number | string
  unshielded_shieldable_balance?: bigint | number | string
  sapling_pending_balance?: bigint | number | string
  orchard_pending_balance?: bigint | number | string
  ironwood_pending_balance?: bigint | number | string
  unshielded_pending_balance?: bigint | number | string
  sapling_total_balance?: bigint | number | string
  orchard_total_balance?: bigint | number | string
  ironwood_total_balance?: bigint | number | string
  unshielded_total_balance?: bigint | number | string
  spendable_balance?: bigint | number | string
  pending_balance?: bigint | number | string
  total_balance?: bigint | number | string
}

function zatoshiValue(value: bigint | number | string | undefined): bigint {
  if (value == null || value === '') return 0n
  return BigInt(value)
}

function formatZatoshis(value: bigint): string {
  return formatBaseUnitDecimalAmount(value, ZEC_DECIMALS)
}

function formatZatoshisFixed(value: bigint): string {
  return Number(formatZatoshis(value)).toFixed(ZEC_DECIMALS)
}

/** Tier-agnostic available balance reserves the Standard fee and wallet dust threshold. */
export function getMaxSpendableZec(shieldedBalance: string | number): string {
  const rawBalance =
    typeof shieldedBalance === 'number' ? shieldedBalance : Number(shieldedBalance || 0)
  const reserve = WALLET_CONFIG.NETWORK_FEE * 2 + WALLET_CONFIG.DUST_THRESHOLD
  return Math.max(0, rawBalance - reserve).toFixed(ZEC_DECIMALS)
}

export function mapWasmAccountBalanceToZcashBalance(
  wasmBalance: WasmAccountBalanceSummary
): ZcashBalance {
  const saplingConfirmed = zatoshiValue(wasmBalance.sapling_balance)
  const orchardConfirmed = zatoshiValue(wasmBalance.orchard_balance)
  const ironwoodConfirmed = zatoshiValue(wasmBalance.ironwood_balance)
  const transparentConfirmed = zatoshiValue(wasmBalance.unshielded_balance)

  const saplingTotal =
    wasmBalance.sapling_total_balance != null
      ? zatoshiValue(wasmBalance.sapling_total_balance)
      : saplingConfirmed
  const orchardTotal =
    wasmBalance.orchard_total_balance != null
      ? zatoshiValue(wasmBalance.orchard_total_balance)
      : orchardConfirmed
  const ironwoodTotal =
    wasmBalance.ironwood_total_balance != null
      ? zatoshiValue(wasmBalance.ironwood_total_balance)
      : ironwoodConfirmed
  const transparentTotal =
    wasmBalance.unshielded_total_balance != null
      ? zatoshiValue(wasmBalance.unshielded_total_balance)
      : transparentConfirmed

  const shieldedTotal = saplingTotal + orchardTotal + ironwoodTotal
  const total =
    wasmBalance.total_balance != null
      ? zatoshiValue(wasmBalance.total_balance)
      : shieldedTotal + transparentTotal

  const saplingPending = zatoshiValue(wasmBalance.sapling_pending_balance)
  const orchardPending = zatoshiValue(wasmBalance.orchard_pending_balance)
  const ironwoodPending = zatoshiValue(wasmBalance.ironwood_pending_balance)
  const transparentPending = zatoshiValue(wasmBalance.unshielded_pending_balance)
  const shieldedPending = saplingPending + orchardPending + ironwoodPending
  const pending =
    wasmBalance.pending_balance != null
      ? zatoshiValue(wasmBalance.pending_balance)
      : shieldedPending + transparentPending

  const shieldedConfirmed = saplingConfirmed + orchardConfirmed + ironwoodConfirmed
  const spendable =
    wasmBalance.spendable_balance != null
      ? zatoshiValue(wasmBalance.spendable_balance)
      : shieldedConfirmed
  const spendableZec = formatZatoshis(spendable)

  return {
    transparent: formatZatoshis(transparentTotal),
    shielded: formatZatoshis(shieldedTotal),
    total: formatZatoshis(total),
    spendable: spendableZec,
    available: getMaxSpendableZec(spendableZec),
    shieldable: formatZatoshis(
      wasmBalance.unshielded_shieldable_balance == null
        ? transparentConfirmed
        : zatoshiValue(wasmBalance.unshielded_shieldable_balance)
    ),
    shieldedPools: {
      sapling: formatZatoshis(saplingTotal),
      orchard: formatZatoshis(orchardTotal),
      ironwood: formatZatoshis(ironwoodTotal)
    },
    confirmed: {
      shielded: formatZatoshis(shieldedConfirmed),
      transparent: formatZatoshis(transparentConfirmed)
    },
    pending: {
      shielded: formatZatoshis(shieldedPending),
      transparent: formatZatoshis(transparentPending),
      total: formatZatoshis(pending)
    }
  }
}

export function zeroZcashBalance(): ZcashBalance {
  return {
    transparent: '0',
    shielded: '0',
    total: '0',
    spendable: '0',
    available: formatZatoshisFixed(0n),
    shieldable: '0',
    shieldedPools: { sapling: '0', orchard: '0', ironwood: '0' },
    confirmed: { shielded: '0', transparent: '0' },
    pending: { shielded: '0', transparent: '0', total: '0' }
  }
}
