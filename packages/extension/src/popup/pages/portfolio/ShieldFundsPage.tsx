import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import Big, { safeBig } from '@/lib/big'
import { formatFiatAmount } from '@/lib/number-format'
import type { AssetPriceReadModel } from '@/core/prices'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useSettingsStore } from '@/store/settings-store'
import { canShieldTransparentFunds } from '@/core/zcash/shielding'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { useShieldFunds } from '@/popup/hooks/useShieldFunds'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import {
  buildShieldProviderGroups,
  summarizeKnownShieldFiat,
  type ShieldProvider
} from '@/popup/services/asset-domains'
import { summarizeNearConfidentialHoldings } from '@/popup/services/near-confidential-holdings'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { useNavigate } from '@/popup/provider/Router'
import { PageHeader } from '@/popup/components/common/PageHeader'
import {
  ShieldProviderLogo,
  SHIELD_PROVIDERS
} from '@/popup/components/portfolio/ShieldPortfolioView'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'

type ShieldAction = 'deposit' | 'withdraw' | 'move'

const actionIcons: Record<ShieldAction, string> = {
  deposit: 'lucide:arrow-down-to-line',
  withdraw: 'lucide:arrow-up-from-line',
  move: 'lucide:arrow-left-right'
}

export function ShieldFundsPage() {
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  return <ShieldFundsContent key={`${currentNetwork}:${currentWalletId}:${currentAccountId}`} />
}

