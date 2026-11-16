import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import zamaLogo from '@/images/figma-zama.png'
import privacyPoolsLogo from '@/images/figma-privacy-pools.png'
import { formatFiatAmount } from '@/lib/number-format'
import type { AssetPriceReadModel } from '@/core/prices'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useSettingsStore } from '@/store/settings-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import {
  buildShieldProviderGroups,
  summarizeKnownShieldFiat,
  type ShieldProvider
} from '@/popup/services/asset-domains'
import {
  selectShieldActions,
  withShieldAsset,
  type ShieldAction
} from '@/popup/services/shield-action-selection'
import { useLocation, useNavigate } from '@/popup/provider/Router'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { WalletActionIcon } from '@/popup/components/common/WalletActionIcon'
import { ShieldProviderLogo, SHIELD_PROVIDERS } from '@/popup/components/portfolio/shield-providers'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import {
  nearConfidentialVaultIcons,
  zcashShieldVaultIcons
} from '@/popup/services/shield-vault-display-icons'
import {
  resolveShieldZcashVaultEntry,
  shieldZcashEnablePath
} from '@/popup/services/shield-zcash-entry'
import { getDefaultZcashSelfMoveSource } from '@/popup/services/zcash-self-move'

export function ShieldFundsPage() {
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  return <ShieldFundsContent key={`${currentNetwork}:${currentWalletId}:${currentAccountId}`} />
}

