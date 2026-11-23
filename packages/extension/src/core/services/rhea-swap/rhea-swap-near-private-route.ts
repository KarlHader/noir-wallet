import type { QuoteRequest } from './rhea-swap-protocol'
import type { PrivateQuotePurpose, PrivateSwapAccountRoute } from './rhea-swap-model'

type EstablishedPrivateQuoteRoute = (
  request: Pick<
    QuoteRequest,
    'fromChain' | 'toChain' | 'tokenIn' | 'tokenOut' | 'sender' | 'recipient' | 'confidentiality'
  >,
  account: PrivateSwapAccountRoute | null,
  purpose: PrivateQuotePurpose,
  scope?: Pick<PrivateSwapAccountRoute, 'walletId' | 'accountId'> & {
    readonly zcashFundingSource?: 'transparent' | 'shielded'
  }
) => void

/**
 * NEAR private quote routes stay rejected. Public NEAR quotes continue through
 * the existing account and address checks.
 */
export function assertNearPrivateQuoteRoute(
  request: Pick<
    QuoteRequest,
    'fromChain' | 'toChain' | 'tokenIn' | 'tokenOut' | 'sender' | 'recipient' | 'confidentiality'
  >,
  account: PrivateSwapAccountRoute | null,
  purpose: PrivateQuotePurpose,
  scope:
    | (Pick<PrivateSwapAccountRoute, 'walletId' | 'accountId'> & {
        readonly zcashFundingSource?: 'transparent' | 'shielded'
      })
    | undefined,
  assertCurrentPublicRoute: EstablishedPrivateQuoteRoute
): void {
  if (purpose !== 'wallet-swap' && purpose !== 'public-cross-chain-send') {
    throw new Error('Private quote account changed. Get a new quote.')
  }
  assertCurrentPublicRoute(request, account, purpose, scope)
}
