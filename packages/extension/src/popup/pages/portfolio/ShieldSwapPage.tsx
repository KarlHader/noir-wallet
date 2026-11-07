import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { SwapToken } from '@/core/services/intents-api'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  formatTokenQuantity
} from '@/lib/number-format'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { useNavigate } from '@/popup/provider/Router'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import {
  TransactionReviewExchangeSummary,
  TransactionReviewView
} from '@/popup/components/transaction/TransactionReviewView'
import { Button } from '@/popup/components/ui/button'
import { Input } from '@/popup/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import {
  confidentialFundingClient,
  type ConfidentialBalance,
  type PrepareConfidentialFundingRequest
} from '@/popup/services/confidential-funding-client'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import {
  hasShieldTransferStarted,
  isUnsignedShieldTerminal,
  listShieldFundingAssets,
  shieldPortfolioBalances,
  shieldFundingSources,
  type ShieldFundingAsset
} from '@/popup/services/shield-transfer'
import {
  buildShieldSwapRequest,
  matchesShieldSwapReview,
  shieldSwapFormAmountError,
  shieldSwapFormBalance
} from '@/popup/services/shield-swap-form'

export function ShieldSwapPage() {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  return <ShieldSwapForm key={`${network}:${walletId}:${accountId}`} />
}