function ShieldFundsContent() {
  const { navigate, replace } = useNavigate()
  const location = useLocation()
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const { activeAccount, loading: accountLoading } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const { model, status, refresh, readLatest } = useHomePortfolio(
    account?.walletId ?? null,
    account?.accountId ?? null
  )
  const zcashAccount = useWalletStore(state => state.getCurrentAccount())
  const zcashKeySource = useWalletStore(state => state.getCurrentWallet()?.keySource)
  const [prices, setPrices] = useState<AssetPriceReadModel | null>(null)
  const [pricesLoading, setPricesLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<ShieldAction | null>(null)
  const handledActionQuery = useRef<string | null>(null)

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

  const shieldActions = selectShieldActions({
    model,
    prices,
    account: activeAccount,
    network: currentNetwork,
    zcashAddresses: zcashAccount?.addresses,
    zcashBalance,
    zcashKeySource
  })
  const { near, canManageNear, hasZcash, providersFor } = shieldActions
  const shieldScopeKey = `${currentNetwork}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`
  const {
    connecting: nearConnecting,
    error: nearBalanceError,
    refreshBalances: refreshNearBalances
  } = useShieldBalances({
    active: true,
    enabled: canManageNear && near.status !== 'ready',
    scopeKey: shieldScopeKey,
    scope: account
      ? {
          network: currentNetwork,
          keyDomainId: account.walletId,
          accountId: account.accountId
        }
      : null,
    refreshPortfolio: refresh,
    readProjection: readLatest
  })
  const zcashMoveSource = getDefaultZcashSelfMoveSource({
    addresses: zcashAccount?.addresses,
    balance: zcashBalance,
    keySource: zcashKeySource,
    network: currentNetwork
  })
  const zcash = useMemo(
    () =>
      model
        ? buildShieldProviderGroups(model, prices).find(group => group.id === 'zcash-shield')
        : undefined,
    [model, prices]
  )
  const hasNear = canManageNear || near.entries.length > 0
  const zcashVaultEntry = resolveShieldZcashVaultEntry({
    network: currentNetwork,
    walletSource: activeAccount?.walletSource ?? null,
    hasPortfolioZcash: hasZcash,
    enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
  })
  const nearVaultIcons = useMemo(() => nearConfidentialVaultIcons(near.entries), [near.entries])
  const zcashVaultIcons = useMemo(
    () => zcashShieldVaultIcons(zcash?.entries.map(entry => entry.asset) ?? []),
    [zcash?.entries]
  )
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
      ? status === 'loading' || nearConnecting || (zcash && pricesLoading)
        ? '…'
        : '—'
      : formatFiatAmount(total, { showSign: true })
  const availableProviders = (action: ShieldAction): readonly ShieldProvider[] =>
    action === 'move'
      ? [
          ...(canManageNear ? (['near-confidential'] as const) : []),
          ...(hasZcash && zcashMoveSource ? (['zcash-shield'] as const) : [])
        ]
      : providersFor(action)
  const mode = new URLSearchParams(location.search).get('mode') === 'private' ? 'private' : 'public'
  const requestedAssetId = new URLSearchParams(location.search).get('assetId')
  const originParams = new URLSearchParams(location.search)
  originParams.delete('action')
  const originSearch = originParams.toString()
  const sendOriginPath = encodeURIComponent(
    `${location.pathname}${originSearch ? `?${originSearch}` : ''}`
  )
  const zcashSendScopeQuery =
    currentWalletId && currentAccountId
      ? `&sourceWalletId=${encodeURIComponent(currentWalletId)}&sourceAccountId=${encodeURIComponent(currentAccountId)}`
      : ''
  const movePath = withShieldAsset(
    `/transfer?entry=shield&provider=near-confidential&mode=${mode}${requestedAssetId ? `&from=${mode}&to=shield` : ''}`,
    requestedAssetId
  )
  const zcashMovePath = zcashMoveSource
    ? `/send/zcash?move=1&from=${zcashMoveSource}&originPath=${sendOriginPath}${zcashSendScopeQuery}`
    : null
  const runAction = (provider: ShieldProvider, action: ShieldAction, auto = false) => {
    setPendingAction(null)
    const go = (path: string) =>
      (auto ? replace : navigate)(withShieldAsset(path, requestedAssetId))
    if (action === 'move') {
      if (provider === 'zcash-shield') {
        if (zcashMovePath) go(zcashMovePath)
      } else go(movePath)
      return
    }
    if (action === 'receive') {
      go('/shield-deposit')
      return
    }
    if (action === 'swap') {
      if (provider === 'near-confidential' && canManageNear)
        go('/shield-swap?provider=near-confidential')
      return
    }
    if (provider === 'zcash-shield') {
      if (action === 'send') {
        const path = withShieldAsset(
          `/send/zcash?from=shielded&originPath=${sendOriginPath}${zcashSendScopeQuery}`,
          requestedAssetId
        )
        navigate(path, {
          replace: auto,
          state:
            !auto && account
              ? {
                  sendOriginHistory: {
                    originPath: decodeURIComponent(sendOriginPath),
                    network: currentNetwork,
                    walletId: account.walletId,
                    accountId: account.accountId,
                    entryKey: location.key
                  }
                }
              : undefined
        })
      }
      return
    }
    go(
      action === 'send'
        ? `/shield-withdraw?provider=near-confidential&originPath=${sendOriginPath}`
        : '/shield-deposit?provider=near-confidential'
    )
  }
  const openAction = (action: ShieldAction) => {
    if (action === 'move') {
      if (canManageNear) navigate(movePath)
      else if (zcashMovePath) navigate(zcashMovePath)
      return
    }
    if (action === 'receive') {
      navigate(withShieldAsset('/shield-deposit', requestedAssetId))
      return
    }
    if (action === 'send') {
      const provider = canManageNear ? 'near-confidential' : hasZcash ? 'zcash-shield' : null
      if (provider) runAction(provider, action)
      return
    }
    const providers = availableProviders(action)
    if (providers.length === 1) runAction(providers[0], action)
    else if (providers.length > 1) setPendingAction(action)
  }
  const requestedAction = new URLSearchParams(location.search).get('action')
  useEffect(() => {
    if (!requestedAction) {
      handledActionQuery.current = null
      return
    }
    if (
      (requestedAction !== 'send' &&
        requestedAction !== 'receive' &&
        requestedAction !== 'move' &&
        requestedAction !== 'swap') ||
      ((requestedAction === 'send' || requestedAction === 'swap') &&
        (!model || status === 'loading')) ||
      accountLoading ||
      handledActionQuery.current === location.search
    )
      return
    handledActionQuery.current = location.search
    const providers = availableProviders(requestedAction)
    if (requestedAction === 'move' && (canManageNear || zcashMovePath)) {
      replace(canManageNear ? movePath : zcashMovePath!)
    } else if (requestedAction === 'receive' && providers.length > 0) {
      replace(withShieldAsset('/shield-deposit', requestedAssetId))
    } else if (requestedAction === 'send' && canManageNear)
      runAction('near-confidential', requestedAction, true)
    else if (providers.length === 1) runAction(providers[0]!, requestedAction, true)
    else {
      replace(withShieldAsset(`/shield-funds?mode=${mode}`, requestedAssetId))
      if (providers.length > 1) setPendingAction(requestedAction)
    }
  }, [requestedAction, model, status, accountLoading, location.search, replace])

  return (
    <div className="page-container min-h-0 overflow-hidden">
      <div className="shrink-0 border-b border-white/[0.08]">
        <PageHeader title="Shielded" showBack />
      </div>
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
          {(['send', 'receive', 'move'] as const).map(action => (
            <button
              key={action}
              type="button"
              disabled={availableProviders(action).length === 0}
              onClick={() => openAction(action)}
              className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg bg-wallet-surface text-xs capitalize enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
            >
              <WalletActionIcon action={action} size={22} />
              {action}
            </button>
          ))}
        </div>
        <div className="mt-7 flex items-center justify-between">
          <h2 className="text-sm text-wallet-secondary">Shield Vault</h2>
          {(status === 'error' || nearBalanceError) && (
            <button
              type="button"
              onClick={() => void (nearBalanceError ? refreshNearBalances(true) : refresh(true))}
              className="text-xs text-primary"
            >
              Retry
            </button>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(['near-confidential', 'zcash-shield'] as const)
            .filter(provider =>
              provider === 'near-confidential' ? hasNear : zcashVaultEntry.showVaultCard
            )
            .map(provider => {
              const group = provider === 'zcash-shield' ? zcash : undefined
              const fiat = provider === 'near-confidential' ? near.fiat : group?.fiat
              const label = balancesHidden
                ? '••••'
                : fiat === null || fiat === undefined
                  ? status === 'loading' ||
                    (provider === 'near-confidential' && nearConnecting) ||
                    (provider === 'zcash-shield' && pricesLoading)
                    ? '…'
                    : '—'
                  : formatFiatAmount(fiat, { showSign: true })
              const zcashNeedsEnable =
                provider === 'zcash-shield' && !zcashVaultEntry.hasActiveZcash
              return (
                <button
                  key={provider}
                  type="button"
                  onClick={() =>
                    zcashNeedsEnable &&
                    zcashVaultEntry.canEnableZcash &&
                    currentWalletId &&
                    currentAccountId
                      ? navigate(shieldZcashEnablePath(currentWalletId, currentAccountId))
                      : navigate(
                          withShieldAsset(
                            `/shield-provider?provider=${provider}&mode=${mode}`,
                            requestedAssetId
                          )
                        )
                  }
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
                    {zcashNeedsEnable && zcashVaultEntry.canEnableZcash ? (
                      <span className="flex w-full items-center justify-between gap-2 text-xs text-primary">
                        <span>Enable Zcash</span>
                        <Icon
                          icon="lucide:chevron-right"
                          width={14}
                          height={14}
                          aria-hidden="true"
                        />
                      </span>
                    ) : (
                      <>
                        <span className="flex min-w-0 items-center">
                          {provider === 'near-confidential'
                            ? nearVaultIcons.map((entry, index) => (
                                <TokenIcon
                                  key={entry.key}
                                  assetId={entry.assetId}
                                  symbol={entry.symbol}
                                  icon={entry.icon}
                                  size={16}
                                  className={index ? '-ml-1 shrink-0' : 'shrink-0'}
                                />
                              ))
                            : zcashVaultIcons.map((entry, index) => (
                                <TokenIcon
                                  key={entry.key}
                                  assetId={entry.assetId}
                                  symbol={entry.symbol}
                                  icon={entry.icon}
                                  size={16}
                                  className={index ? '-ml-1 shrink-0' : 'shrink-0'}
                                />
                              ))}
                        </span>
                        <span
                          className="max-w-[100px] truncate"
                          title={balancesHidden ? undefined : label}
                        >
                          {zcashNeedsEnable ? '—' : label}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              )
            })}
          {(
            [
              ['ZAMA', zamaLogo],
              ['Privacy Pools', privacyPoolsLogo]
            ] as const
          ).map(([name, icon]) => (
            <div
              key={name}
              className="flex h-[154px] min-w-0 flex-col items-center justify-between rounded-lg bg-wallet-surface px-2 pb-3 pt-6 text-center"
            >
              <img
                src={icon}
                alt=""
                aria-hidden="true"
                width={36}
                height={36}
                className="rounded-md brightness-50"
              />
              <span className="text-sm font-medium">{name}</span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] text-muted">
                Coming soon
              </span>
            </div>
          ))}
        </div>
        <section aria-labelledby="shield-explanation" className="mt-8">
          <h2 id="shield-explanation" className="text-sm text-wallet-secondary">
            How Shielded Works?
          </h2>
          <div className="mt-5 space-y-7">
            {[
              {
                icon: 'noir:shield-assets',
                title: 'Held by the route, not Noir',
                description:
                  'When you shield, your funds move to the route you pick. That route’s protocol holds them, not Noir.'
              },
              {
                icon: 'lucide:lock',
                title: 'Only you can move them',
                description: 'Only your account can send, swap or move them.'
              },
              {
                icon: 'lucide:globe',
                title: 'Breaks the on-chain link',
                description:
                  'Funds that go through Shield are no longer linked to your Public address.'
              },
              {
                icon: 'lucide:list',
                title: 'Each route has trade-offs',
                description:
                  'Before you move in or receive, check what it supports, how fast and costly it is, and who runs it.'
              }
            ].map(item => (
              <div key={item.title} className="flex items-start gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-success/15 text-success">
                  <Icon icon={item.icon} width={19} height={19} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold leading-5">{item.title}</h3>
                  <p className="mt-2 text-xs leading-4 text-wallet-secondary">{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <Dialog open={pendingAction !== null} onOpenChange={open => !open && setPendingAction(null)}>
        <DialogContent position="bottom" className="gap-2 bg-wallet-surface p-4 pb-6">
          <DialogTitle className="text-base font-medium capitalize">
            {pendingAction}{' '}
            {pendingAction === 'receive' ? 'with' : pendingAction === 'send' ? 'from' : 'in'}
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
    </div>
  )
}
