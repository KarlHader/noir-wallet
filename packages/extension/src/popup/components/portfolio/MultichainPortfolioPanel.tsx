import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import type { PortfolioReadModel } from '@/core/portfolio'
import { PortfolioShell } from './PortfolioShell'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import type { AssetPriceReadModel } from '@/core/prices'
import { ListSkeleton } from '../ui/skeleton'
import type { ZcashSyncProgressState } from '../common/ZcashSyncProgress'
import { useSettingsStore } from '@/store/settings-store'
import { getPortfolioRecoveryDelayMs, hasPortfolioBalanceRefreshIssue } from './portfolio-recovery'
import { hasRetryablePortfolioPriceGap, summarizePortfolioFiat } from './portfolio-prices'
import {
  isPortfolioModelForScope,
  shouldRefreshPortfolioFromNetwork
} from '@/popup/services/portfolio-cache'

const FAST_TRANSACTION_RECHECK_INTERVAL_MS = 5_000

interface MultichainPortfolioPanelProps {
  walletId: string | null
  accountId: string | null
  model: PortfolioReadModel | null
  status: 'loading' | 'ready' | 'error'
  prices: AssetPriceReadModel | null
  priceStatus?: 'loading' | 'ready' | 'error'
  balancesHidden?: boolean
  zcashSyncState?: ZcashSyncProgressState
  onRefresh: (forceDiscovery?: boolean) => Promise<void>
  onRetryPrices?: () => Promise<void>
  onSelectAsset?: (assetId: string) => void
  onManageTokens?: () => void
}

function PortfolioState({
  icon,
  title,
  description
}: {
  icon: string
  title: string
  description: string
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 py-8 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-foreground/5">
        <Icon icon={icon} width={24} height={24} className="text-muted" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-[260px] text-xs leading-5 text-muted">{description}</p>
    </div>
  )
}

export function MultichainPortfolioPanel({
  walletId,
  accountId,
  model,
  status,
  prices,
  priceStatus,
  balancesHidden,
  zcashSyncState,
  onRefresh: load,
  onRetryPrices,
  onSelectAsset,
  onManageTokens
}: MultichainPortfolioPanelProps) {
  const scopeKey = JSON.stringify([walletId ?? '', accountId ?? ''])
  const persistedChainSelection = useSettingsStore(
    state => state.portfolioChainSelectionByAccount[scopeKey]
  )
  const portfolioViewMode = useSettingsStore(state => state.portfolioViewMode)
  const setPortfolioViewMode = useSettingsStore(state => state.setPortfolioViewMode)
  const setPortfolioChainSelection = useSettingsStore(state => state.setPortfolioChainSelection)
  const [recoveryAttempt, setRecoveryAttempt] = useState(0)

  useEffect(() => {
    if (!walletId || !accountId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const recheck = async () => {
      if (!document.hidden) {
        await chrome.runtime
          .sendMessage({ type: 'RECHECK_FAST_PENDING_TRANSACTIONS' })
          .catch(() => {})
      }
      if (active) timer = setTimeout(() => void recheck(), FAST_TRANSACTION_RECHECK_INTERVAL_MS)
    }
    timer = setTimeout(() => void recheck(), FAST_TRANSACTION_RECHECK_INTERVAL_MS)
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [accountId, walletId])

  const visibleModel = isPortfolioModelForScope(model, walletId, accountId) ? model : null
  const availableChainIds =
    visibleModel?.chains
      .filter(chain => isSelectableChainFamily(chain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__))
      .map(chain => chain.chain.id) ?? []
  const availableChainIdSet = new Set<string>(availableChainIds)
  const persistedAvailableChainIds = persistedChainSelection?.filter(chainId =>
    availableChainIdSet.has(chainId)
  )
  const selectedChainIds =
    persistedAvailableChainIds?.length === 1 ? persistedAvailableChainIds : availableChainIds
  const balanceRecoveryNeeded =
    status === 'error' ||
    (visibleModel !== null &&
      hasPortfolioBalanceRefreshIssue(visibleModel.chains) &&
      shouldRefreshPortfolioFromNetwork(visibleModel))
  const priceRecoveryNeeded =
    visibleModel !== null &&
    (priceStatus === 'error' ||
      prices?.status === 'error' ||
      hasRetryablePortfolioPriceGap(visibleModel, prices) ||
      summarizePortfolioFiat(visibleModel, prices).staleAssetCount > 0)
  const recoveryNeeded = balanceRecoveryNeeded || priceRecoveryNeeded

  useEffect(() => {
    if (!recoveryNeeded) {
      setRecoveryAttempt(0)
      return
    }
    if (!walletId || !accountId || status === 'loading' || priceStatus === 'loading') return
    if (!balanceRecoveryNeeded && !onRetryPrices) return

    let active = true
    const timer = window.setTimeout(() => {
      if (!active) return
      setRecoveryAttempt(current => current + 1)
      const operation = balanceRecoveryNeeded ? load() : onRetryPrices?.()
      void Promise.resolve(operation).catch(() => {})
    }, getPortfolioRecoveryDelayMs(recoveryAttempt))
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [
    accountId,
    balanceRecoveryNeeded,
    load,
    onRetryPrices,
    priceStatus,
    recoveryAttempt,
    recoveryNeeded,
    status,
    walletId
  ])

  if (status === 'loading' && !visibleModel) {
    return <ListSkeleton rows={3} label="Loading portfolio" className="px-5 py-3" />
  }

  if (status === 'error' && !visibleModel) {
    return (
      <PortfolioState
        icon="lucide:wifi-off"
        title="Unable to load portfolio"
        description="Your wallet data is safe. Noir Wallet is reconnecting automatically."
      />
    )
  }

  if (!visibleModel) {
    return (
      <PortfolioState
        icon="lucide:layers"
        title="Portfolio is not ready"
        description="Finish wallet setup or unlock this account to load enabled networks."
      />
    )
  }

  return (
    <PortfolioShell
      model={visibleModel}
      prices={prices}
      priceStatus={priceStatus}
      balancesHidden={balancesHidden}
      zcashSyncState={zcashSyncState}
      view={portfolioViewMode}
      onViewChange={setPortfolioViewMode}
      refreshing={status === 'loading' || priceStatus === 'loading' || recoveryNeeded}
      refreshDisabled={status === 'loading' || priceStatus === 'loading'}
      selectedChainIds={selectedChainIds}
      onSelectedChainIdsChange={chainIds =>
        setPortfolioChainSelection(
          scopeKey,
          chainIds.length === availableChainIds.length ? null : chainIds
        )
      }
      onSelectAsset={onSelectAsset}
      onRefresh={() => void load(true)}
      onManageTokens={onManageTokens}
    />
  )
}
