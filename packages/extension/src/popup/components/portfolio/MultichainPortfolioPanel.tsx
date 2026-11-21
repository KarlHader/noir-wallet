import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import type { PortfolioReadModel } from '@/core/portfolio'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import type { AccountNetworksView } from '@/popup/services/account-networks-client'
import { PortfolioShell } from './PortfolioShell'
import { resolvePortfolioChainSelection } from '@/popup/services/portfolio-presentation'
import { withNearConfidentialZecChain } from '@/popup/services/near-confidential-holdings'
import type { AssetPriceReadModel } from '@/core/prices'
import { ListSkeleton } from '../ui/skeleton'
import { useSettingsStore } from '@/store/settings-store'
import { useWalletStore } from '@/store/wallet-store'
import {
  getPortfolioRecoveryDelayMs,
  hasPortfolioBalanceRefreshIssue
} from '@/popup/services/portfolio-recovery'
import {
  hasRetryablePortfolioPriceGap,
  summarizePortfolioFiat
} from '@/popup/services/portfolio-prices'
import {
  isPortfolioModelForScope,
  shouldRefreshPortfolioFromNetwork
} from '@/popup/services/portfolio-cache'
import { projectPortfolioForDomain, type AssetDomain } from '@/popup/services/asset-domains'

const FAST_TRANSACTION_RECHECK_INTERVAL_MS = 5_000

interface MultichainPortfolioPanelProps {
  domain?: AssetDomain
  walletId: string | null
  accountId: string | null
  model: PortfolioReadModel | null
  activeAccount?: AccountNetworksView | null
  status: 'loading' | 'ready' | 'error'
  prices: AssetPriceReadModel | null
  priceStatus?: 'loading' | 'ready' | 'error'
  balancesHidden?: boolean
  onRefresh: (forceDiscovery?: boolean) => Promise<void>
  onRetryPrices?: () => Promise<void>
  onSelectAsset?: (assetId: string) => void
  onSelectConfidentialAsset?: (tokenId: string) => void
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
  domain = 'all',
  walletId,
  accountId,
  model,
  activeAccount,
  status,
  prices,
  priceStatus,
  balancesHidden,
  onRefresh: load,
  onRetryPrices,
  onSelectAsset,
  onSelectConfidentialAsset,
  onManageTokens
}: MultichainPortfolioPanelProps) {
  const scopeKey = JSON.stringify([walletId ?? '', accountId ?? ''])
  const network = useWalletStore(state => state.currentNetwork)
  const chainListScopeKey = JSON.stringify([network, walletId ?? '', accountId ?? ''])
  const persistedChainSelection = useSettingsStore(
    state => state.portfolioChainSelectionByAccount[scopeKey]
  )
  const portfolioViewMode = useSettingsStore(state => state.portfolioViewMode)
  const setPortfolioViewMode = useSettingsStore(state => state.setPortfolioViewMode)
  const setPortfolioChainSelection = useSettingsStore(state => state.setPortfolioChainSelection)
  const chainListExpanded = useSettingsStore(
    state => state.expandedPortfolioChainLists[chainListScopeKey] === true
  )
  const setPortfolioChainListExpanded = useSettingsStore(
    state => state.setPortfolioChainListExpanded
  )
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
  const scopedAccount =
    activeAccount?.walletId === walletId && activeAccount?.accountId === accountId
      ? activeAccount
      : null
  const projectedModel =
    domain === 'all'
      ? visibleModel
      : visibleModel
        ? projectPortfolioForDomain(visibleModel, domain, {
            evmPrivateAvailable: supportsEvmPrivateExecution(scopedAccount?.walletSource)
          })
        : null
  const domainModel =
    domain === 'all' || domain === 'shield'
      ? withNearConfidentialZecChain(projectedModel, network)
      : projectedModel
  const availableChainIds = resolvePortfolioChainSelection(
    domainModel,
    null,
    __ENABLED_CHAIN_FEATURE_FLAGS__
  )
  const selectedChainIds = resolvePortfolioChainSelection(
    domainModel,
    persistedChainSelection,
    __ENABLED_CHAIN_FEATURE_FLAGS__
  )
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
      model={domainModel!}
      sourceModel={visibleModel}
      network={network}
      domain={domain}
      prices={prices}
      priceStatus={priceStatus}
      balancesHidden={balancesHidden}
      view={portfolioViewMode}
      onViewChange={setPortfolioViewMode}
      chainListExpanded={chainListExpanded}
      onChainListExpandedChange={expanded => {
        if (walletId && accountId) setPortfolioChainListExpanded(chainListScopeKey, expanded)
      }}
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
      onSelectConfidentialAsset={onSelectConfidentialAsset}
      onRefresh={() => void load(true)}
      onManageTokens={onManageTokens}
    />
  )
}
