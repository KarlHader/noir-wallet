import { parseZcashAddress } from '@/core/address-book/address-book'
import { getZcashChainId } from '@/core/chains/registry'
import type { ShieldProvider } from './asset-domains'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import type { PrepareConfidentialFundingRequest } from './confidential-funding-client'
import { buildExternalShieldWithdrawRequest, buildShieldTransferRequest } from './shield-transfer'

export type ShieldFundsDirection = 'shield' | 'unshield'

export interface ShieldFundsFormState {
  readonly reviewing: boolean
  readonly busy: boolean
}

export interface ShieldFundsFormProps {
  readonly direction: ShieldFundsDirection
  readonly reviewMaximum?: boolean
  readonly assetId?: string | null
  readonly provider?: ShieldProvider | null
  readonly onBack?: () => void
  readonly onStateChange?: (state: ShieldFundsFormState) => void
}

export function fixedShieldFundsDomains(direction: ShieldFundsDirection) {
  return direction === 'shield'
    ? ({ from: 'public', to: 'shield' } as const)
    : ({ from: 'shield', to: 'public' } as const)
}

export function selectShieldFundsAsset(input: {
  readonly direction?: ShieldFundsDirection
  readonly selectedAssetId: string | null
  readonly preferredProvider: ShieldProvider | null
  readonly defaultAssetId: string | null
  readonly zcashAssetId: string
  readonly nativeAvailable: boolean
  readonly nativeFunded: boolean
  readonly confidentialZecFunded: boolean
}): { assetId: string | null; provider: ShieldProvider | null } {
  if (!input.direction) return { assetId: null, provider: null }
  const fundedNative = input.nativeAvailable && input.nativeFunded
  const defaultZec =
    input.nativeAvailable || input.confidentialZecFunded ? input.zcashAssetId : null
  const assetId =
    input.selectedAssetId ??
    (fundedNative ? input.zcashAssetId : (input.defaultAssetId ?? defaultZec))
  if (!assetId) return { assetId: null, provider: null }
  if (assetId !== input.zcashAssetId) return { assetId, provider: 'near-confidential' }
  const nativePreferred =
    input.nativeAvailable &&
    (input.direction === 'shield' || fundedNative || !input.confidentialZecFunded)
  return {
    assetId,
    provider: input.preferredProvider ?? (nativePreferred ? 'zcash-shield' : 'near-confidential')
  }
}

export function shieldFundsPath(
  direction: ShieldFundsDirection,
  assetId: string,
  provider: ShieldProvider
): string {
  return `/${direction}?${new URLSearchParams({ assetId, provider })}`
}

export function buildFixedShieldFundsRequest(
  input: Omit<
    Parameters<typeof buildShieldTransferRequest>[0],
    'from' | 'to' | 'method' | 'destination'
  > & {
    readonly direction: ShieldFundsDirection
    readonly ownTransparentAddress?: string
  }
) {
  const { direction, ownTransparentAddress, ...transfer } = input
  if (direction === 'unshield' && transfer.chain.chain.id === getZcashChainId(transfer.network)) {
    if (
      !ownTransparentAddress ||
      !parseZcashAddress(ownTransparentAddress, transfer.network).scheme.startsWith(
        'zcash-transparent-'
      )
    )
      throw new Error('Unshield requires a transparent address from this account')
    const holding = { asset: transfer.asset, chain: transfer.chain, managed: transfer.managed }
    return Object.freeze({
      ...buildExternalShieldWithdrawRequest({
        ...transfer,
        source: holding,
        destination: holding,
        recipient: ownTransparentAddress
      }),
      purpose: 'move' as const,
      ...(transfer.dedupKey ? { dedupKey: transfer.dedupKey } : {})
    })
  }
  return buildShieldTransferRequest({
    ...transfer,
    ...fixedShieldFundsDomains(direction),
    destination: undefined,
    method: 'directly'
  })
}

export function matchesFixedShieldFundsRecipient(
  review: ConfidentialFundingReview,
  request: PrepareConfidentialFundingRequest,
  ownPublicAddress: string
) {
  if (!ownPublicAddress) return false
  if (request.purpose === 'move') {
    return (
      review.purpose === 'move' &&
      review.externalRecipient === ownPublicAddress &&
      review.destinationAddress === ownPublicAddress
    )
  }
  const publicAddress =
    request.operation === 'deposit' ? review.sourceAddress : review.destinationAddress
  return publicAddress.toLowerCase() === ownPublicAddress.toLowerCase()
}