function ShieldSwapForm() {
  const [params] = useSearchParams()
  const { navigate } = useNavigate()
  const providerIsNear =
    params.get('provider') === null || params.get('provider') === 'near-confidential'
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const { activeAccount } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId: walletId,
    currentAccountId: accountId,
    nativeAccount: activeAccount
  })
  const canManageNear =
    providerIsNear && getPrivateTransferChainIds(activeAccount, network === 'mainnet').length > 0
  const scopeKey = `${network}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`
  const latestScope = useRef(scopeKey)
  latestScope.current = scopeKey
  const mounted = useRef(false)
  const { model, status, refresh } = useHomePortfolio(
    account?.walletId ?? null,
    account?.accountId ?? null
  )
  const hidden = useSettingsStore(state => state.balancesHidden)
  const [tokens, setTokens] = useState<readonly SwapToken[]>([])
  const [managedAssets, setManagedAssets] = useState<readonly IntentsManagedAsset[]>([])
  const [balances, setBalances] = useState<readonly ConfidentialBalance[] | null>(null)
  const [balanceScope, setBalanceScope] = useState('')
  const [fromId, setFromId] = useState<string | null>(params.get('assetId'))
  const [toId, setToId] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(50)
  const [picker, setPicker] = useState<'from' | 'to' | null>(null)
  const [search, setSearch] = useState('')
  const [prepared, setPrepared] = useState<Readonly<{
    review: ConfidentialFundingReview
    request: PrepareConfidentialFundingRequest
    from: ShieldFundingAsset
    to: ShieldFundingAsset
    amount: string
  }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmationAttempt = useRef<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!providerIsNear) navigate('/shield-funds', { replace: true })
  }, [providerIsNear, navigate])

  useEffect(() => {
    setFromId(params.get('assetId'))
    setToId(null)
    setAmount('')
    setSlippageBps(50)
    setPicker(null)
    setSearch('')
    setPrepared(null)
    setBusy(false)
    setConnecting(false)
    setUncertain(false)
    setError(null)
    confirmationAttempt.current = null
  }, [scopeKey])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const cached = await swapTokenCatalogClient.readCached()
        if (active && cached.length) {
          setTokens(cached)
          setManagedAssets(resolveManagedIntentsCatalog(cached))
        }
        const refreshed = await swapTokenCatalogClient.refresh()
        if (active) {
          setTokens(refreshed)
          setManagedAssets(resolveManagedIntentsCatalog(refreshed))
        }
      } catch {
        /* The cached catalog remains available. */
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [network])

  useEffect(() => {
    let active = true
    setBalances(null)
    setBalanceScope('')
    if (!account || !canManageNear) return
    void confidentialFundingClient
      .refreshBalances(
        {
          network,
          keyDomainId: account.walletId,
          accountId: account.accountId
        },
        false
      )
      .then(value => {
        if (active) {
          setBalances(value)
          setBalanceScope(scopeKey)
          void refresh(true)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [scopeKey, canManageNear])

  const options = useMemo(
    () => listShieldFundingAssets(model, managedAssets, tokens, network),
    [model, managedAssets, tokens, network]
  )
  const currentBalances = balanceScope === scopeKey ? balances : null
  const displayBalances = currentBalances ?? shieldPortfolioBalances(model)
  const sources = shieldFundingSources(options, displayBalances)
  const from = sources.find(asset => asset.asset.asset.id === fromId) ?? sources[0] ?? null
  const to =
    options.find(asset => asset.asset.asset.id === toId) ??
    options.find(asset => asset.managed.protocolAssetId !== from?.managed.protocolAssetId) ??
    null
  const balance = shieldSwapFormBalance(from, displayBalances)
  const currentBalance = shieldSwapFormBalance(from, currentBalances)
  const amountError = shieldSwapFormAmountError(amount, from, displayBalances)
  const validAmount = Boolean(amount && from && currentBalances && !amountError)
  const pickable = (picker === 'from' ? sources : options).filter(
    asset =>
      asset.managed.protocolAssetId !==
        (picker === 'from' ? to?.managed.protocolAssetId : from?.managed.protocolAssetId) &&
      `${asset.asset.metadata.symbol} ${asset.asset.metadata.name} ${asset.chain.chain.displayName}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
  )
  const scopeStillCurrent = () => {
    const state = useWalletStore.getState()
    return (
      mounted.current &&
      latestScope.current === scopeKey &&
      state.currentWalletId === walletId &&
      state.currentAccountId === accountId &&
      state.currentNetwork === network
    )
  }
  const openActivity = (transactionId: string) => {
    if (scopeStillCurrent())
      navigate(`/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`)
  }
  const refreshBalances = async () => {
    if (!account || !canManageNear || connecting || !scopeStillCurrent()) return
    setConnecting(true)
    setError(null)
    try {
      const value = await confidentialFundingClient.refreshBalances(
        {
          network,
          keyDomainId: account.walletId,
          accountId: account.accountId
        },
        true
      )
      if (scopeStillCurrent()) {
        setBalances(value)
        setBalanceScope(scopeKey)
        void refresh(true)
      }
    } catch (cause) {
      if (scopeStillCurrent())
        setError(cause instanceof Error ? cause.message : 'Shield balance unavailable')
    } finally {
      if (scopeStillCurrent()) setConnecting(false)
    }
  }
  const prepare = async () => {
    if (
      !account ||
      !canManageNear ||
      !from ||
      !to ||
      !currentBalances ||
      !validAmount ||
      busy ||
      !scopeStillCurrent()
    )
      return
    setBusy(true)
    setError(null)
    try {
      const request = buildShieldSwapRequest({
        network,
        keyDomainId: account.walletId,
        accountId: account.accountId,
        from,
        to,
        amount,
        balances: currentBalances,
        slippageBps
      })
      const review = await confidentialFundingClient.prepare(request)
      if (!scopeStillCurrent()) {
        if (review.phase === 'prepared')
          void confidentialFundingClient.cancel(review.planId).catch(() => {})
        return
      }
      if (review.phase !== 'prepared') {
        openActivity(review.transactionId)
        return
      }
      if (!matchesShieldSwapReview(review, request)) {
        void confidentialFundingClient.cancel(review.planId).catch(() => {})
        throw new Error('Swap review changed. Try again.')
      }
      confirmationAttempt.current = null
      setUncertain(false)
      setPrepared({ review, request, from, to, amount })
    } catch (cause) {
      if (scopeStillCurrent())
        setError(cause instanceof Error ? cause.message : 'Swap quote unavailable')
    } finally {
      if (scopeStillCurrent()) setBusy(false)
    }
  }
  const inspectPlan = async (planId: string) => {
    const plan = await confidentialFundingClient.get(planId)
    if (!scopeStillCurrent()) return 'changed'
    if (hasShieldTransferStarted(plan)) {
      openActivity(plan.transactionId)
      return 'started'
    }
    if (isUnsignedShieldTerminal(plan)) {
      setPrepared(null)
      setUncertain(false)
      setError('Swap was not started. Try again.')
      return 'failed'
    }
    return plan.phase === 'prepared' ? 'prepared' : 'pending'
  }
  const cancelReview = async () => {
    if (!prepared || busy || !scopeStillCurrent()) return
    setBusy(true)
    try {
      if (
        confirmationAttempt.current === prepared.review.planId &&
        (await inspectPlan(prepared.review.planId)) !== 'prepared'
      )
        return
      await confidentialFundingClient.cancel(prepared.review.planId)
      if (!scopeStillCurrent()) return
      setPrepared(null)
      setUncertain(false)
    } catch (cause) {
      if (scopeStillCurrent())
        setError(cause instanceof Error ? cause.message : 'Unable to cancel review')
    } finally {
      if (scopeStillCurrent()) setBusy(false)
    }
  }
  const confirm = async () => {
    if (!prepared || busy || !canManageNear || !scopeStillCurrent()) return
    setBusy(true)
    setError(null)
    try {
      if (uncertain) {
        const state = await inspectPlan(prepared.review.planId)
        if (!scopeStillCurrent()) return
        if (state === 'prepared') {
          setUncertain(false)
          setError('Swap was not started. Review and try again.')
        }
        return
      }
      if (prepared.review.expiresAt <= Date.now())
        throw new Error('Swap quote expired. Review again.')
      confirmationAttempt.current = prepared.review.planId
      const plan = await confidentialFundingClient.confirm(
        prepared.review.planId,
        prepared.review.payloadFingerprint
      )
      if (hasShieldTransferStarted(plan)) openActivity(plan.transactionId)
      else await inspectPlan(plan.planId)
    } catch (cause) {
      try {
        const state = await inspectPlan(prepared.review.planId)
        if (!scopeStillCurrent()) return
        if (state === 'prepared') {
          setUncertain(false)
          setError(cause instanceof Error ? cause.message : 'Swap could not start')
        } else if (state === 'pending') {
          setUncertain(true)
          setError('Swap status is pending. Check status before trying again.')
        }
      } catch {
        if (scopeStillCurrent()) {
          setUncertain(true)
          setError('Swap status unavailable. Check status before trying again.')
        }
      }
    } finally {
      if (scopeStillCurrent()) setBusy(false)
    }
  }

  if (activeAccount && !canManageNear) {
    return (
      <div className="page-container">
        <PageHeader title="Swap" showBack />
        <p role="alert" className="px-4 py-6 text-center text-sm text-muted">
          Shield unavailable for this account
        </p>
      </div>
    )
  }

  if (prepared) {
    const output = formatBaseUnitDecimalAmount(
      prepared.review.expectedOutputRaw,
      prepared.to.asset.metadata.decimals
    )
    const minimum = formatBaseUnitAmount(
      prepared.review.minimumOutputRaw,
      prepared.to.asset.metadata.decimals
    )
    const fee = prepared.review.quoteWithdrawFeeRaw ?? '0'
    const feeAmount = formatBaseUnitAmount(fee, prepared.to.asset.metadata.decimals)
    return (
      <div className="page-container">
        <TransactionReviewView
          variant="figma"
          title="Confirm Swap"
          asset={{
            assetId: prepared.from.asset.asset.id,
            symbol: prepared.from.asset.metadata.symbol,
            icon: prepared.from.asset.metadata.iconUrl
          }}
          amount={prepared.amount}
          network=""
          summary={
            <TransactionReviewExchangeSummary
              source={{
                asset: {
                  assetId: prepared.from.asset.asset.id,
                  symbol: prepared.from.asset.metadata.symbol,
                  icon: prepared.from.asset.metadata.iconUrl
                },
                amount: prepared.amount
              }}
              destination={{
                asset: {
                  assetId: prepared.to.asset.asset.id,
                  symbol: prepared.to.asset.metadata.symbol,
                  icon: prepared.to.asset.metadata.iconUrl
                },
                amount: output
              }}
            />
          }
          rows={[
            {
              label: 'Minimum receive',
              content: <AmountDisplay value={minimum} symbol={prepared.to.asset.metadata.symbol} />
            },
            {
              label: 'Service fee',
              content: `${((prepared.review.quoteAppFeeBps ?? 0) / 100).toString()}%`
            },
            {
              label: 'Fees',
              content: (
                <AmountDisplay
                  value={feeAmount}
                  symbol={prepared.to.asset.metadata.symbol}
                  profile="fee"
                />
              )
            },
            {
              label: 'Slippage',
              content: `${((prepared.review.slippageBps ?? 0) / 100).toString()}%`
            },
            ...(prepared.review.quoteTimeEstimateSeconds === undefined
              ? []
              : [
                  {
                    label: 'Estimated time',
                    content: `${prepared.review.quoteTimeEstimateSeconds} sec`
                  }
                ])
          ]}
          error={
            error ? (
              <p role="alert" className="mt-3 text-sm text-warning">
                {error}
              </p>
            ) : undefined
          }
          confirmLabel={uncertain ? 'Check status' : 'Confirm'}
          confirming={busy}
          onCancel={() => void cancelReview()}
          onConfirm={() => void confirm()}
        />
      </div>
    )
  }

  return (
    <div className="page-container min-h-0 overflow-hidden">
      <PageHeader title="Swap" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <section className="pb-6 pt-4" aria-label="Swap from Shield">
          <div className="flex items-center justify-between text-sm text-muted">
            <span>From</span>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span
                className="max-w-[180px] truncate"
                title={hidden ? undefined : (balance ?? undefined)}
              >
                Bal. {hidden ? '••••' : formatTokenQuantity(balance)}
              </span>
              <button
                type="button"
                className="wallet-interactive rounded text-foreground enabled:hover:bg-white/10 enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-40"
                disabled={busy || connecting || currentBalance === null || currentBalance === '0'}
                title={!currentBalances ? 'Connect Shield to use Max' : 'Use maximum balance'}
                onClick={() => currentBalance !== null && setAmount(currentBalance)}
              >
                Max
              </button>
            </span>
          </div>
          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSearch('')
                setPicker('from')
              }}
              className="wallet-interactive flex min-w-0 shrink-0 items-center gap-2 rounded-lg text-lg font-medium enabled:hover:bg-white/5 enabled:active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-40"
              aria-label="Select source Shield token"
            >
              {from && (
                <TokenIcon
                  assetId={from.asset.asset.id}
                  symbol={from.asset.metadata.symbol}
                  icon={from.asset.metadata.iconUrl}
                  size={32}
                />
              )}
              <span className="max-w-[110px] truncate">
                {from?.asset.metadata.symbol ?? 'Select token'}
              </span>
              <Icon icon="lucide:chevron-down" width={14} />
            </button>
            <input
              value={amount}
              onChange={event => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              aria-label="Shield swap amount"
              aria-invalid={Boolean(amountError)}
              disabled={busy || !from}
              className="min-w-0 flex-1 bg-transparent text-right text-2xl font-medium outline-none placeholder:text-muted disabled:opacity-50"
            />
          </div>
          {amountError && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {amountError}
            </p>
          )}
        </section>
        <div className="relative -mx-4 flex h-8 items-center justify-center before:absolute before:inset-x-0 before:border-t before:border-white/10">
          <button
            type="button"
            aria-label="Reverse Shield swap tokens"
            disabled={busy || !from || !to}
            onClick={() => {
              setFromId(toId)
              setToId(fromId)
              setAmount('')
            }}
            className="wallet-interactive relative rounded-lg bg-wallet-surface p-1.5 enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-40"
          >
            <Icon icon="lucide:arrow-down-up" width={22} />
          </button>
        </div>
        <section className="pb-6 pt-3" aria-label="Swap to Shield">
          <p className="text-sm text-muted">To</p>
          <div className="mt-5 flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSearch('')
                setPicker('to')
              }}
              className="wallet-interactive flex min-w-0 items-center gap-2 rounded-lg text-lg font-medium enabled:hover:bg-white/5 enabled:active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-40"
              aria-label="Select destination Shield token"
            >
              {to && (
                <TokenIcon
                  assetId={to.asset.asset.id}
                  symbol={to.asset.metadata.symbol}
                  icon={to.asset.metadata.iconUrl}
                  size={32}
                />
              )}
              <span className="truncate">{to?.asset.metadata.symbol ?? 'Select token'}</span>
              <Icon icon="lucide:chevron-down" width={14} />
            </button>
            <span className="text-2xl font-medium text-muted" aria-label="Output quote pending">
              —
            </span>
          </div>
        </section>
        <label className="flex items-center justify-between border-t border-border/60 py-3 text-sm">
          <span className="text-muted">Slippage</span>
          <select
            aria-label="Slippage"
            disabled={busy}
            value={slippageBps}
            onChange={event => setSlippageBps(Number(event.target.value))}
            className="bg-transparent text-right outline-none"
          >
            <option value={10}>0.1%</option>
            <option value={50}>0.5%</option>
            <option value={100}>1%</option>
          </select>
        </label>
        {error && (
          <p role="alert" className="mt-3 text-xs text-warning">
            {error}
          </p>
        )}
        {status === 'error' && (
          <Button variant="ghost" onClick={() => void refresh(true)} className="w-full">
            Refresh Shield balances
          </Button>
        )}
        {!currentBalances && (
          <Button
            variant="outline"
            size="wallet"
            isLoading={connecting}
            disabled={!canManageNear}
            onClick={() => void refreshBalances()}
            className="mt-4 w-full"
          >
            Connect Shield
          </Button>
        )}
      </div>
      <div className="page-footer">
        <Button
          size="wallet"
          className="w-full"
          isLoading={busy}
          disabled={!canManageNear || !currentBalances || !from || !to || !validAmount || busy}
          onClick={() => void prepare()}
        >
          Swap
        </Button>
      </div>
      <Dialog open={picker !== null} onOpenChange={open => !open && setPicker(null)}>
        <DialogContent
          position="bottom"
          className="flex max-h-[85dvh] flex-col gap-3 bg-wallet-surface p-4"
        >
          <DialogTitle>Select token</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a token in NEAR Confidential
          </DialogDescription>
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search tokens"
            aria-label="Search Shield tokens"
          />
          <div className="min-h-0 overflow-y-auto">
            {pickable.map(asset => (
              <button
                type="button"
                key={asset.asset.asset.id}
                onClick={() => {
                  if (picker === 'from') {
                    setFromId(asset.asset.asset.id)
                    setAmount('')
                  } else setToId(asset.asset.asset.id)
                  setPicker(null)
                }}
                className="wallet-interactive flex min-h-14 w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-wallet-selected active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
              >
                <TokenIcon
                  assetId={asset.asset.asset.id}
                  symbol={asset.asset.metadata.symbol}
                  icon={asset.asset.metadata.iconUrl}
                  size={32}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{asset.asset.metadata.symbol}</span>
                  <span className="block truncate text-xs text-muted">
                    {asset.chain.chain.displayName}
                  </span>
                </span>
                <span
                  className="max-w-[120px] truncate text-sm"
                  title={
                    hidden
                      ? undefined
                      : (shieldSwapFormBalance(asset, displayBalances) ?? undefined)
                  }
                >
                  {hidden
                    ? '••••'
                    : formatTokenQuantity(shieldSwapFormBalance(asset, displayBalances))}
                </span>
              </button>
            ))}
            {!pickable.length && (
              <p className="py-8 text-center text-sm text-muted">
                {status === 'loading' ? 'Loading Shield tokens…' : 'No Shield tokens found'}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
