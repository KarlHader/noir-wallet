import type { CombinedEvmSwapInput, CombinedEvmSwapProgress } from '@/background/combined-evm-swap'
import type {
  SwapApprovalContinuation,
  SwapApprovalContinuationInput,
  SwapApprovalContinuationResult
} from '@/background/swap-approval-continuation'

async function request<T>(type: string, fields: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type, ...fields })
  if (!response || typeof response !== 'object') throw new Error('Swap continuation is unavailable')
  if (typeof response.error === 'string') throw new Error(response.error)
  return response.result as T
}

export const swapApprovalContinuationClient = {
  startCombined: (input: CombinedEvmSwapInput) =>
    request<CombinedEvmSwapProgress>('START_COMBINED_EVM_SWAP', { input }),
  getCombined: (transactionId: string) =>
    request<CombinedEvmSwapProgress | null>('GET_COMBINED_EVM_SWAP', { transactionId }),
  save: (input: SwapApprovalContinuationInput) =>
    request<SwapApprovalContinuation>('SAVE_SWAP_APPROVAL_CONTINUATION', { input }),
  get: (transactionId: string) =>
    request<SwapApprovalContinuation | null>('GET_SWAP_APPROVAL_CONTINUATION', { transactionId }),
  continue: (transactionId: string) =>
    request<SwapApprovalContinuationResult>('CONTINUE_SWAP_AFTER_APPROVAL', { transactionId }),
  clear: (transactionId: string) =>
    request<void>('CLEAR_SWAP_APPROVAL_CONTINUATION', { transactionId })
}
