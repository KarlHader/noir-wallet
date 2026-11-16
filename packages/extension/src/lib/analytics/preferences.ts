// Keep the persisted key for existing installations; it now controls only GA.
export const GOOGLE_ANALYTICS_STORAGE_KEY = 'anonymous_analytics_enabled'
export const DEFAULT_GOOGLE_ANALYTICS_ENABLED = true

type GoogleAnalyticsPreferenceListener = (enabled: boolean) => void

const listeners = new Set<GoogleAnalyticsPreferenceListener>()
let cachedEnabled: boolean | undefined
let loadPromise: Promise<boolean> | null = null
let storageListenerRegistered = false
let preferenceRevision = 0

function ensureStorageListener(): void {
  if (storageListenerRegistered || typeof chrome === 'undefined' || !chrome.storage?.onChanged)
    return
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    const change = changes[GOOGLE_ANALYTICS_STORAGE_KEY]
    if (!change) return
    updateCachedPreference(parseStoredPreference(change.newValue))
  })
  storageListenerRegistered = true
}

function parseStoredPreference(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_GOOGLE_ANALYTICS_ENABLED
}

function updateCachedPreference(enabled: boolean): void {
  preferenceRevision++
  if (cachedEnabled === enabled) return
  cachedEnabled = enabled
  for (const listener of listeners) {
    listener(enabled)
  }
}

export async function isGoogleAnalyticsEnabled(): Promise<boolean> {
  ensureStorageListener()
  if (cachedEnabled !== undefined) return cachedEnabled
  if (loadPromise) return loadPromise

  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return DEFAULT_GOOGLE_ANALYTICS_ENABLED
  }

  loadPromise = chrome.storage.local
    .get(GOOGLE_ANALYTICS_STORAGE_KEY)
    .then(result => {
      if (cachedEnabled !== undefined) return cachedEnabled
      const enabled = parseStoredPreference(result[GOOGLE_ANALYTICS_STORAGE_KEY])
      updateCachedPreference(enabled)
      return enabled
    })
    .catch(() => cachedEnabled ?? DEFAULT_GOOGLE_ANALYTICS_ENABLED)
    .finally(() => {
      loadPromise = null
    })

  return loadPromise
}

export async function setGoogleAnalyticsEnabled(enabled: boolean): Promise<void> {
  ensureStorageListener()
  const previous = cachedEnabled
  updateCachedPreference(enabled)
  const setRevision = preferenceRevision

  try {
    await chrome.storage.local.set({ [GOOGLE_ANALYTICS_STORAGE_KEY]: enabled })
  } catch (error) {
    if (preferenceRevision === setRevision) {
      if (previous === undefined) {
        preferenceRevision++
        cachedEnabled = undefined
      } else {
        updateCachedPreference(previous)
      }
    }
    throw error
  }
}

export function onGoogleAnalyticsPreferenceChange(
  listener: GoogleAnalyticsPreferenceListener
): () => void {
  ensureStorageListener()
  listeners.add(listener)
  return () => listeners.delete(listener)
}
