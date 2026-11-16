import type { ConfidentialAssetSupport } from '@/core/services/rhea-swap/rhea-confidential-support'
import type { EvmAddressRole } from '@/core/accounts/evm-address-role'

export type EvmSendRoute = 'onchain' | 'confidential' | 'pending'

export function createEvmSendIntentKey(input: {
  readonly contextKey: string
  readonly assetId: string
  readonly assetReference: string
  readonly decimals: number
  readonly route: EvmSendRoute
  readonly recipientRole: EvmAddressRole
  readonly recipient: string
  readonly amountRaw: string | null
}): string {
  return JSON.stringify(input)
}

export function resolveEvmSendAvailableRaw(
  balance:
    | {
        readonly availableRaw: string
        readonly mainRaw?: string
        readonly privateOnchainRaw?: string
      }
    | undefined,
  sourceMode: 'main' | 'private'
): string | null {
  if (!balance) return null
  return sourceMode === 'private' ? (balance.privateOnchainRaw ?? null) : (balance.mainRaw ?? null)
}

export function resolveEvmSendRoute(
  sourceMode: 'main' | 'private',
  support: ConfidentialAssetSupport,
  sendPrivately = false
): EvmSendRoute {
  if (sendPrivately) return support === 'supported' ? 'confidential' : 'pending'
  if (sourceMode === 'main') return 'onchain'
  return support === 'supported'
    ? 'confidential'
    : support === 'unsupported'
      ? 'onchain'
      : 'pending'
}

export function getEvmSendRecipientError(
  sourceMode: 'main' | 'private',
  recipientRole: EvmAddressRole,
  sendPrivately = false,
  canMove = false
): string | null {
  if (sourceMode !== 'main' || recipientRole !== 'confidential' || sendPrivately) return null
  return canMove
    ? 'This is your Private address.'
    : 'Turn on Send privately to send to this Private address.'
}

export function getEvmSendPrivacyWarning(
  sourceMode: 'main' | 'private',
  recipientRole: EvmAddressRole
): string | null {
  if (sourceMode === 'private')
    return 'This is a direct on-chain transfer and may reveal a link between these addresses.'
  return recipientRole === 'public'
    ? null
    : 'This transfer may reveal a link between these addresses.'
}
