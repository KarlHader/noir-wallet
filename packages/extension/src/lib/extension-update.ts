export const EXTENSION_UPDATE_STORAGE_KEY = 'extension_update_notice'
export const PRODUCT_RELEASE_NOTES_URL = 'https://www.zknoir.com/changelog.json'

const RELEASE_NOTES_SCHEMA_VERSION = 1
const RELEASE_NOTES_TIMEOUT_MS = 5_000
const RELEASE_NOTES_MAX_BYTES = 64 * 1024
const RELEASE_NOTES_MAX_CHANGES = 8
const RELEASE_NOTES_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'releases'])
const RELEASE_NOTES_ENTRY_KEYS = new Set(['changes', 'notifyUpdate'])

export interface ProductReleaseNotes {
  version: string
  changes: string[]
}

interface ProductRelease extends ProductReleaseNotes {
  notifyUpdate: boolean
}

interface ExtensionUpdateBase {
  version: string
  detectedAt: number
}

export interface AvailableExtensionUpdate extends ExtensionUpdateBase {
  status: 'available'
}

interface DetectedExtensionUpdate extends ExtensionUpdateBase {
  status: 'detected'
}

export type ExtensionUpdateState = AvailableExtensionUpdate | DetectedExtensionUpdate

function isVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d+(?:\.\d+){0,3}$/.test(value) &&
    value.split('.').every(part => Number.isSafeInteger(Number(part)))
  )
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string
): void {
  const unknownKeys = Object.keys(value).filter(key => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`${path} contains unknown fields: ${unknownKeys.join(', ')}`)
  }
}

function parseReleaseNotesEntry(value: unknown, version: string): ProductRelease {
  assertRecord(value, `release notes for ${version}`)
  assertKnownKeys(value, RELEASE_NOTES_ENTRY_KEYS, `release notes for ${version}`)

  if (!Array.isArray(value.changes) || value.changes.length < 1) {
    throw new Error(`release notes for ${version}.changes must contain at least one item`)
  }
  if (value.changes.length > RELEASE_NOTES_MAX_CHANGES) {
    throw new Error(
      `release notes for ${version}.changes must contain at most ${RELEASE_NOTES_MAX_CHANGES} items`
    )
  }

  const changes = value.changes.map((change, index) => {
    const path = `release notes for ${version}.changes[${index}]`
    if (typeof change !== 'string' || change.trim().length === 0) {
      throw new Error(`${path} must be a non-empty string`)
    }
    if (change.length > 120) {
      throw new Error(`${path} must be at most 120 characters`)
    }
    return change.trim()
  })

  if (value.notifyUpdate !== undefined && typeof value.notifyUpdate !== 'boolean') {
    throw new Error(`release notes for ${version}.notifyUpdate must be a boolean`)
  }

  return { version, changes, notifyUpdate: value.notifyUpdate === true }
}

function parseReleaseNotesManifest(value: unknown): Record<string, unknown> {
  assertRecord(value, 'release notes manifest')
  assertKnownKeys(value, RELEASE_NOTES_TOP_LEVEL_KEYS, 'release notes manifest')
  if (value.schemaVersion !== RELEASE_NOTES_SCHEMA_VERSION) {
    throw new Error(`release notes manifest.schemaVersion must be ${RELEASE_NOTES_SCHEMA_VERSION}`)
  }

  assertRecord(value.releases, 'release notes manifest.releases')
  return value.releases
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }

  return 0
}

export function parseProductReleaseNotesManifest(
  value: unknown,
  expectedVersion: string
): ProductReleaseNotes {
  if (!isVersion(expectedVersion)) {
    throw new Error(`Invalid extension version: ${expectedVersion}`)
  }

  const releases = parseReleaseNotesManifest(value)
  const entry = releases[expectedVersion]
  if (entry === undefined) {
    throw new Error(`release notes for version ${expectedVersion} were not found`)
  }

  const release = parseReleaseNotesEntry(entry, expectedVersion)
  return { version: release.version, changes: release.changes }
}

export function shouldNotifyExtensionUpdate(
  value: unknown,
  currentVersion: string,
  availableVersion: string
): boolean {
  if (!isVersion(currentVersion)) {
    throw new Error(`Invalid current extension version: ${currentVersion}`)
  }
  if (!isVersion(availableVersion)) {
    throw new Error(`Invalid available extension version: ${availableVersion}`)
  }
  if (compareVersions(currentVersion, availableVersion) >= 0) return false

  const releases = parseReleaseNotesManifest(value)
  let shouldNotify = false

  for (const [version, entry] of Object.entries(releases)) {
    if (!isVersion(version)) {
      throw new Error(`Invalid release notes version: ${version}`)
    }
    if (
      compareVersions(version, currentVersion) <= 0 ||
      compareVersions(version, availableVersion) > 0
    ) {
      continue
    }

    if (parseReleaseNotesEntry(entry, version).notifyUpdate) {
      shouldNotify = true
    }
  }

  return shouldNotify
}

async function fetchProductReleaseNotesManifest(): Promise<unknown> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), RELEASE_NOTES_TIMEOUT_MS)

  try {
    const response = await fetch(PRODUCT_RELEASE_NOTES_URL, {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`release notes request failed with status ${response.status}`)
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > RELEASE_NOTES_MAX_BYTES) {
      throw new Error('release notes response is too large')
    }

    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > RELEASE_NOTES_MAX_BYTES) {
      throw new Error('release notes response is too large')
    }

    return JSON.parse(body) as unknown
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

export async function fetchShouldNotifyExtensionUpdate(
  currentVersion: string,
  availableVersion: string
): Promise<boolean> {
  const manifest = await fetchProductReleaseNotesManifest()
  return shouldNotifyExtensionUpdate(manifest, currentVersion, availableVersion)
}

export function isExtensionUpdateState(value: unknown): value is ExtensionUpdateState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const state = value as Record<string, unknown>
  if (!isVersion(state.version)) return false
  if (
    typeof state.detectedAt !== 'number' ||
    !Number.isFinite(state.detectedAt) ||
    state.detectedAt <= 0
  ) {
    return false
  }

  return state.status === 'available' || state.status === 'detected'
}

export async function readExtensionUpdateState(): Promise<ExtensionUpdateState | null> {
  const stored = await chrome.storage.local.get(EXTENSION_UPDATE_STORAGE_KEY)
  const value = stored[EXTENSION_UPDATE_STORAGE_KEY]
  return isExtensionUpdateState(value) ? value : null
}

export async function writeExtensionUpdateState(state: ExtensionUpdateState): Promise<void> {
  await chrome.storage.local.set({ [EXTENSION_UPDATE_STORAGE_KEY]: state })
}

export async function clearExtensionUpdateState(): Promise<void> {
  await chrome.storage.local.remove(EXTENSION_UPDATE_STORAGE_KEY)
}
