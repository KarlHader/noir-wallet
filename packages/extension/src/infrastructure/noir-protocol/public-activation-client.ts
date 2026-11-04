import {
  assertPublicActivationQuoteRequest,
  assertPublicDryActivationQuote,
  increasePublicActivationQuoteRequest,
  parsePublicActivationQuote,
  parsePublicBridgeMinimum,
  type NoirPublicActivationQuote,
  type NoirPublicActivationQuoteRequest
} from '@/core/services/noir-protocol/public/activation-quote'
import type { NoirPublicNetworkConfig } from '@/core/services/noir-protocol/public/config'
import { FetchHttpError, fetchWithTimeout } from '@/lib/fetch-utils'

async function requestQuote(
  request: NoirPublicActivationQuoteRequest,
  config: NoirPublicNetworkConfig,
  dry: boolean,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetchWithTimeout(`${config.oneClickBaseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, dry }),
    timeoutMs: 20_000,
    maxBytes: 1024 * 1024,
    signal
  })
  return response.json() as Promise<unknown>
}

export async function getPublicActivationQuote(
  request: NoirPublicActivationQuoteRequest,
  config: NoirPublicNetworkConfig,
  signal?: AbortSignal
): Promise<NoirPublicActivationQuote> {
  assertPublicActivationQuoteRequest(request, config)
  let current = request
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      assertPublicDryActivationQuote(await requestQuote(current, config, true, signal), current)
      return parsePublicActivationQuote(await requestQuote(current, config, false, signal), current)
    } catch (error) {
      const minimum =
        error instanceof FetchHttpError ? parsePublicBridgeMinimum(error.detail) : null
      if (!minimum) throw error
      if (attempt === 3)
        throw new Error('Public bridge minimum kept changing. Request a new quote.')
      current = increasePublicActivationQuoteRequest(current, minimum)
    }
  }
  throw new Error('Unable to obtain Public activation quote')
}
