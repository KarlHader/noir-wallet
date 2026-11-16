import {
  parseRheaSwapCatalogResult,
  parseRheaSwapEvmSignatureReview,
  parseRheaSwapEvmSignaturePlan,
  parseRheaSwapEvmTransactionPlan,
  parseRheaSwapOrderStatusView,
  parseRheaSwapQuoteRequest,
  parseRheaSwapQuoteView,
  parseRheaSwapReviewView,
  parseRheaSwapSubmissionView,
  parseRheaSwapSignedOrderResult,
  parseRheaSwapSolanaTransactionReview,
  parseRheaSwapNearTransactionBatchReview,
  RHEA_SWAP_TOKEN_CATALOG_TTL_MS,
  RHEA_SWAP_CHAIN_CATALOG,
  type RheaSwapCatalogResult,
  type RheaSwapEvmSignatureReview,
  type RheaSwapEvmSignaturePlan,
  type RheaSwapEvmTransactionPlan,
  type RheaSwapOrderStatusView,
  type RheaSwapQuoteRequest,
  type RheaSwapQuoteView,
  type RheaSwapReviewView,
  type RheaSwapSignedOrderResult,
  type RheaSwapSolanaTransactionReview,
  type RheaSwapNearTransactionBatchReview,
  type RheaSwapSubmissionView
} from '@/core/services/rhea-swap'
import type { RheaSwapTransactionBinding } from '@/core/transactions/domain'
import { classifyError } from '@/lib/errors'
import {
  getSwapQuoteFailureMessage,
  isSwapQuotePriceMoved,
  isSwapQuoteTimeout,
  readSwapErrorReason,
  SWAP_QUOTE_DISPLAY_ERROR
} from './swap-quote-error-message'

export class RheaSwapClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RheaSwapClientError'
  }
}

export function getRheaSwapErrorMessage(error: unknown): string {
  if (isSwapQuotePriceMoved(error))
    return getSwapQuoteFailureMessage(error) ?? classifyError(error).userMessage
  if (!(error instanceof RheaSwapClientError)) return classifyError(error).userMessage
  if (error.message === 'RHEA Swap quote does not match its request') {
    return 'Swap quote details could not be verified. Get a new quote.'
  }
  if (error.message === 'RHEA Swap build does not match its quote') {
    return 'Swap transaction details differ from the quote. Get a new quote.'
  }
  if (error.message === 'RHEA Swap returned an invalid response') {
    return 'Swap provider returned an invalid quote. Try again.'
  }
  return (
    getSwapQuoteFailureMessage(error) ??
    classifyError(new Error(readSwapErrorReason(error.message))).userMessage
  )
}

export function getRheaSwapQuoteFailure(error: unknown): {
  message: string
  retryable: boolean
} {
  const specific = getSwapQuoteFailureMessage(error)
  return {
    message: isSwapQuoteTimeout(error) ? SWAP_QUOTE_DISPLAY_ERROR : getRheaSwapErrorMessage(error),
    retryable:
      isSwapQuoteTimeout(error) ||
      specific === 'Quote unavailable. Please try again.' ||
      (!specific && classifyError(error).retryable)
  }
}

interface RuntimeMessenger {
  (message: Readonly<Record<string, unknown>>): Promise<unknown>
}

const MAXIMUM_TOKEN_CATALOG_ENTRIES = RHEA_SWAP_CHAIN_CATALOG.length * 2

function tokenCatalogKey(input: {
  readonly direction: 'from' | 'cross-chain-to'
  readonly tokenListChainIds: readonly number[]
}): string {
  return JSON.stringify([
    input.direction,
    [...input.tokenListChainIds].sort((left, right) => left - right)
  ])
}

function unwrap<T>(value: unknown, parse: (input: unknown) => T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RheaSwapClientError('RHEA Swap returned an invalid response')
  }
  const response = value as Record<string, unknown>
  if (typeof response.error === 'string') throw new RheaSwapClientError(response.error)
  if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
    throw new RheaSwapClientError('RHEA Swap returned an invalid response')
  }
  try {
    return parse(response.result)
  } catch {
    throw new RheaSwapClientError('RHEA Swap returned an invalid response')
  }
}

