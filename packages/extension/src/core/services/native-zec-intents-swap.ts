import type { Network, QuoteBinding } from '@/types/wallet'

export interface PrepareNativeZecIntentsSwapInput {
  readonly network: Network
  readonly walletId: string
  readonly accountId: string
  readonly amountZats: string
  readonly destination: Readonly<{
    chainId: string
    assetId: string
    protocolAssetId: string
    recipient?: string
  }>
  readonly refundAddress: string
  readonly recipientType?: 'DESTINATION_CHAIN' | 'CONFIDENTIAL_INTENTS'
  readonly fundingSource?: 'transparent' | 'shielded'
  readonly slippageBps: number
  readonly requestId?: string
}

export interface NativeZecIntentsSwapReview {
  readonly quoteId: string
  readonly network: Network
  readonly walletId: string
  readonly accountId: string
  readonly amountZats: string
  readonly amountZec: string
  readonly depositAddress: string
  readonly destination: PrepareNativeZecIntentsSwapInput['destination']
  readonly destinationBlockchain: string
  readonly destinationSymbol: string
  readonly destinationDecimals: number
  readonly refundAddress: string
  readonly recipientType?: 'CONFIDENTIAL_INTENTS'
  readonly fundingSource?: 'transparent' | 'shielded'
  readonly expectedOutputRaw: string
  readonly minimumOutputRaw: string
  readonly expiresAt: number
  readonly quoteBinding: QuoteBinding
}

export interface NativeZecIntentsSwapRecord extends NativeZecIntentsSwapReview {
  readonly schemaVersion: 1 | 2
  readonly requestId?: string
  readonly slippageBps: number
  readonly createdAt: number
  readonly claimedTransactionId?: string
  readonly terminalStatus?: 'SUCCESS' | 'REFUNDED' | 'FAILED'
  readonly terminalAt?: number
}

export function zatsToZec(amountZats: string): string {
  if (!/^[1-9][0-9]{0,77}$/.test(amountZats)) {
    throw new Error('Native ZEC swap amount is invalid')
  }
  const whole = BigInt(amountZats) / 100_000_000n
  const fraction = (BigInt(amountZats) % 100_000_000n).toString().padStart(8, '0')
  return `${whole}.${fraction}`.replace(/\.?0+$/, '')
}

export function zecToZats(amountZec: string): string {
  if (!/^(0|[1-9][0-9]{0,69})(\.[0-9]{1,8})?$/.test(amountZec)) {
    throw new Error('Native ZEC swap amount is invalid')
  }
  const [whole, fraction = ''] = amountZec.split('.')
  return (BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0') || '0')).toString()
}
