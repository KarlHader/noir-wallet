import {
  clearExtensionUpdateState,
  compareVersions,
  fetchShouldNotifyExtensionUpdate,
  isExtensionUpdateState,
  readExtensionUpdateState,
  writeExtensionUpdateState,
  type ExtensionUpdateState
} from '@/lib/extension-update'
import { DedupPromise } from '@/lib/async-utils'
import { logger } from '@/lib/logger'

const refreshOperation = new DedupPromise<void>()
let updateQueue = Promise.resolve()

// Keep detection, remote checks, and installation cleanup in order so an older
// response cannot overwrite a newer pending version or restore an installed one.
function enqueueUpdate(operation: () => Promise<void>): Promise<void> {
  const task = updateQueue.then(operation).catch(error => {
    logger.warn('[Update] Failed to refresh update notice', undefined, undefined, error)
    throw error
  })
  updateQueue = task.catch(() => {})
  return task
}

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
  if (state.status === status) return

  await writeExtensionUpdateState({ ...state, status })
  if (shouldNotify) {
    logger.info('[Update] Update reminder enabled')
  }
}

export function refreshExtensionUpdateNotice(): Promise<void> {
  return refreshOperation.run(() => enqueueUpdate(reconcileUpdateNotice))
}

async function handleUpdateAvailable(version: string): Promise<void> {
  const candidate: ExtensionUpdateState = { status: 'detected', version, detectedAt: Date.now() }
  if (!isExtensionUpdateState(candidate)) throw new Error('Invalid available extension update')

  await clearInstalledUpdate()
  const state = await readExtensionUpdateState()
  if (compareVersions(version, chrome.runtime.getManifest().version) <= 0) return

  if (!state || compareVersions(version, state.version) > 0) {
    // Persist the pending version even when notifications are off or the
    // manifest request fails. A later wallet opening can retry the decision.
    await writeExtensionUpdateState({ ...candidate, status: state?.status ?? 'detected' })
    logger.info('[Update] Pending extension update recorded')
  }

  await reconcileUpdateNotice()
}

function handleInstalled(details: chrome.runtime.InstalledDetails): void {
  if (details.reason !== 'install' && details.reason !== 'update') {
    return
  }
  void enqueueUpdate(clearInstalledUpdate).catch(() => {})
}

export function initializeExtensionUpdates(): void {
  chrome.runtime.onUpdateAvailable.addListener(details => {
    void enqueueUpdate(() => handleUpdateAvailable(details.version)).catch(() => {})
  })

  chrome.runtime.onInstalled.addListener(handleInstalled)
  chrome.runtime.onStartup.addListener(() => {
    void refreshExtensionUpdateNotice().catch(() => {})
  })
}
