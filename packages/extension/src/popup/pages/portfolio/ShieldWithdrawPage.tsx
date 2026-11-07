import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { isAddress } from 'viem'
import { resolveEvmChainIconAlias } from '@/config/icons'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { SwapToken } from '@/core/services/intents-api'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  formatTokenQuantity
} from '@/lib/number-format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { useWalletStore } from '@/store/wallet-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { useNavigate } from '@/popup/provider/Router'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import {
  TransactionReviewExchangeSummary,
  TransactionReviewView
} from '@/popup/components/transaction/TransactionReviewView'
import { Button } from '@/popup/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import {
  confidentialFundingClient,
  type ConfidentialBalance,
  type PrepareConfidentialFundingRequest
} from '@/popup/services/confidential-funding-client'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import {
  buildExternalShieldWithdrawRequest,
  hasShieldTransferStarted,
  isUnsignedShieldTerminal,
  matchesExternalShieldWithdrawReview,
  listShieldFundingAssets,
  shieldPortfolioBalances,
  shieldFundingAvailableRaw,
  shieldFundingSources,
  selectShieldWithdrawDestinationForNetwork,
  type ShieldFundingAsset
} from '@/popup/services/shield-transfer'
import {
  normalizePrivateBalanceTransferInput,
  resolvePrivateBalanceTransferAmount
} from '@/popup/services/private-balance-transfer'

function withdrawChainIconAlias(chain: ShieldFundingAsset['chain']['chain']): string {
  return chain.family === 'evm'
    ? resolveEvmChainIconAlias(chain.id)
    : resolveChainIconAlias(chain.family, chain.displayName)
}

export function ShieldWithdrawPage() {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  return <ShieldWithdrawForm key={`${network}:${walletId}:${accountId}`} />
}

