import type { BitcoinPsbtSummary } from '@/core/keyring/domain'

type BitcoinSigningInput = BitcoinPsbtSummary['fields']['inputs'][number]

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
