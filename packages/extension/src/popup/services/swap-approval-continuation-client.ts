import type {
  SwapApprovalContinuation,
  SwapApprovalContinuationInput
} from '@/background/swap-approval-continuation'

async function request<T>(type: string, fields: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type, ...fields })
  if (!response || typeof response !== 'object') throw new Error('Swap continuation is unavailable')
  if (typeof response.error === 'string') throw new Error(response.error)
  return response.result as T
}

export const swapApprovalContinuationClient = {
  save: (input: SwapApprovalContinuationInput) =>
    request<SwapApprovalContinuation>('SAVE_SWAP_APPROVAL_CONTINUATION', { input }),
  get: (transactionId: string) =>
    request<SwapApprovalContinuation | null>('GET_SWAP_APPROVAL_CONTINUATION', { transactionId }),
  continue: (transactionId: string) =>
    request<SwapApprovalContinuation>('CONTINUE_SWAP_AFTER_APPROVAL', { transactionId }),
  clear: (transactionId: string) =>
    request<void>('CLEAR_SWAP_APPROVAL_CONTINUATION', { transactionId })
}