export function createRheaSwapClient(
  send: RuntimeMessenger,
  options: { readonly now?: () => number } = {}
) {
  const now = options.now ?? Date.now
  const tokenCatalog = new Map<
    string,
    Readonly<{ value: RheaSwapCatalogResult; expiresAt: number }>
  >()
  const tokenCatalogRequests = new Map<string, Promise<RheaSwapCatalogResult>>()
  const readCachedTokens = (input: {
    readonly direction: 'from' | 'cross-chain-to'
    readonly tokenListChainIds: readonly number[]
  }): RheaSwapCatalogResult | null => {
    const key = tokenCatalogKey(input)
    const cached = tokenCatalog.get(key)
    if (!cached || cached.expiresAt <= now()) {
      tokenCatalog.delete(key)
      return null
    }
    return cached.value
  }
  const listTokens = async (
    input: {
      readonly direction: 'from' | 'cross-chain-to'
      readonly tokenListChainIds: readonly number[]
    },
    options: { readonly bypassCache?: boolean } = {}
  ): Promise<RheaSwapCatalogResult> => {
    const key = tokenCatalogKey(input)
    const cached = options.bypassCache ? null : readCachedTokens(input)
    if (cached) return cached
    tokenCatalog.delete(key)
    const inFlight = tokenCatalogRequests.get(key)
    if (inFlight) return inFlight
    const request = unwrap(
      await send({
        type: 'GET_RHEA_SWAP_TOKENS',
        direction: input.direction,
        tokenListChainIds: [...input.tokenListChainIds]
      }),
      parseRheaSwapCatalogResult
    )
    if (request.tokens.length > 0 && request.failedChainIds.length === 0) {
      tokenCatalog.delete(key)
      tokenCatalog.set(
        key,
        Object.freeze({ value: request, expiresAt: now() + RHEA_SWAP_TOKEN_CATALOG_TTL_MS })
      )
      while (tokenCatalog.size > MAXIMUM_TOKEN_CATALOG_ENTRIES) {
        const oldest = tokenCatalog.keys().next().value
        if (oldest === undefined) break
        tokenCatalog.delete(oldest)
      }
    }
    return request
  }

  const getTokens = (
    input: {
      readonly direction: 'from' | 'cross-chain-to'
      readonly tokenListChainIds: readonly number[]
    },
    options: { readonly bypassCache?: boolean } = {}
  ): Promise<RheaSwapCatalogResult> => {
    const key = tokenCatalogKey(input)
    const existing = tokenCatalogRequests.get(key)
    if (existing) return existing
    const request = listTokens(input, options).finally(() => tokenCatalogRequests.delete(key))
    tokenCatalogRequests.set(key, request)
    return request
  }

  return Object.freeze({
    readCachedTokens,
    listTokens: (
      input: {
        readonly direction: 'from' | 'cross-chain-to'
        readonly tokenListChainIds: readonly number[]
      },
      options?: { readonly bypassCache?: boolean }
    ): Promise<RheaSwapCatalogResult> => getTokens(input, options),
    quote: async (
      requestValue: RheaSwapQuoteRequest,
      purpose?:
        | 'wallet-swap'
        | 'public-cross-chain-send'
        | 'confidential-funding'
        | 'private-swap'
        | 'private-transfer'
        | 'private-cross-chain-send'
        | 'public-private-send',
      zcashFundingSource?: 'transparent' | 'shielded'
    ): Promise<RheaSwapQuoteView> => {
      const request = parseRheaSwapQuoteRequest(requestValue)
      return unwrap(
        await send({
          type: 'QUOTE_RHEA_SWAP',
          request,
          ...(purpose ? { purpose } : {}),
          ...(zcashFundingSource ? { zcashFundingSource } : {})
        }),
        parseRheaSwapQuoteView
      )
    },
    selectRoute: async (quoteHandle: string, routeIndex: number): Promise<RheaSwapQuoteView> =>
      unwrap(
        await send({ type: 'SELECT_RHEA_SWAP_ROUTE', quoteHandle, routeIndex }),
        parseRheaSwapQuoteView
      ),
    prepare: async (quoteHandle: string): Promise<RheaSwapReviewView> =>
      unwrap(await send({ type: 'PREPARE_RHEA_SWAP', quoteHandle }), parseRheaSwapReviewView),
    getEvmTransactionPlan: async (quoteHandle: string): Promise<RheaSwapEvmTransactionPlan> =>
      unwrap(
        await send({ type: 'GET_RHEA_SWAP_EVM_PLAN', quoteHandle }),
        parseRheaSwapEvmTransactionPlan
      ),
    getEvmSignaturePlan: async (quoteHandle: string): Promise<RheaSwapEvmSignaturePlan> =>
      unwrap(
        await send({ type: 'GET_RHEA_SWAP_EVM_SIGNATURE_PLAN', quoteHandle }),
        parseRheaSwapEvmSignaturePlan
      ),
    prepareEvmSignature: async (
      quoteHandle: string,
      binding: RheaSwapTransactionBinding,
      executionMode: 'main' | 'private' = 'main'
    ): Promise<RheaSwapEvmSignatureReview> =>
      unwrap(
        await send({
          type: 'PREPARE_RHEA_SWAP_EVM_SIGNATURE',
          quoteHandle,
          binding,
          executionMode
        }),
        parseRheaSwapEvmSignatureReview
      ),
    confirmEvmSignature: async (
      quoteHandle: string,
      payloadFingerprint: string
    ): Promise<RheaSwapSignedOrderResult> =>
      unwrap(
        await send({
          type: 'CONFIRM_RHEA_SWAP_EVM_SIGNATURE',
          quoteHandle,
          payloadFingerprint
        }),
        parseRheaSwapSignedOrderResult
      ),
    cancelEvmSignature: async (quoteHandle: string): Promise<void> => {
      const response = await send({ type: 'CANCEL_RHEA_SWAP_EVM_SIGNATURE', quoteHandle })
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        Reflect.get(response, 'success') !== true
      ) {
        throw new RheaSwapClientError('RHEA Swap signature could not be cancelled')
      }
    },
    prepareSolanaTransaction: async (
      quoteHandle: string,
      binding: RheaSwapTransactionBinding
    ): Promise<RheaSwapSolanaTransactionReview> =>
      unwrap(
        await send({ type: 'PREPARE_RHEA_SWAP_SOLANA', quoteHandle, binding }),
        parseRheaSwapSolanaTransactionReview
      ),
    confirmSolanaTransaction: async (
      quoteHandle: string,
      payloadFingerprint: string
    ): Promise<RheaSwapSignedOrderResult> =>
      unwrap(
        await send({ type: 'CONFIRM_RHEA_SWAP_SOLANA', quoteHandle, payloadFingerprint }),
        parseRheaSwapSignedOrderResult
      ),
    cancelSolanaTransaction: async (quoteHandle: string): Promise<void> => {
      const response = await send({ type: 'CANCEL_RHEA_SWAP_SOLANA', quoteHandle })
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        Reflect.get(response, 'success') !== true
      ) {
        throw new RheaSwapClientError('RHEA Swap Solana transaction could not be cancelled')
      }
    },
    prepareNearTransactionBatch: async (
      quoteHandle: string,
      binding: RheaSwapTransactionBinding
    ): Promise<RheaSwapNearTransactionBatchReview> =>
      unwrap(
        await send({ type: 'PREPARE_RHEA_SWAP_NEAR', quoteHandle, binding }),
        parseRheaSwapNearTransactionBatchReview
      ),
    confirmNearTransactionBatch: async (
      quoteHandle: string,
      payloadFingerprint: string
    ): Promise<RheaSwapSignedOrderResult> =>
      unwrap(
        await send({ type: 'CONFIRM_RHEA_SWAP_NEAR', quoteHandle, payloadFingerprint }),
        parseRheaSwapSignedOrderResult
      ),
    cancelNearTransactionBatch: async (quoteHandle: string): Promise<void> => {
      const response = await send({ type: 'CANCEL_RHEA_SWAP_NEAR', quoteHandle })
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        Reflect.get(response, 'success') !== true
      ) {
        throw new RheaSwapClientError('RHEA Swap NEAR transaction batch could not be cancelled')
      }
    },
    recordTransactionSubmission: async (
      quoteHandle: string,
      sourceHash: string
    ): Promise<RheaSwapSubmissionView> =>
      unwrap(
        await send({ type: 'RECORD_RHEA_SWAP_SUBMISSION', quoteHandle, sourceHash }),
        parseRheaSwapSubmissionView
      ),
    reportSubmission: async (quoteHandle: string): Promise<RheaSwapSubmissionView> =>
      unwrap(
        await send({ type: 'REPORT_RHEA_SWAP_SUBMISSION', quoteHandle }),
        parseRheaSwapSubmissionView
      ),
    getOrderStatus: async (quoteHandle: string): Promise<RheaSwapOrderStatusView> =>
      unwrap(
        await send({ type: 'GET_RHEA_SWAP_ORDER_STATUS', quoteHandle }),
        parseRheaSwapOrderStatusView
      ),
    startMonitoring: async (transaction: {
      readonly quoteHandle: string
      readonly accountKey: string
      readonly walletId: string
      readonly accountId: string
      readonly transactionId: string
      readonly isCrossChain: boolean
      readonly destinationAsset?: string
      readonly destinationChain?: string
    }): Promise<void> => {
      const response = await send({ type: 'START_RHEA_SWAP_MONITOR', transaction })
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        Reflect.get(response, 'success') !== true
      ) {
        throw new RheaSwapClientError('RHEA Swap monitoring could not be started')
      }
    },
    discard: async (quoteHandle: string): Promise<void> => {
      const response = await send({ type: 'DISCARD_RHEA_SWAP', quoteHandle })
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        Reflect.get(response, 'success') !== true
      ) {
        throw new RheaSwapClientError('RHEA Swap quote could not be discarded')
      }
    }
  })
}

export const rheaSwapClient = createRheaSwapClient(message => chrome.runtime.sendMessage(message))
