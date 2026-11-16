import {
  hasExactRuntimeKeys,
  isRuntimeRecord,
  isTrustedExtensionSender
} from './runtime-message-security'

const offscreenAbortWallets = new Set<string>()

export function registerOffscreenSyncAbortListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      !isRuntimeRecord(message) ||
      (message.type !== 'SYNC_ABORT_WALLET' && message.type !== 'SYNC_CLEAR_ABORT')
    ) {
      return false
    }
    if (!isTrustedExtensionSender(sender, chrome.runtime.id)) {
      sendResponse({ error: 'Unauthorized sync control sender' })
      return true
    }
    if (
      !hasExactRuntimeKeys(message, ['type', 'walletId']) ||
      typeof message.walletId !== 'string' ||
      message.walletId.length === 0
    ) {
      sendResponse({ error: 'Invalid sync control message' })
      return true
    }

    if (message.type === 'SYNC_ABORT_WALLET') {
      offscreenAbortWallets.add(message.walletId)
      sendResponse({ success: true })
      return true
    }
    if (message.type === 'SYNC_CLEAR_ABORT') {
      offscreenAbortWallets.delete(message.walletId)
      sendResponse({ success: true })
      return true
    }
    return false
  })
}

export function isSyncAbortRequested(walletId: string): boolean {
  return offscreenAbortWallets.has(walletId)
}

export async function signalSyncAbort(walletId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'SYNC_ABORT_WALLET', walletId })
  } catch {
    /* offscreen may not be ready */
  }
}

export async function clearSyncAbort(walletId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'SYNC_CLEAR_ABORT', walletId })
  } catch {
    /* offscreen may not be ready */
  }
}

export class SyncAbortedError extends Error {
  constructor(walletId: string) {
    super(`Sync aborted for wallet ${walletId}`)
    this.name = 'SyncAbortedError'
  }
}