function ShieldFundsContent() {
  const { navigate } = useNavigate()
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const { activeAccount } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const { model, status, refresh } = useHomePortfolio(
    account?.walletId ?? null,
    account?.accountId ?? null
  )
  const { isShielding, handleShieldFunds, shieldSheet } = useShieldFunds()
  const [prices, setPrices] = useState<AssetPriceReadModel | null>(null)
  const [pricesLoading, setPricesLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<ShieldAction | null>(null)

  useEffect(() => {
    setPendingAction(null)
  }, [account?.walletId, account?.accountId, currentNetwork])

  useEffect(() => {
    let active = true
    void assetPriceClient
      .getPrices('read')
      .then(cached => {
        if (active && cached) setPrices(cached)
      })
      .catch(() => {})
    void assetPriceClient
      .getPrices('refresh')
      .then(refreshed => {
        if (active && refreshed) setPrices(refreshed)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setPricesLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const near = useMemo(() => summarizeNearConfidentialHoldings(model, prices), [model, prices])
  const zcash = useMemo(
    () =>
      model
        ? buildShieldProviderGroups(model, prices).find(group => group.id === 'zcash-shield')
        : undefined,
    [model, prices]
  )
  const hasZcash =
    activeAccount?.networks.some(network => network.chain.family === 'zcash') ??
    model?.chains.some(chain => chain.chain.family === 'zcash') ??
    false
  const nearChainIds = getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet')
  const canManageNear = nearChainIds.length > 0
  const hasSpendableNear = near.entries.some(
    entry =>
      entry.asset.assetId &&
      nearChainIds.some(chainId => entry.asset.assetId?.startsWith(`${chainId}/`)) &&
      safeBig(entry.asset.availableRaw).gt(0)
  )
  const hasNear = canManageNear || near.entries.length > 0
  const shieldTotal = model
    ? summarizeKnownShieldFiat(
        hasNear ? near : null,
        hasZcash || zcash ? (zcash?.fiat ?? null) : undefined
      )
    : null
  const total = shieldTotal?.usd ?? null
  const totalLabel = balancesHidden
    ? '••••'
    : total === null
      ? status === 'loading' || (zcash && pricesLoading)
        ? '…'
        : '—'
      : formatFiatAmount(total, { showSign: true })
  const canDepositZcash = hasZcash && canShieldTransparentFunds(zcashBalance) && !isShielding
  const canWithdrawZcash =
    hasZcash && Big(getFundingBalance(zcashBalance, 'shielded').available).gt(0)
  const availableProviders = (action: ShieldAction): ShieldProvider[] => {
    const nearProviders =
      canManageNear &&
      (action === 'deposit' || action === 'move' || near.status !== 'ready' || hasSpendableNear)
        ? ['near-confidential' as const]
        : []
    const zcashAvailable =
      action === 'deposit' ? canDepositZcash : action === 'withdraw' ? canWithdrawZcash : false
    return zcashAvailable ? [...nearProviders, 'zcash-shield'] : nearProviders
  }
  const runAction = (provider: ShieldProvider, action: ShieldAction) => {
    setPendingAction(null)
    if (provider === 'zcash-shield') {
      if (action === 'deposit') void handleShieldFunds()
      else if (action === 'withdraw') navigate('/send/zcash?from=shielded')
      return
    }
    if (action === 'move')
      navigate(
        hasSpendableNear || near.status !== 'ready'
          ? '/transfer?from=shield&to=private&provider=near-confidential'
          : '/transfer?from=public&to=shield&provider=near-confidential'
      )
    else navigate(`/shield-${action}?provider=near-confidential`)
  }
  const openAction = (action: ShieldAction) => {
    const providers = availableProviders(action)
    if (providers.length === 1) runAction(providers[0], action)
    else if (providers.length > 1) setPendingAction(action)
  }

  return (
    <div className="page-container min-h-0 overflow-hidden">
      <PageHeader title="Shield Funds" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
        <div className="pb-5 pt-4 text-center">
          <p
            className="break-all text-[38px] font-semibold leading-tight tabular-nums"
            aria-label={balancesHidden ? 'Shield balance hidden' : undefined}
          >
            {totalLabel}
          </p>
          <p className="mt-1 text-sm text-wallet-secondary">Total shield balance</p>
        </div>
        <div className="grid grid-cols-3 gap-2.5" aria-label="Shield actions">
          {(['deposit', 'withdraw', 'move'] as const).map(action => (
            <button
              key={action}
              type="button"
              disabled={availableProviders(action).length === 0}
              onClick={() => openAction(action)}
              className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg bg-wallet-surface text-xs capitalize enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
            >
              <Icon icon={actionIcons[action]} width={22} height={22} />
              {action}
            </button>
          ))}
        </div>
        <div className="mt-7 flex items-center justify-between">
          <h2 className="text-sm text-wallet-secondary">Shield provider</h2>
          {status === 'error' && (
            <button
              type="button"
              onClick={() => void refresh(true)}
              className="text-xs text-primary"
            >
              Retry
            </button>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(['near-confidential', 'zcash-shield'] as const)
            .filter(provider => (provider === 'near-confidential' ? hasNear : hasZcash))
            .map(provider => {
              const group = provider === 'zcash-shield' ? zcash : undefined
              const fiat = provider === 'near-confidential' ? near.fiat : group?.fiat
              const label = balancesHidden
                ? '••••'
                : fiat === null || fiat === undefined
                  ? status === 'loading' || (provider === 'zcash-shield' && pricesLoading)
                    ? '…'
                    : '—'
                  : formatFiatAmount(fiat, { showSign: true })
              return (
                <button
                  key={provider}
                  type="button"
                  onClick={() => navigate(`/shield-provider?provider=${provider}`)}
                  className="wallet-interactive flex h-[154px] min-w-0 flex-col overflow-hidden rounded-lg bg-wallet-surface text-left hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                >
                  <span
                    className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-2 text-center"
                    style={{
                      backgroundImage: `radial-gradient(ellipse at 50% 0%, ${SHIELD_PROVIDERS[provider].tint}88, transparent 80%)`
                    }}
                  >
                    <ShieldProviderLogo provider={provider} size={38} />
                    <span className="text-sm font-medium leading-tight">
                      {SHIELD_PROVIDERS[provider].name}
                    </span>
                  </span>
                  <span className="flex h-9 items-center justify-between gap-1 bg-white/5 px-2.5 text-xs">
                    <span className="flex min-w-0 items-center">
                      {provider === 'near-confidential'
                        ? near.entries
                            .slice(0, 4)
                            .map((entry, index) => (
                              <TokenIcon
                                key={entry.asset.tokenId}
                                assetId={entry.asset.assetId}
                                symbol={entry.asset.symbol ?? '?'}
                                icon={entry.asset.iconUrl}
                                size={16}
                                className={index ? '-ml-1 shrink-0' : 'shrink-0'}
                              />
                            ))
                        : group?.entries
                            .slice(0, 4)
                            .map((entry, index) => (
                              <TokenIcon
                                key={entry.asset.asset.id}
                                assetId={entry.asset.asset.id}
                                symbol={entry.asset.metadata.symbol}
                                icon={entry.asset.metadata.iconUrl}
                                size={16}
                                className={index ? '-ml-1 shrink-0' : 'shrink-0'}
                              />
                            ))}
                    </span>
                    <span
                      className="max-w-[100px] truncate"
                      title={balancesHidden ? undefined : label}
                    >
                      {label}
                    </span>
                  </span>
                </button>
              )
            })}
          {(
            [
              ['ZAMA', 'lucide:shield'],
              ['Privacy Pools', 'lucide:scan-face']
            ] as const
          ).map(([name, icon]) => (
            <div
              key={name}
              className="flex h-[154px] min-w-0 flex-col items-center justify-between rounded-lg bg-wallet-surface px-2 pb-3 pt-6 text-center"
            >
              <Icon icon={icon} width={34} height={34} className="text-muted" />
              <span className="text-sm font-medium">{name}</span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] text-muted">
                Coming soon
              </span>
            </div>
          ))}
        </div>
      </div>
      <Dialog open={pendingAction !== null} onOpenChange={open => !open && setPendingAction(null)}>
        <DialogContent position="bottom" className="gap-2 bg-wallet-surface p-4 pb-6">
          <DialogTitle className="text-base font-medium capitalize">
            {pendingAction}{' '}
            {pendingAction === 'deposit' ? 'to' : pendingAction === 'withdraw' ? 'from' : 'in'}
          </DialogTitle>
          <DialogDescription className="sr-only">Choose a Shield provider</DialogDescription>
          {pendingAction &&
            availableProviders(pendingAction).map(provider => (
              <button
                key={provider}
                type="button"
                onClick={() => runAction(provider, pendingAction)}
                className="wallet-interactive flex h-12 items-center gap-3 rounded-lg bg-background px-3 text-left text-sm hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
              >
                <ShieldProviderLogo provider={provider} size={26} />
                {SHIELD_PROVIDERS[provider].name}
              </button>
            ))}
        </DialogContent>
      </Dialog>
      {shieldSheet}
    </div>
  )
}
