import type { IntentsAppFee, NoirIntentsReferral } from '@/config/intents'
import type { OneClickViewer } from './one-click-order'

export interface OneClickQuoteRequest {
  readonly dry: boolean
  readonly swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT'
  readonly slippageTolerance: number
  readonly originAsset: string
  readonly depositType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
  readonly destinationAsset: string
  readonly amount: string
  readonly refundTo: string
  readonly refundType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
  readonly recipient: string
  readonly recipientType: 'DESTINATION_CHAIN' | 'CONFIDENTIAL_INTENTS'
  readonly referral: NoirIntentsReferral
  readonly confidentiality?: 'basic'
  readonly appFees?: readonly IntentsAppFee[]
  readonly deadline: string
  readonly quoteWaitingTimeMs: number
}

export interface OneClickQuoteOptions {
  readonly viewer: OneClickViewer | null
  readonly signal?: AbortSignal
}

export function createOneClickQuoteRequest(
  input: Omit<OneClickQuoteRequest, 'deadline' | 'quoteWaitingTimeMs'>
): OneClickQuoteRequest {
  return {
    ...input,
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
    quoteWaitingTimeMs: input.confidentiality === 'basic' ? 0 : 3_000
  }
}

export function requestOneClickQuote<Result>(
  endpoint: string,
  quote: OneClickQuoteRequest,
  request: (url: string, init: RequestInit) => Promise<Result>,
  options: OneClickQuoteOptions
): Promise<Result> {
  const viewer = quote.dry ? null : options.viewer
  if (viewer === undefined) throw new Error('1Click quote owner must be specified')
  return request(`${endpoint}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...quote,
      user: viewer?.walletAddress,
      userChainFamily: viewer?.chainFamily
    }),
    signal: options.signal
  })
}

export function matchesOneClickQuoteViewer(
  echoed: Readonly<Record<string, unknown>>,
  viewer: OneClickViewer | null
): boolean {
  const { user, userChainFamily } = echoed
  return (
    (user === undefined ||
      (typeof user === 'string' &&
        (viewer?.chainFamily === 'evm'
          ? user.toLowerCase() === viewer.walletAddress.toLowerCase()
          : user === viewer?.walletAddress))) &&
    (userChainFamily === undefined || userChainFamily === viewer?.chainFamily)
  )
}
