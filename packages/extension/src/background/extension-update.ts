import {
  clearExtensionUpdateState,
  compareVersions,
  fetchShouldNotifyExtensionUpdate,
  isExtensionUpdateState,
  readExtensionUpdateState,
  writeExtensionUpdateState,
  type ExtensionUpdateState
} from '@/lib/extension-update'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import { logger } from '@/lib/logger'

const updateQueue = new SerialTaskQueue()
const refreshOperation = new DedupPromise<void>()

async function clearInstalledUpdate(): Promise<void> {
  const state = await readExtensionUpdateState()
  if (state && compareVersions(state.version, chrome.runtime.getManifest().version) <= 0) {
    await clearExtensionUpdateState()
  }
}

async function reconcileUpdateNotice(): Promise<void> {
  await clearInstalledUpdate()
  const state = await readExtensionUpdateState()
  if (!state) return

  const shouldNotify = await fetchShouldNotifyExtensionUpdate(
    chrome.runtime.getManifest().version,
    state.version
  )
  const status = shouldNotify ? 'available' : 'detected'
  if (state.status !== status) {
    await writeExtensionUpdateState({ ...state, status })
  }
}

export function refreshExtensionUpdateNotice(): Promise<void> {
  return refreshOperation.run(() => updateQueue.run(reconcileUpdateNotice))
}

async function handleUpdateAvailable(version: string): Promise<void> {
  const candidate: ExtensionUpdateState = { status: 'detected', version, detectedAt: Date.now() }
  if (!isExtensionUpdateState(candidate)) throw new Error('Invalid available extension update')

  await clearInstalledUpdate()
  const state = await readExtensionUpdateState()
  if (compareVersions(version, chrome.runtime.getManifest().version) <= 0) return

  if (!state || compareVersions(version, state.version) > 0) {
    // An existing verified milestone still applies while a newer version is checked.
    await writeExtensionUpdateState({ ...candidate, status: state?.status ?? 'detected' })
  }

  await reconcileUpdateNotice()
}

function handleInstalled(details: chrome.runtime.InstalledDetails): void {
  if (details.reason !== 'install' && details.reason !== 'update') return
  void updateQueue.run(clearInstalledUpdate).catch(() => {
    logger.warn('[Update] Failed to clear installed update notice')
  })
}

export function initializeExtensionUpdates(): void {
  chrome.runtime.onUpdateAvailable.addListener(details => {
    void updateQueue
      .run(() => handleUpdateAvailable(details.version))
      .catch(() => {
        logger.warn('[Update] Failed to refresh update notice')
      })
  })

  chrome.runtime.onInstalled.addListener(handleInstalled)
  chrome.runtime.onStartup.addListener(() => {
    void refreshExtensionUpdateNotice().catch(() => {
      logger.warn('[Update] Failed to refresh update notice on startup')
    })
  })
}
