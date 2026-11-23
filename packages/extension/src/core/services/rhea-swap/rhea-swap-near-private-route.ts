import { createInitialProductChainRegistry } from '@/core/chains/registry'
import { assertNearIncognitoDirectQuote } from '@/core/chains/near/near-incognito-move'
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

export const NEAR_INCOGNITO_UNFUNDED_ERROR = 'This quote cannot fund the Incognito NEAR account.'

const NEAR_IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/

function nearMainnetChainId(): string | undefined {
  return createInitialProductChainRegistry('mainnet')
    .list()
    .find(chain => chain.family === 'near')?.id
}

/**
 * Public NEAR quotes keep the established account checks. Incognito quotes must
 * use the persisted PEA and never fall through to the public Main route.
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
  if (purpose === 'wallet-swap' || purpose === 'public-cross-chain-send') {
    assertCurrentPublicRoute(request, account, purpose, scope)
    return
  }
  if (purpose === 'confidential-funding' || purpose === 'private-transfer') {
    assertNearIncognitoDirectQuote(request, account, purpose, scope)
    return
  }
  if (purpose !== 'private-swap' && purpose !== 'private-cross-chain-send') {
    throw new Error('Private quote account changed. Get a new quote.')
  }
  const chainId = nearMainnetChainId()
  const network = chainId
    ? account?.networks.find(candidate => candidate.chainId === chainId)
    : undefined
  const pea = network?.privateExecutionAddress
  const mainAddresses = network?.addresses?.map(address => address.value) ?? []
  const senderIsPublicMain = mainAddresses.includes(request.sender)
  const peaReady =
    Boolean(account) &&
    (!scope || (account?.walletId === scope.walletId && account.accountId === scope.accountId)) &&
    request.confidentiality === undefined &&
    typeof pea === 'string' &&
    NEAR_IMPLICIT_ACCOUNT.test(pea) &&
    !mainAddresses.includes(pea) &&
    request.sender === pea &&
    (request.toChain !== 'near' || request.recipient === pea)
  if (peaReady) return
  if (
    senderIsPublicMain ||
    request.sender !== pea ||
    (request.toChain === 'near' && request.recipient !== pea)
  ) {
    throw new Error(NEAR_INCOGNITO_UNFUNDED_ERROR)
  }
  throw new Error('Private quote account changed. Get a new quote.')
}
