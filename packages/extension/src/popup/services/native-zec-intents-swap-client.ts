import type {
  NativeZecIntentsSwapReview,
  PrepareNativeZecIntentsSwapInput
} from '@/core/services/native-zec-intents-swap'
import type { SwapStatus } from '@/core/services/intents-api'

async function request<T>(message: object): Promise<T> {
  const response: unknown = await chrome.runtime.sendMessage(message)
  if (!response || typeof response !== 'object') throw new Error('Intents Swap is unavailable')
  const envelope = response as { result?: T; error?: string }
  if (envelope.error) throw new Error(envelope.error)
  if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
    throw new Error('Intents Swap response is invalid')
  }
  return envelope.result as T
}

export function prepareNativeZecIntentsSwap(
  input: PrepareNativeZecIntentsSwapInput
): Promise<NativeZecIntentsSwapReview> {
  return request({ type: 'PREPARE_NATIVE_ZEC_INTENTS_SWAP', request: input })
}

export function getNativeZecIntentsSwap(quoteId: string): Promise<NativeZecIntentsSwapReview> {
  return request({ type: 'GET_NATIVE_ZEC_INTENTS_SWAP', quoteId })
}

export function getNativeZecIntentsSwapStatus(quoteId: string): Promise<SwapStatus | null> {
  return request({ type: 'GET_NATIVE_ZEC_INTENTS_SWAP_STATUS', quoteId })
}

export function cancelNativeZecIntentsSwap(quoteId: string): Promise<boolean> {
  return request({ type: 'CANCEL_NATIVE_ZEC_INTENTS_SWAP', quoteId })
}

export type { NativeZecIntentsSwapReview, PrepareNativeZecIntentsSwapInput }
