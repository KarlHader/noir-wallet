import { parseAssetId } from '@/core/chains/registry'
import type { Network } from '@/types'

const SNAPSHOT_VERSION = 2
const MAXIMUM_TOKEN_PREFERENCE_COUNT = 1_024

type TokenVisibilityPreferenceSource = 'default' | 'balance' | 'user' | 'legacy'

interface TokenVisibilityPreference {
  readonly assetId: string
  readonly visible: boolean
  readonly source: TokenVisibilityPreferenceSource
}

export function getTokenVisibilityStorageKey(network: Network): string {
  return `token_visibility_${network}_v1`
}

export function getLegacyEvmAssetVisibilityStorageKey(network: Network): string {
  return `evm_asset_visibility_${network}_v1`
}

function normalizeManagedTokenAssetId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid managed Token AssetId')
  const asset = parseAssetId(value)
  if (asset.id !== value) throw new Error('Managed Token AssetId is not canonical')
  return asset.id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseSnapshot(value: unknown): ReadonlyMap<string, TokenVisibilityPreference> {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== SNAPSHOT_VERSION) ||
    !Array.isArray(value.preferences)
  ) {
    throw new Error('Invalid Token visibility snapshot')
  }
  if (value.preferences.length > MAXIMUM_TOKEN_PREFERENCE_COUNT) {
    throw new Error('Too many Token visibility preferences')
  }
  const preferences = new Map<string, TokenVisibilityPreference>()
  for (const candidate of value.preferences) {
    const legacy = value.version === 1
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== (legacy ? 2 : 3) ||
      (!legacy &&
        candidate.source !== 'default' &&
        candidate.source !== 'balance' &&
        candidate.source !== 'user')
    ) {
      throw new Error('Invalid Token visibility preference')
    }
    const assetId = normalizeManagedTokenAssetId(candidate.assetId)
    if (typeof candidate.visible !== 'boolean' || preferences.has(assetId)) {
      throw new Error('Invalid Token visibility preference')
    }
    preferences.set(
      assetId,
      Object.freeze({
        assetId,
        visible: candidate.visible,
        source: legacy
          ? ('legacy' as const)
          : (candidate.source as Exclude<TokenVisibilityPreferenceSource, 'legacy'>)
      })
    )
  }
  return preferences
}

function parseLegacySnapshot(value: unknown): ReadonlyMap<string, TokenVisibilityPreference> {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.hiddenAssetIds)) {
    throw new Error('Invalid legacy EVM Token visibility snapshot')
  }
  const preferences = new Map<string, TokenVisibilityPreference>()
  for (const candidate of value.hiddenAssetIds) {
    const assetId = normalizeManagedTokenAssetId(candidate)
    const asset = parseAssetId(assetId)
    if (
      !asset.chainId.startsWith('eip155:') ||
      asset.namespace !== 'erc20' ||
      !/^0x[0-9a-f]{40}$/.test(asset.reference) ||
      /^0x0{40}$/.test(asset.reference) ||
      preferences.has(assetId)
    ) {
      throw new Error('Invalid legacy EVM Token visibility snapshot')
    }
    preferences.set(assetId, Object.freeze({ assetId, visible: false, source: 'user' as const }))
  }
  return preferences
}

