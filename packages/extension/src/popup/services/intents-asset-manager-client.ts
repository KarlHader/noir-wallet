import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { createInitialProductChainRegistry } from '@/core/chains/registry'
import { parseUserEvmAssetRecord, type UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { SwapToken } from '@/core/services/intents-api'
import {
  isDefaultVisibleIntentsAsset,
  resolveManagedIntentsAsset,
  resolveManagedIntentsAssets,
  type IntentsManagedAsset
} from '@/core/services/intents-managed-assets'
import { DedupPromise } from '@/lib/async-utils'

import { swapTokenCatalogClient } from './swap-token-catalog-client'
import { userEvmAssetsClient } from './user-evm-assets-client'
import { automaticRefreshSession } from './automatic-refresh-session'

const defaultAssetInitialization = new DedupPromise<boolean>()
const DEFAULT_ASSET_REFRESH_COOLDOWN_MS = 5 * 60_000

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function unwrap(value: unknown): unknown {
  const response = readRecord(value, 'Intents Token response')
  if (typeof response.error === 'string') throw new Error(response.error)
  return response.result
}

function resolveNetworks() {
  return resolveEvmNetworkCatalog(DEFAULT_NETWORK, getActiveChainEndpointSettings())
}

export function resolveManagedIntentsCatalog(
  tokens: readonly SwapToken[]
): readonly IntentsManagedAsset[] {
  return resolveManagedIntentsAssets(tokens, DEFAULT_NETWORK, resolveNetworks())
}

export function resolveManagedIntentsCatalogAsset(
  tokens: readonly SwapToken[],
  protocolAssetId: string
): IntentsManagedAsset | null {
  return resolveManagedIntentsAsset(tokens, protocolAssetId, DEFAULT_NETWORK, resolveNetworks())
}

async function enableEvmAssets(
  assets: readonly IntentsManagedAsset[],
  show: boolean
): Promise<readonly UserEvmAssetRecord[]> {
  const evmAssets = assets.filter(asset => asset.management === 'evm')
  if (evmAssets.length === 0) return Object.freeze([])
  const result = readRecord(
    unwrap(
      await chrome.runtime.sendMessage({
        type: 'ENABLE_INTENTS_EVM_ASSETS',
        assets: evmAssets.map(asset => ({
          chainId: asset.chainId,
          contractAddress: asset.reference,
          expectedDecimals: asset.decimals,
          ...(asset.iconUrl ? { iconUrl: asset.iconUrl } : {})
        })),
        show
      })
    ),
    'Intents EVM Token result'
  )
  if (!Array.isArray(result.assets) || result.assets.length > 64) {
    throw new Error('Invalid Intents EVM Token result')
  }
  const settings = getActiveChainEndpointSettings()
  const customNetworks = resolveEvmNetworkCatalog(DEFAULT_NETWORK, settings).filter(
    network => network.source === 'custom'
  )
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, customNetworks)
  return Object.freeze(result.assets.map(record => parseUserEvmAssetRecord(chains, record)))
}

async function setHidden(assetId: string, hidden: boolean): Promise<void> {
  const result = readRecord(
    unwrap(await chrome.runtime.sendMessage({ type: 'SET_TOKEN_HIDDEN', assetId, hidden })),
    'Token visibility result'
  )
  if (Object.keys(result).length !== 1 || result.hidden !== hidden) {
    throw new Error('Invalid Token visibility result')
  }
}

async function refreshProtocolAssets(force = false): Promise<void> {
  const result = readRecord(
    unwrap(await chrome.runtime.sendMessage({ type: 'REFRESH_INTENTS_PROTOCOL_ASSETS', force })),
    'Intents protocol asset refresh result'
  )
  if (Object.keys(result).length !== 1 || result.refreshed !== true) {
    throw new Error('Invalid Intents protocol asset refresh result')
  }
}

export const intentsAssetManagerClient = Object.freeze({
  ensureSelectedEvmAsset: async (asset: IntentsManagedAsset): Promise<void> => {
    if (asset.management !== 'evm') return
    const record = (await enableEvmAssets([asset], false))[0]
    if (!record || record.assetId !== asset.assetId) {
      throw new Error('Selected token registration failed')
    }
  },
  ensureDefaults: async (
    tokens: readonly SwapToken[],
    options: Readonly<{ forceProtocolRefresh?: boolean }> = {}
  ): Promise<readonly UserEvmAssetRecord[]> => {
    const assets = resolveManagedIntentsCatalog(tokens)
    const managed = await userEvmAssetsClient.listManaged()
    const existingEvmAssetIds = new Set(managed.userAssets.map(asset => asset.assetId))
    const existingProtocolAssetIds = new Set(managed.protocolAssetIds)
    const missingDefaultEvmAssets = assets.filter(
      asset =>
        asset.management === 'evm' &&
        isDefaultVisibleIntentsAsset(asset) &&
        !existingEvmAssetIds.has(asset.assetId)
    )
    const missingProtocolAssets = assets.some(
      asset => asset.management === 'protocol' && !existingProtocolAssetIds.has(asset.assetId)
    )
    const [evmResult] = await Promise.all([
      enableEvmAssets(missingDefaultEvmAssets, false),
      missingProtocolAssets || options.forceProtocolRefresh === true
        ? refreshProtocolAssets(options.forceProtocolRefresh === true)
        : Promise.resolve()
    ])
    return evmResult
  },
  setVisible: async (
    asset: IntentsManagedAsset,
    visible: boolean
  ): Promise<UserEvmAssetRecord | null> => {
    if (asset.management === 'evm') {
      if (!visible) {
        await setHidden(asset.assetId, true)
        return null
      }
      return (await enableEvmAssets([asset], true))[0] ?? null
    }
    await refreshProtocolAssets()
    await setHidden(asset.assetId, !visible)
    return null
  },
  showProtocolAsset: async (protocolAssetId: string): Promise<boolean> => {
    const cached = await swapTokenCatalogClient.readCached()
    let asset = resolveManagedIntentsCatalogAsset(cached, protocolAssetId)
    if (!asset) {
      if (cached.some(token => token.assetId === protocolAssetId)) return false
      const refreshed = await swapTokenCatalogClient.refresh()
      asset = resolveManagedIntentsCatalogAsset(refreshed, protocolAssetId)
    }
    if (!asset) return false
    if (asset.management === 'evm') {
      await enableEvmAssets([asset], true)
    } else {
      await refreshProtocolAssets()
      await setHidden(asset.assetId, false)
    }
    return true
  }
})

export function initializeDefaultIntentsAssets(): Promise<boolean> {
  if (DEFAULT_NETWORK !== 'mainnet') return Promise.resolve(false)
  return defaultAssetInitialization.run(async () => {
    let initializedFromCache = false
    const cached = await swapTokenCatalogClient.readCached()
    if (cached.length > 0) {
      await intentsAssetManagerClient.ensureDefaults(cached)
      initializedFromCache = true
    }
    const claimed = await automaticRefreshSession.claim(
      `intents-default-assets:${DEFAULT_NETWORK}`,
      ['catalog'],
      Date.now(),
      DEFAULT_ASSET_REFRESH_COOLDOWN_MS
    )
    if (claimed.length === 0) return initializedFromCache
    try {
      const refreshed = await swapTokenCatalogClient.refresh()
      await intentsAssetManagerClient.ensureDefaults(refreshed)
      return true
    } catch (error) {
      if (initializedFromCache) return true
      throw error
    }
  })
}
