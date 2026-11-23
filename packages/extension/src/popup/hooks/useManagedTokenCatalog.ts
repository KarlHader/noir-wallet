import { startTransition, useEffect, useMemo, useState } from 'react'
import type { Network } from '@/types'
import type { DetectedEvmAssetRecord, UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { ChromeTokenVisibilityRepository } from '@/infrastructure/portfolio/chrome-token-visibility'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { useSettingsStore } from '@/store/settings-store'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import { ChromeDetectedNearAssetCatalogRepository } from '@/infrastructure/chains/near/near-detected-asset-catalog'
import {
  buildManagedNearTokens,
  buildManagedTokenRows,
  type ManagedNearToken,
  type ManagedTokenRow
} from '@/popup/services/managed-token-list'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import { userEvmAssetsClient } from '@/popup/services/user-evm-assets-client'

interface ManagedCatalogScope {
  readonly network: Network
  readonly walletId: string | null
  readonly accountId: string | null
}

interface ManagedCatalogSnapshot {
  readonly key: string
  readonly userAssets: readonly UserEvmAssetRecord[]
  readonly detectedAssets: readonly DetectedEvmAssetRecord[]
  readonly protocolAssetIds: ReadonlySet<string>
  readonly catalogAssets: readonly IntentsManagedAsset[]
  readonly nearTokens: readonly ManagedNearToken[]
  readonly hiddenAssetIds: ReadonlySet<string>
  readonly ready: boolean
}

const EMPTY_ASSETS: readonly ManagedTokenRow[] = Object.freeze([])
const EMPTY_HIDDEN: ReadonlySet<string> = new Set()

export function useManagedTokenCatalog(scope: ManagedCatalogScope): Readonly<{
  rows: readonly ManagedTokenRow[]
  hiddenAssetIds: ReadonlySet<string>
  ready: boolean
}> {
  const settings = useSettingsStore(state => state.chainEndpointSettings)
  const key =
    scope.walletId && scope.accountId ? `${scope.network}:${scope.walletId}:${scope.accountId}` : ''
  const [snapshot, setSnapshot] = useState<ManagedCatalogSnapshot | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    const visibility = new ChromeTokenVisibilityRepository(scope.network)
    const load = async () => {
      const nearEnabled = isSelectableChainFamily('near', __ENABLED_CHAIN_FEATURE_FLAGS__)
      const [assets, overrides, cached, nearDetected] = await Promise.allSettled([
        scope.network === DEFAULT_NETWORK
          ? userEvmAssetsClient.listManaged()
          : Promise.resolve(null),
        visibility.readUserOverrides(),
        scope.network === DEFAULT_NETWORK
          ? swapTokenCatalogClient.readCached()
          : Promise.resolve([]),
        nearEnabled
          ? new ChromeDetectedNearAssetCatalogRepository(scope.network).list()
          : Promise.resolve([])
      ])
      if (cancelled) return
      const cachedTokens = cached.status === 'fulfilled' ? cached.value : []
      startTransition(() =>
        setSnapshot({
          key,
          userAssets: assets.status === 'fulfilled' && assets.value ? assets.value.userAssets : [],
          detectedAssets:
            assets.status === 'fulfilled' && assets.value ? assets.value.detectedAssets : [],
          protocolAssetIds: new Set(
            assets.status === 'fulfilled' && assets.value ? assets.value.protocolAssetIds : []
          ),
          catalogAssets: resolveManagedIntentsCatalog(cachedTokens),
          nearTokens: buildManagedNearTokens(
            scope.network,
            nearDetected.status === 'fulfilled' ? nearDetected.value : [],
            isSelectableChainFamily('near', __ENABLED_CHAIN_FEATURE_FLAGS__)
          ),
          hiddenAssetIds: new Set(
            overrides.status === 'fulfilled' ? overrides.value.hiddenAssetIds : []
          ),
          ready: overrides.status === 'fulfilled'
        })
      )
      if (scope.network !== DEFAULT_NETWORK || cachedTokens.length > 0) return
      try {
        const catalogAssets = resolveManagedIntentsCatalog(await swapTokenCatalogClient.refresh())
        if (!cancelled)
          startTransition(() =>
            setSnapshot(current => (current?.key === key ? { ...current, catalogAssets } : current))
          )
      } catch {
        // Local rows remain available when catalog refresh fails.
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [key, scope.network])

  const current = snapshot?.key === key ? snapshot : null
  const rows = useMemo(() => {
    if (!current?.ready) return EMPTY_ASSETS
    const networks = resolveEvmNetworkCatalog(scope.network, settings)
    return buildManagedTokenRows({
      networks,
      userAssets: current.userAssets,
      detectedAssets: current.detectedAssets,
      catalogAssets: current.catalogAssets,
      protocolAssetIds: current.protocolAssetIds,
      nearTokens: current.nearTokens
    })
  }, [current, scope.network, settings])

  return {
    rows,
    hiddenAssetIds: current?.hiddenAssetIds ?? EMPTY_HIDDEN,
    ready: current?.ready ?? false
  }
}