export class ChromeTokenVisibilityRepository {
  private readonly storageKey: string
  private readonly legacyStorageKey: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(network: Network) {
    this.storageKey = getTokenVisibilityStorageKey(network)
    this.legacyStorageKey = getLegacyEvmAssetVisibilityStorageKey(network)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async readSnapshot(): Promise<Map<string, TokenVisibilityPreference>> {
    const stored = await chrome.storage.local.get([this.storageKey, this.legacyStorageKey])
    if (stored[this.storageKey] !== undefined) {
      return new Map(parseSnapshot(stored[this.storageKey]))
    }
    if (stored[this.legacyStorageKey] === undefined) return new Map()
    const migrated = new Map(parseLegacySnapshot(stored[this.legacyStorageKey]))
    await this.writeSnapshot(migrated)
    await chrome.storage.local.remove(this.legacyStorageKey)
    return migrated
  }

  private async writeSnapshot(
    preferences: ReadonlyMap<string, TokenVisibilityPreference>
  ): Promise<void> {
    if (preferences.size > MAXIMUM_TOKEN_PREFERENCE_COUNT) {
      throw new Error('Too many Token visibility preferences')
    }
    if (preferences.size === 0) {
      await chrome.storage.local.remove(this.storageKey)
      return
    }
    const snapshot = {
      version: SNAPSHOT_VERSION,
      preferences: [...preferences]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([assetId, preference]) => ({
          assetId,
          visible: preference.visible,
          source: preference.source === 'legacy' ? ('user' as const) : preference.source
        }))
    }
    await chrome.storage.local.set({ [this.storageKey]: snapshot })
  }

  async list(): Promise<readonly string[]> {
    await this.mutationQueue
    const preferences = await this.readSnapshot()
    return Object.freeze(
      [...preferences]
        .filter(([, preference]) => !preference.visible)
        .map(([assetId]) => assetId)
        .sort()
    )
  }

  setHidden(assetId: string, hidden: boolean): Promise<void> {
    const normalizedAssetId = normalizeManagedTokenAssetId(assetId)
    return this.enqueue(async () => {
      const preferences = await this.readSnapshot()
      preferences.set(
        normalizedAssetId,
        Object.freeze({ assetId: normalizedAssetId, visible: !hidden, source: 'user' as const })
      )
      await this.writeSnapshot(preferences)
    })
  }

  synchronizeProtocolDefaults(
    assets: readonly Readonly<{ assetId: string; visibleByDefault: boolean }>[]
  ): Promise<void> {
    if (assets.length > MAXIMUM_TOKEN_PREFERENCE_COUNT) {
      return Promise.reject(new Error('Too many Intents Token defaults'))
    }
    const defaults = new Map<string, boolean>()
    for (const asset of assets) {
      const assetId = normalizeManagedTokenAssetId(asset.assetId)
      if (defaults.has(assetId)) throw new Error('Duplicate Intents Token default')
      defaults.set(assetId, asset.visibleByDefault)
    }
    return this.enqueue(async () => {
      const preferences = await this.readSnapshot()
      let changed = false
      for (const [assetId, visible] of defaults) {
        const current = preferences.get(assetId)
        if (!current) {
          preferences.set(assetId, Object.freeze({ assetId, visible, source: 'default' as const }))
          changed = true
          continue
        }
        if (current.source === 'legacy') {
          preferences.set(
            assetId,
            Object.freeze({
              assetId,
              visible: current.visible,
              source: current.visible === visible ? ('default' as const) : ('user' as const)
            })
          )
          changed = true
          continue
        }
        if (current.source === 'default' && current.visible !== visible) {
          preferences.set(assetId, Object.freeze({ assetId, visible, source: 'default' as const }))
          changed = true
        }
      }
      if (changed) await this.writeSnapshot(preferences)
    })
  }

  revealHeldProtocolAssets(assetIds: readonly string[]): Promise<void> {
    if (assetIds.length > MAXIMUM_TOKEN_PREFERENCE_COUNT) {
      return Promise.reject(new Error('Too many held Intents Tokens'))
    }
    const normalizedAssetIds = new Set(assetIds.map(normalizeManagedTokenAssetId))
    return this.enqueue(async () => {
      const preferences = await this.readSnapshot()
      let changed = false
      for (const assetId of normalizedAssetIds) {
        const current = preferences.get(assetId)
        if (!current || current.visible || current.source !== 'default') continue
        preferences.set(
          assetId,
          Object.freeze({ assetId, visible: true, source: 'balance' as const })
        )
        changed = true
      }
      if (changed) await this.writeSnapshot(preferences)
    })
  }
}