function ShieldWithdrawForm() {
  const [params] = useSearchParams()
  const { navigate } = useNavigate()
  const providerIsNear =
    params.get('provider') === null || params.get('provider') === 'near-confidential'
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const { activeAccount } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const canManageNear =
    providerIsNear && getPrivateTransferChainIds(activeAccount, network === 'mainnet').length > 0
  const { model, refresh } = useHomePortfolio(account?.walletId ?? null, account?.accountId ?? null)
  const scopeKey = `${network}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`
  const latestScope = useRef(scopeKey)
  latestScope.current = scopeKey
  const mounted = useRef(false)
  const [catalogTokens, setCatalogTokens] = useState<readonly SwapToken[]>([])
  const [managedAssets, setManagedAssets] = useState<readonly IntentsManagedAsset[]>([])
  const [balances, setBalances] = useState<readonly ConfidentialBalance[] | null>(null)
  const [balanceScope, setBalanceScope] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [sourceId, setSourceId] = useState(params.get('assetId') ?? '')
  const [destinationId, setDestinationId] = useState('')
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [slippageBps, setSlippageBps] = useState(50)
  const [picker, setPicker] = useState<'source' | 'destination' | 'network' | 'recipient' | null>(
    null
  )
  const [prepared, setPrepared] = useState<Readonly<{
    review: ConfidentialFundingReview
    request: PrepareConfidentialFundingRequest
    source: ShieldFundingAsset
    destination: ShieldFundingAsset
    amount: string
  }> | null>(null)
  const [busy, setBusy] = useState(false)
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
    setSourceId(params.get('assetId') ?? '')
    setDestinationId('')
    setAmount('')
    setRecipient('')
    setSlippageBps(50)
    setPicker(null)
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
          setCatalogTokens(cached)
          setManagedAssets(resolveManagedIntentsCatalog(cached))
        }
        const refreshed = await swapTokenCatalogClient.refresh()
        if (active) {
          setCatalogTokens(refreshed)
          setManagedAssets(resolveManagedIntentsCatalog(refreshed))
        }
      } catch {
        // Cached portfolio remains visible while the token catalog is unavailable.
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
    () => listShieldFundingAssets(model, managedAssets, catalogTokens, network),
    [model, managedAssets, catalogTokens, network]
  )
  const destinations = options.filter(item => item.chain.chain.family === 'evm')
  const currentBalances = balanceScope === scopeKey ? balances : null
  const displayBalances = currentBalances ?? shieldPortfolioBalances(model)
  const sources = shieldFundingSources(options, displayBalances)
  const source = sources.find(item => item.asset.asset.id === sourceId) ?? sources[0] ?? null
  const destination =
    destinations.find(item => item.asset.asset.id === destinationId) ??
    destinations.find(item => item.asset.asset.id === source?.asset.asset.id) ??
    destinations[0] ??
    null
  const availableRaw = shieldFundingAvailableRaw(source, displayBalances)
  const amountState = source
    ? resolvePrivateBalanceTransferAmount({
        amount,
        decimals: source.asset.metadata.decimals,
        availableRaw,
        sourceLabel: 'Shield'
      })
    : null
  const recipientValid = isAddress(recipient.trim()) && !/^0x0{40}$/i.test(recipient.trim())

  const scopeStillCurrent = () => {
    const wallet = useWalletStore.getState()
    return (
      mounted.current &&
      latestScope.current === scopeKey &&
      wallet.currentWalletId === currentWalletId &&
      wallet.currentAccountId === currentAccountId &&
      wallet.currentNetwork === network
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
      !source ||
      !destination ||
      !amountState?.amountRaw ||
      !recipientValid ||
      busy ||
      !scopeStillCurrent()
    )
      return
    setBusy(true)
    setError(null)
    try {
      const request = buildExternalShieldWithdrawRequest({
        network,
        keyDomainId: account.walletId,
        accountId: account.accountId,
        amountRaw: amountState.amountRaw,
        recipient: recipient.trim(),
        source,
        destination,
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
      if (!matchesExternalShieldWithdrawReview(review, request)) {
        void confidentialFundingClient.cancel(review.planId).catch(() => {})
        throw new Error('Send review changed. Try again.')
      }
      confirmationAttempt.current = null
      setUncertain(false)
      setPrepared({ review, request, source, destination, amount })
    } catch (cause) {
      if (scopeStillCurrent())
        setError(cause instanceof Error ? cause.message : 'Send quote unavailable')
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
      setError('Send was not started. Try again.')
      return 'failed'
    }
    return plan.phase === 'prepared' ? 'prepared' : 'pending'
  }
  const cancelReview = async () => {
    if (!prepared || busy || !scopeStillCurrent()) return
    setBusy(true)
    try {
      if (confirmationAttempt.current === prepared.review.planId) {
        const state = await inspectPlan(prepared.review.planId)
        if (state !== 'prepared') return
      }
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
          setError('Send was not started. Review and try again.')
        }
        return
      }
      if (prepared.review.expiresAt <= Date.now())
        throw new Error('Send quote expired. Review again.')
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
          setError(cause instanceof Error ? cause.message : 'Send could not start')
        } else if (state === 'pending') {
          setUncertain(true)
          setError('Send status is pending. Check status before trying again.')
        }
      } catch {
        if (scopeStillCurrent()) {
          setUncertain(true)
          setError('Send status unavailable. Check status before trying again.')
        }
      }
    } finally {
      if (scopeStillCurrent()) setBusy(false)
    }
  }

  if (activeAccount && !canManageNear) {
    return (
      <div className="page-container">
        <PageHeader title="Send" showBack />
        <p role="alert" className="px-4 py-6 text-center text-sm text-muted">
          Shield unavailable for this account
        </p>
      </div>
    )
  }

  if (prepared) {
    const output = formatBaseUnitDecimalAmount(
      prepared.review.expectedOutputRaw,
      prepared.destination.asset.metadata.decimals
    )
    const minimum = formatBaseUnitAmount(
      prepared.review.minimumOutputRaw,
      prepared.destination.asset.metadata.decimals
    )
    return (
      <div className="page-container">
        <TransactionReviewView
          variant="figma"
          title="Confirm Send"
          asset={{
            assetId: prepared.source.asset.asset.id,
            symbol: prepared.source.asset.metadata.symbol,
            icon: prepared.source.asset.metadata.iconUrl
          }}
          amount={prepared.amount}
          network={prepared.destination.chain.chain.displayName}
          summary={
            <TransactionReviewExchangeSummary
              source={{
                asset: {
                  assetId: prepared.source.asset.asset.id,
                  symbol: prepared.source.asset.metadata.symbol,
                  icon: prepared.source.asset.metadata.iconUrl
                },
                amount: prepared.amount
              }}
              destination={{
                asset: {
                  assetId: prepared.destination.asset.asset.id,
                  symbol: prepared.destination.asset.metadata.symbol,
                  icon: prepared.destination.asset.metadata.iconUrl
                },
                amount: output
              }}
            />
          }
          rows={[
            {
              label: 'Network',
              content: (
                <span className="inline-flex items-center gap-1.5">
                  <ChainIcon
                    chain={withdrawChainIconAlias(prepared.destination.chain.chain)}
                    width={16}
                    height={16}
                    className="shrink-0 rounded-sm"
                  />
                  {prepared.destination.chain.chain.displayName}
                </span>
              )
            },
            { label: 'Recipient', content: prepared.review.destinationAddress },
            {
              label: 'Minimum receive',
              content: (
                <AmountDisplay
                  value={minimum}
                  symbol={prepared.destination.asset.metadata.symbol}
                />
              )
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
      <PageHeader title="Send" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-6">
        <div className="flex flex-col items-center pb-7">
          <input
            aria-label="Send amount"
            disabled={busy}
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={event => {
              const next = normalizePrivateBalanceTransferInput(event.target.value)
              if (next !== null) setAmount(next)
            }}
            className="w-full bg-transparent text-center text-[38px] font-semibold outline-none placeholder:text-muted"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => setPicker('source')}
            className="wallet-interactive mt-3 flex items-center gap-2 rounded-lg bg-wallet-surface px-3 py-2 text-sm enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
          >
            {source && (
              <TokenIcon
                assetId={source.asset.asset.id}
                symbol={source.asset.metadata.symbol}
                icon={source.asset.metadata.iconUrl}
                size={24}
              />
            )}
            {source?.asset.metadata.symbol ?? 'Token'}
            <Icon icon="lucide:chevron-down" width={16} height={16} />
          </button>
          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted">
            <span
              className="min-w-0 truncate"
              title={
                source
                  ? formatBaseUnitDecimalAmount(availableRaw, source.asset.metadata.decimals)
                  : '0'
              }
            >
              {source
                ? formatTokenQuantity(
                    formatBaseUnitDecimalAmount(availableRaw, source.asset.metadata.decimals)
                  )
                : '0'}{' '}
              available
            </span>
            <button
              type="button"
              disabled={busy || connecting || !source || !currentBalances || availableRaw === '0'}
              title={!currentBalances ? 'Connect Shield to use Max' : 'Use maximum balance'}
              onClick={() =>
                source &&
                setAmount(formatBaseUnitDecimalAmount(availableRaw, source.asset.metadata.decimals))
              }
              className="wallet-interactive shrink-0 rounded bg-wallet-surface px-2 py-0.5 text-foreground enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
            >
              Max
            </button>
          </div>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => setPicker('destination')}
          className="wallet-interactive mb-3 flex w-full items-center gap-3 rounded-lg bg-wallet-surface p-3 text-left enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
        >
          {destination && (
            <TokenIcon
              assetId={destination.asset.asset.id}
              symbol={destination.asset.metadata.symbol}
              icon={destination.asset.metadata.iconUrl}
              size={32}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted">Token</span>
            <span className="block truncate text-sm">
              {destination?.asset.metadata.symbol ?? 'Select token'}
            </span>
          </span>
          <Icon icon="lucide:chevron-down" width={17} height={17} />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setPicker('network')}
          className="wallet-interactive mb-3 flex w-full items-center gap-3 rounded-lg bg-wallet-surface p-3 text-left enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
        >
          {destination ? (
            <ChainIcon
              chain={withdrawChainIconAlias(destination.chain.chain)}
              width={32}
              height={32}
              className="shrink-0 rounded-md"
            />
          ) : (
            <Icon icon="lucide:globe" width={32} height={32} className="shrink-0 text-muted" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted">Network</span>
            <span className="block truncate text-sm">
              {destination?.chain.chain.displayName ?? 'Select network'}
            </span>
          </span>
          <Icon icon="lucide:chevron-down" width={17} height={17} />
        </button>
        <div className="mb-3 flex w-full items-center gap-3 rounded-lg bg-wallet-surface p-3">
          <Icon icon="lucide:wallet" width={27} height={27} className="shrink-0 text-muted" />
          <label className="min-w-0 flex-1">
            <span className="block text-xs text-muted">Recipient</span>
            <input
              aria-label="Recipient address"
              disabled={busy}
              value={recipient}
              onChange={event => setRecipient(event.target.value)}
              placeholder="Enter address"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </label>
          <button
            type="button"
            aria-label="Choose recipient"
            title="Choose recipient"
            disabled={busy || !destination}
            onClick={() => setPicker('recipient')}
            className="wallet-interactive shrink-0 rounded-md text-muted enabled:hover:bg-white/10 enabled:hover:text-foreground enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
          >
            <Icon icon="lucide:contact-round" width={19} height={19} />
          </button>
        </div>
        <div className="rounded-lg border border-border/70 px-3 py-1 text-sm">
          <label className="flex items-center justify-between py-3">
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
        </div>
        {amountState?.error && (
          <p role="alert" className="mt-3 text-xs text-warning">
            {amountState.error}
          </p>
        )}
        {recipient && !recipientValid && (
          <p role="alert" className="mt-3 text-xs text-warning">
            Enter a valid EVM address
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-warning">
            {error}
          </p>
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
          disabled={
            !canManageNear ||
            !currentBalances ||
            !source ||
            !destination ||
            !amountState?.amountRaw ||
            !recipientValid
          }
          onClick={() => void prepare()}
        >
          Send
        </Button>
      </div>
      <Dialog open={picker !== null} onOpenChange={open => !open && setPicker(null)}>
        <DialogContent
          position="bottom"
          className="max-h-[80vh] min-h-0 overflow-y-auto bg-wallet-surface p-4 pb-6"
        >
          <DialogTitle>
            {picker === 'source'
              ? 'Source token'
              : picker === 'destination'
                ? 'Receive token'
                : picker === 'network'
                  ? 'Network'
                  : 'Recipient'}
          </DialogTitle>
          <DialogDescription className="sr-only">Choose a withdrawal {picker}</DialogDescription>
          {picker === 'recipient' && destination ? (
            <RecipientSelector
              chainId={destination.chain.chain.id}
              includeCurrentAccount
              onSelect={address => {
                setRecipient(address)
                setPicker(null)
              }}
            />
          ) : picker === 'network' ? (
            [...new Map(destinations.map(item => [item.chain.chain.id, item])).values()].map(
              item => (
                <button
                  key={item.chain.chain.id}
                  type="button"
                  aria-pressed={destination?.chain.chain.id === item.chain.chain.id}
                  onClick={() => {
                    const next = selectShieldWithdrawDestinationForNetwork(
                      destinations,
                      destination,
                      item.chain.chain.id
                    )
                    if (next && next.asset.asset.id !== destination?.asset.asset.id) {
                      setDestinationId(next.asset.asset.id)
                      setRecipient('')
                    }
                    setPicker(null)
                  }}
                  className={`wallet-interactive flex w-full items-center gap-3 rounded-md px-2 py-3 text-left text-sm hover:bg-wallet-selected active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 ${destination?.chain.chain.id === item.chain.chain.id ? 'bg-wallet-selected' : ''}`}
                >
                  <ChainIcon
                    chain={withdrawChainIconAlias(item.chain.chain)}
                    width={28}
                    height={28}
                    className="shrink-0 rounded-md"
                  />
                  <span className="min-w-0 flex-1 truncate">{item.chain.chain.displayName}</span>
                  {destination?.chain.chain.id === item.chain.chain.id && (
                    <Icon icon="lucide:check" width={17} height={17} className="text-primary" />
                  )}
                </button>
              )
            )
          ) : (
            (picker === 'source'
              ? sources
              : destinations.filter(item => item.chain.chain.id === destination?.chain.chain.id)
            ).map(item => (
              <button
                key={item.asset.asset.id}
                type="button"
                onClick={() => {
                  if (picker === 'source') {
                    setSourceId(item.asset.asset.id)
                    setAmount('')
                  } else setDestinationId(item.asset.asset.id)
                  setPicker(null)
                }}
                className="wallet-interactive flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-wallet-selected active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
              >
                <TokenIcon
                  assetId={item.asset.asset.id}
                  symbol={item.asset.metadata.symbol}
                  icon={item.asset.metadata.iconUrl}
                  size={30}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {item.asset.metadata.symbol}
                </span>
                <span className="max-w-[45%] truncate text-xs text-muted">
                  {item.chain.chain.displayName}
                </span>
              </button>
            ))
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
