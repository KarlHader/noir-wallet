import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { createInitialProductChainRegistry } from '@/core/chains/registry'
import { parseUserEvmAssetRecord, type UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { SwapToken } from '@/core/services/intents-api'
import {
  resolveManagedIntentsAsset,
  resolveManagedIntentsAssets,
  type IntentsManagedAsset
} from '@/core/services/intents-managed-assets'
import { swapTokenCatalogClient } from './swap-token-catalog-client'

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
  ensureSelectedEvmAsset: async (
    asset: IntentsManagedAsset
  ): Promise<UserEvmAssetRecord | null> => {
    if (asset.management !== 'evm') return null
    const record = (await enableEvmAssets([asset], false))[0]
    if (!record || record.assetId !== asset.assetId) {
      throw new Error('Selected token registration failed')
    }
    return record
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
