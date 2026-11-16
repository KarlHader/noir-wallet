import { UI_CONFIG } from '@/config/extension'
import {
  EVM_WALLET_PREFERENCE_STORAGE_KEY,
  parseEvmWalletOptions,
  readEvmWalletPreference,
  type EvmWalletChoiceRequest
} from '@/lib/evm-wallet-preference'
import {
  getContentScriptSenderOrigin,
  isOwnExtensionRouteSender,
  isTrustedExtensionSender
} from '@/lib/runtime-message-security'

interface PendingChoice {
  readonly request: EvmWalletChoiceRequest
  readonly sourceTabId: number
  windowId?: number
  choiceTabId?: number
  finish(walletId: string | null, error?: string): void
}

const pendingChoices = new Map<string, PendingChoice>()

async function getSourceWindowPosition(windowId: number | undefined): Promise<{
  left?: number
  top?: number
}> {
  if (typeof windowId !== 'number' || !Number.isInteger(windowId) || windowId < 0) return {}
  try {
    const source = await chrome.windows.get(windowId)
    if (source.id !== windowId || (source.type !== 'normal' && source.type !== 'popup')) return {}
    const { left, top, width } = source
    return {
      left:
        typeof left === 'number' &&
        Number.isFinite(left) &&
        typeof width === 'number' &&
        Number.isFinite(width) &&
        width > 0
          ? left + width - UI_CONFIG.DAPP_WINDOW.WIDTH - 20
          : undefined,
      top: typeof top === 'number' && Number.isFinite(top) ? top + 100 : undefined
    }
  } catch {
    return {}
  }
}

export async function readStoredEvmWalletPreference() {
  const stored = await chrome.storage.local.get(EVM_WALLET_PREFERENCE_STORAGE_KEY)
  return readEvmWalletPreference(stored[EVM_WALLET_PREFERENCE_STORAGE_KEY])
}

async function requestWalletChoice(
  walletsValue: unknown,
  sender: chrome.runtime.MessageSender
): Promise<string> {
  const origin = getContentScriptSenderOrigin(sender, chrome.runtime.id)
  const sourceTabId = sender.tab?.id
  const sourceWindowId = sender.tab?.windowId
  if (!origin || sourceTabId === undefined) throw new Error('Unauthorized wallet choice request.')
  const wallets = parseEvmWalletOptions(walletsValue).map(wallet =>
    wallet.id === 'noir'
      ? { id: 'noir', name: 'Noir Wallet', icon: chrome.runtime.getURL('icons/icon128.png') }
      : wallet
  )
  if (wallets.length === 0) throw new Error('No other EVM wallet was found. Refresh and try again.')
  if (wallets.length === 1) return wallets[0].id
  if (
    pendingChoices.size >= 8 ||
    [...pendingChoices.values()].some(choice => choice.sourceTabId === sourceTabId)
  ) {
    throw new Error('A wallet selection is already open.')
  }

  const requestId = crypto.randomUUID()
  const request: EvmWalletChoiceRequest = { requestId, origin, wallets }
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (walletId: string | null, error?: string) => {
      if (settled) return
      settled = true
      pendingChoices.delete(requestId)
      clearTimeout(timer)
      chrome.windows.onRemoved.removeListener(onWindowRemoved)
      chrome.tabs.onRemoved.removeListener(onTabRemoved)
      chrome.tabs.onUpdated.removeListener(onTabUpdated)
      if (choice.windowId !== undefined) {
        void chrome.windows.remove(choice.windowId).catch(() => {})
      }
      if (walletId) resolve(walletId)
      else reject(new Error(error ?? 'Wallet selection was cancelled.'))
    }
    const choice: PendingChoice = { request, sourceTabId, finish }
    const onWindowRemoved = (windowId: number) => {
      if (windowId === choice.windowId) finish(null)
    }
    const onTabRemoved = (tabId: number) => {
      if (tabId === sourceTabId) finish(null)
    }
    const onTabUpdated = (tabId: number, change: chrome.tabs.TabChangeInfo) => {
      if (tabId === sourceTabId && (change.status === 'loading' || change.url !== undefined)) {
        finish(null, 'The website changed. Connect again.')
      }
    }
    const timer = setTimeout(() => finish(null, 'Wallet selection timed out.'), 120_000)
    pendingChoices.set(requestId, choice)
    chrome.windows.onRemoved.addListener(onWindowRemoved)
    chrome.tabs.onRemoved.addListener(onTabRemoved)
    chrome.tabs.onUpdated.addListener(onTabUpdated)
    void getSourceWindowPosition(sourceWindowId)
      .then(position => {
        if (settled) return null
        return chrome.windows.create({
          url: chrome.runtime.getURL(`index.html#/evm-wallet-choice?requestId=${requestId}`),
          type: 'popup',
          width: UI_CONFIG.DAPP_WINDOW.WIDTH,
          height: UI_CONFIG.DAPP_WINDOW.HEIGHT,
          ...position,
          focused: true
        })
      })
      .then(created => {
        if (!created) return
        choice.windowId = created.id
        choice.choiceTabId = created.tabs?.[0]?.id
        if (settled || created.id === undefined || choice.choiceTabId === undefined) {
          if (created.id !== undefined) void chrome.windows.remove(created.id).catch(() => {})
          finish(null, 'The wallet selection window could not open.')
        }
      })
      .catch(() => finish(null, 'The wallet selection window could not open.'))
  })
}

export function handleEvmWalletChoiceMessage(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): boolean {
  if (message.type === 'GET_EVM_WALLET_PREFERENCE') {
    if (
      !getContentScriptSenderOrigin(sender, chrome.runtime.id) &&
      !isTrustedExtensionSender(sender, chrome.runtime.id)
    ) {
      sendResponse({ error: 'Unauthorized wallet preference request.' })
      return true
    }
    void readStoredEvmWalletPreference().then(
      result => sendResponse({ result }),
      () => sendResponse({ error: 'Wallet preference could not be loaded.' })
    )
    return true
  }
  if (message.type === 'REQUEST_EVM_WALLET_CHOICE') {
    void requestWalletChoice(message.wallets, sender).then(
      result => sendResponse({ result }),
      error =>
        sendResponse({ error: error instanceof Error ? error.message : 'Wallet selection failed.' })
    )
    return true
  }
  if (message.type !== 'GET_EVM_WALLET_CHOICE' && message.type !== 'RESOLVE_EVM_WALLET_CHOICE') {
    return false
  }
  const choice =
    typeof message.requestId === 'string' ? pendingChoices.get(message.requestId) : undefined
  if (
    !choice ||
    choice.windowId === undefined ||
    choice.choiceTabId === undefined ||
    !isOwnExtensionRouteSender(sender, chrome.runtime.id, '/evm-wallet-choice', {
      windowId: choice.windowId,
      tabId: choice.choiceTabId
    })
  ) {
    sendResponse({ error: 'This wallet selection is no longer available.' })
    return true
  }
  if (message.type === 'GET_EVM_WALLET_CHOICE') {
    sendResponse({ result: choice.request })
    return true
  }
  if (
    message.walletId !== null &&
    !choice.request.wallets.some(wallet => wallet.id === message.walletId)
  ) {
    sendResponse({ error: 'Choose an available wallet.' })
    return true
  }
  sendResponse({ result: true })
  choice.finish(message.walletId as string | null)
  return true
}
