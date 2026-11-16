import type { Transaction } from '@/types/wallet'
import type { TransactionStep } from '@/popup/hooks/useTransaction'

export function resolveZcashResultView(
  result: { step: TransactionStep; txHash?: string; timestamp?: number },
  record?: Transaction
): { step: TransactionStep; txHash?: string; timestamp?: number } {
  let step = result.step
  if (record?.status === 'success' || record?.status === 'failed') step = record.status
  else if (record?.status === 'confirming') step = 'confirming'
  else if (record?.txHash && (step === 'idle' || step === 'pending')) step = 'submitted'
  return {
    step,
    txHash: record?.txHash || result.txHash,
    timestamp: record?.timestamp ?? result.timestamp
  }
}
