import { TimeoutError } from '@/lib/async-utils'
import { getResponseErrorMessage } from '@/lib/errors'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'

export function waitForZcashTxCompleted(
  accountKey: string,
  transactionId: string,
  timeoutMs: number,
  dispatch: () => Promise<unknown>
): Promise<{ txHash: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { txHash: string } | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(listener)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const listener = (
      message: {
        type?: string
        accountKey?: string
        transactionId?: string
        txHash?: string
        error?: string
        completionPending?: boolean
      },
      sender: chrome.runtime.MessageSender
    ) => {
      if (
        getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker' ||
        message.type !== 'ZCASH_TX_COMPLETED' ||
        message.accountKey !== accountKey ||
        message.transactionId !== transactionId
      )
        return

      if (message.error) {
        finish(
          message.completionPending ? new TimeoutError(message.error) : new Error(message.error)
        )
      } else if (message.txHash) {
        finish({ txHash: message.txHash })
      } else {
        finish(new Error('Transaction completed without tx hash'))
      }
    }
    const timer = setTimeout(() => finish(new TimeoutError('Transaction timed out')), timeoutMs)
    chrome.runtime.onMessage.addListener(listener)
    void Promise.resolve()
      .then(dispatch)
      .then(response => {
        if (
          !response ||
          typeof response !== 'object' ||
          !('success' in response) ||
          response.success !== true
        ) {
          finish(new Error(getResponseErrorMessage(response) ?? 'Failed to start transaction'))
        }
      })
      .catch(error =>
        finish(error instanceof Error ? error : new Error('Failed to start transaction'))
      )
  })
}
