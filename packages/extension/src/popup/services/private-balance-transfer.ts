import { parseDisplayUnitAmount } from '@/lib/number-format'

export type PrivateBalanceTransferDirection = 'main-to-private' | 'private-to-main'

export function resolvePrivateBalanceTransferSource(input: {
  readonly direction: PrivateBalanceTransferDirection
  readonly mainBalanceRaw: string
  readonly privateBalanceRaw: string
  readonly mainAddress: string
  readonly privateAddress: string
}) {
  return input.direction === 'main-to-private'
    ? {
        availableRaw: input.mainBalanceRaw,
        sender: input.mainAddress,
        recipient: input.privateAddress,
        executionMode: 'main' as const,
        sourceLabel: 'Public' as const
      }
    : {
        availableRaw: input.privateBalanceRaw,
        sender: input.privateAddress,
        recipient: input.mainAddress,
        executionMode: 'private' as const,
        sourceLabel: 'Confidential' as const
      }
}

export interface PrivateBalanceTransferAmountState {
  readonly amountRaw: string | null
  readonly error: string | null
}

export function resolvePrivateBalanceTransferAmount(input: {
  readonly amount: string
  readonly decimals: number
  readonly availableRaw: string
  readonly sourceLabel: 'Public' | 'Confidential'
}): PrivateBalanceTransferAmountState {
  if (input.amount.length === 0 || input.amount === '.')
    return Object.freeze({ amountRaw: null, error: null })
  try {
    const amountRaw = parseDisplayUnitAmount(input.amount, input.decimals)
    if (BigInt(amountRaw) === 0n) {
      return Object.freeze({ amountRaw: null, error: null })
    }
    if (BigInt(amountRaw) > BigInt(input.availableRaw)) {
      return Object.freeze({
        amountRaw: null,
        error: `Amount exceeds the ${input.sourceLabel} balance`
      })
    }
    return Object.freeze({ amountRaw, error: null })
  } catch {
    return Object.freeze({ amountRaw: null, error: 'Enter a valid amount' })
  }
}

export function normalizePrivateBalanceTransferInput(value: string): string | null {
  if (value.length > 128 || !/^\d*(?:\.\d*)?$/.test(value)) return null
  return value
}
