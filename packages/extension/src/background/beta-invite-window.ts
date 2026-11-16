import { BETA_INVITE_ACTIVATION_STORAGE_KEY } from '@/config/beta-invite'
import { UI_CONFIG } from '@/config/extension'
import { DedupPromise } from '@/lib/async-utils'
import { betaInviteActivation } from './beta-invite'
import { closeAllPopupWindows } from './window-manager'

const activationWindow = new DedupPromise<void>()

/** Resume the original dApp request only after activation is durably recorded. */
export function promptBetaInviteActivation(): Promise<void> {
  return activationWindow.run(async () => {
    if (await betaInviteActivation.isActivated()) return
    await closeAllPopupWindows()
    const { WIDTH: width, HEIGHT: height } = UI_CONFIG.DAPP_WINDOW

    await new Promise<void>((resolve, reject) => {
      let windowId: number | undefined
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        chrome.storage.onChanged.removeListener(onStorageChanged)
        chrome.windows.onRemoved.removeListener(onWindowRemoved)
        const close =
          windowId === undefined
            ? Promise.resolve()
            : chrome.windows.remove(windowId).catch(() => {})
        void close.then(() => (error ? reject(error) : resolve()))
      }
      const inspectActivation = async (closed = false) => {
        try {
          if (await betaInviteActivation.isActivated()) finish()
          else if (closed) finish(new Error('Beta activation was cancelled.'))
        } catch {
          finish(new Error('Beta activation is unavailable. Please try again.'))
        }
      }
      const onStorageChanged = (
        changes: Record<string, chrome.storage.StorageChange>,
        area: string
      ) => {
        if (area === 'local' && changes[BETA_INVITE_ACTIVATION_STORAGE_KEY]) {
          void inspectActivation()
        }
      }
      const onWindowRemoved = (removedId: number) => {
        if (removedId === windowId) void inspectActivation(true)
      }
      const timer = setTimeout(() => finish(new Error('Beta activation timed out.')), 300_000)
      chrome.storage.onChanged.addListener(onStorageChanged)
      chrome.windows.onRemoved.addListener(onWindowRemoved)
      void chrome.windows
        .create({
          url: chrome.runtime.getURL('index.html#/onboarding?from=dapp'),
          type: 'popup',
          width,
          height,
          focused: true
        })
        .then(created => {
          if (typeof created.id !== 'number') {
            finish(new Error('Beta activation window is unavailable.'))
            return
          }
          windowId = created.id
          if (settled) {
            void chrome.windows.remove(windowId).catch(() => {})
            return
          }
          void inspectActivation()
        })
        .catch(() => finish(new Error('Beta activation window is unavailable.')))
    })
  })
}
