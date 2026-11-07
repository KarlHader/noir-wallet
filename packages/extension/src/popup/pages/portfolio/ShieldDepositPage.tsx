import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { QRCodeSVG } from 'qrcode.react'
import { resolveEvmChainIconAlias } from '@/config/icons'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveSwapTokenIconUrl } from '@/core/services/intents-api'
import {
  hasExternalShieldDepositFunding,
  isExternalShieldDepositAutoHidden,
  shouldAutoRefreshExternalShieldDeposit
} from '@/core/services/confidential-funding/confidential-external-deposit'
import type { ChainDefinition } from '@/core/chains/registry'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { formatBridgeMinimumAmountError } from '@/popup/services/quote-minimum-error'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import {
  availableDepositTokens,
  canPayShieldDeposit,
  defaultDepositRefundAddress,
  depositAmountError,
  depositAmountRaw,
  depositPaymentProgress,
  depositRefundAddressError,
  depositSourceAssetId,
  depositSourceNetworks,
  depositStatusLabel,
  formatDepositAmount,
  depositTokenChainId
} from '@/popup/services/shield-deposit-options'
import {
  externalShieldDepositClient,
  type ExternalShieldDeposit
} from '@/popup/services/confidential-funding-client'
import { useWalletStore } from '@/store/wallet-store'
import { useNavigate } from '@/popup/provider/Router'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenSelector } from '@/popup/components/tokens/TokenSelector'
import {
  ShieldProviderLogo,
  SHIELD_PROVIDERS
} from '@/popup/components/portfolio/ShieldPortfolioView'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import { Input } from '@/popup/components/ui/input'
import { CopyToast, useCopyToClipboard } from '@/popup/components/common/CopyToast'

type Picker = 'token' | 'network' | 'provider' | null

function depositChainIconAlias(network: ChainDefinition): string {
  return network.family === 'evm'
    ? resolveEvmChainIconAlias(network.id)
    : resolveChainIconAlias(network.family, network.displayName)
}

export function ShieldDepositPage() {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  return <ShieldDepositContent key={`${network}:${walletId}:${accountId}`} />
}

function ShieldDepositContent() {
  const [searchParams] = useSearchParams()
  const { navigate, replace } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const {
    catalog: accountCatalog,
    activeAccount,
    loading,
    error: accountCatalogError,
    refresh: refreshAccountCatalog
  } = useActiveAccountNetworks()
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const walletId = effectiveAccount?.walletId ?? null
  const accountId = effectiveAccount?.accountId ?? null
  const account =
    accountCatalog?.accounts.find(
      item => item.walletId === walletId && item.accountId === accountId
    ) ?? null
  const canManageNear = getPrivateTransferChainIds(account, currentNetwork === 'mainnet').length > 0
  const accountUnavailable = !loading && (!account || !canManageNear)
  const scopeKey = `${currentNetwork}:${walletId ?? ''}:${accountId ?? ''}`
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey
  const mounted = useRef(false)
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const [catalog, setCatalog] = useState<readonly SwapToken[]>([])
  const [picker, setPicker] = useState<Picker>(null)
  const [tokenId, setTokenId] = useState<string | null | undefined>(undefined)
  const [networkId, setNetworkId] = useState<string | null>(null)
  const [refundAddress, setRefundAddress] = useState('')
  const [refundEdited, setRefundEdited] = useState(false)
  const [showRefundError, setShowRefundError] = useState(false)
  const [amount, setAmount] = useState('')
  const [showAmountError, setShowAmountError] = useState(false)
  const [quoteAmountError, setQuoteAmountError] = useState<string | null>(null)
  const [provider, setProvider] = useState<ShieldProvider>('near-confidential')
  const [records, setRecords] = useState<readonly ExternalShieldDeposit[]>([])
  const [viewRecordId, setViewRecordId] = useState<string | null>(null)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const requestIdRef = useRef<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const requestedProvider = searchParams.get('provider')
    if (!requestedProvider || requestedProvider === 'near-confidential') return
    if (
      requestedProvider === 'zcash-shield' &&
      walletId &&
      accountId &&
      account?.networks.some(network => network.chain.family === 'zcash')
    ) {
      replace(
        `/addresses-list?walletId=${encodeURIComponent(walletId)}&accountId=${encodeURIComponent(accountId)}&chain=zcash&privacy=shielded`
      )
    } else if (requestedProvider !== 'zcash-shield' || account) {
      replace('/shield-funds')
    }
  }, [searchParams, walletId, accountId, account, replace])

  useEffect(() => {
    setTokenId(undefined)
    setNetworkId(null)
    setProvider('near-confidential')
    setPicker(null)
    setRefundAddress('')
    setRefundEdited(false)
    setShowRefundError(false)
    setAmount('')
    setShowAmountError(false)
    setQuoteAmountError(null)
    setReviewOpen(false)
    setBusy(false)
    setRefreshing(false)
    setError(null)
    requestIdRef.current = null
  }, [walletId, accountId, currentNetwork])

  useEffect(() => {
    let active = true
    void swapTokenCatalogClient
      .readCached()
      .then(tokens => {
        if (active) setCatalog(tokens)
      })
      .catch(() => {})
    void swapTokenCatalogClient
      .refresh()
      .then(tokens => {
        if (active) setCatalog(tokens)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let revision = 0
    let initialSelectionPending = true
    setRecords([])
    setViewRecordId(null)
    setShowAllHistory(false)
    setNow(Date.now())
    setHistoryLoading(Boolean(walletId && accountId))
    if (!walletId || !accountId)
      return () => {
        active = false
      }
    const loadHistory = () => {
      const requestRevision = ++revision
      void externalShieldDepositClient
        .list({ network: currentNetwork, keyDomainId: walletId, accountId })
        .then(result => {
          if (!active || requestRevision !== revision) return
          setRecords(result)
          if (initialSelectionPending) {
            setViewRecordId(
              result.find(record => !isExternalShieldDepositAutoHidden(record))?.depositId ?? null
            )
            initialSelectionPending = false
          }
        })
        .catch(() => {
          if (active && requestRevision === revision && initialSelectionPending)
            setError('Deposit history unavailable')
        })
        .finally(() => {
          if (active && requestRevision === revision) setHistoryLoading(false)
        })
    }
    const onStorageChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (
        area === 'local' &&
        Object.keys(changes).some(key => key.startsWith('confidential_external_deposit:'))
      ) {
        loadHistory()
      }
    }
    chrome.storage.onChanged.addListener(onStorageChanged)
    loadHistory()
    return () => {
      active = false
      chrome.storage.onChanged.removeListener(onStorageChanged)
    }
  }, [walletId, accountId, currentNetwork])

  const networks = useMemo(() => depositSourceNetworks(), [account])
  const tokens = useMemo(() => availableDepositTokens(catalog, networks), [catalog, networks])
  const availableNetworks = networks.filter(network =>
    tokens.some(token => depositTokenChainId(token) === network.id)
  )
  const requestedAssetId = searchParams.get('assetId')
  const requestedTokenId = useMemo(() => {
    if (!requestedAssetId) return null
    const direct = tokens.find(token => token.assetId === requestedAssetId)
    if (direct) return direct.assetId
    const mapped = tokens.find(token =>
      networks.some(network => depositSourceAssetId(token, network) === requestedAssetId)
    )
    return mapped?.assetId ?? null
  }, [requestedAssetId, tokens, networks])
  const selectedToken =
    tokens.find(token => token.assetId === (tokenId === undefined ? requestedTokenId : tokenId)) ??
    null
  const selectedNetwork =
    networks.find(network => network.id === networkId) ??
    networks.find(
      network => network.id === (selectedToken && depositTokenChainId(selectedToken))
    ) ??
    null
  const defaultRefund = defaultDepositRefundAddress(selectedNetwork, account?.networks ?? [])
  const effectiveRefund = refundEdited ? refundAddress : defaultRefund
  const refundError = depositRefundAddressError(effectiveRefund, selectedNetwork)
  const amountError = depositAmountError(amount, selectedToken)
  const displayAmountError = amountError ?? quoteAmountError
  const amountRaw = depositAmountRaw(amount, selectedToken)
  const sourceAssetId =
    selectedToken && selectedNetwork ? depositSourceAssetId(selectedToken, selectedNetwork) : null
  const scopedRecords = records.filter(
    record =>
      record.network === currentNetwork &&
      record.keyDomainId === walletId &&
      record.accountId === accountId
  )
  const recentRecords = scopedRecords.filter(
    record => !isExternalShieldDepositAutoHidden(record, now)
  )
  const historyRecords = showAllHistory ? scopedRecords : recentRecords
  const hasHiddenHistory = recentRecords.length < scopedRecords.length
  const viewedRecord = scopedRecords.find(record => record.depositId === viewRecordId) ?? null
  const viewedToken = catalog.find(token => token.assetId === viewedRecord?.source.protocolAssetId)
  const viewedNetwork = networks.find(network => network.id === viewedRecord?.source.chainId)
  const payment = viewedRecord ? depositPaymentProgress(viewedRecord, now) : null
  const canPay = payment?.canPay ?? false

  useEffect(() => {
    if (records.length === 0) return
    const timer = window.setInterval(
      () => setNow(Date.now()),
      viewedRecord?.phase === 'awaiting-payment' ? 1_000 : 15_000
    )
    return () => window.clearInterval(timer)
  }, [records.length, viewedRecord?.phase])

  useEffect(() => {
    if (
      !viewedRecord ||
      (viewedRecord.phase !== 'awaiting-payment' && viewedRecord.phase !== 'processing') ||
      !shouldAutoRefreshExternalShieldDeposit(viewedRecord)
    )
      return
    let active = true
    let inFlight = false
    const timer = window.setInterval(() => {
      if (!shouldAutoRefreshExternalShieldDeposit(viewedRecord, Date.now())) {
        window.clearInterval(timer)
        return
      }
      if (inFlight) return
      inFlight = true
      void externalShieldDepositClient
        .refresh(viewedRecord.depositId)
        .then(updated => {
          if (
            active &&
            updated.network === currentNetwork &&
            updated.keyDomainId === walletId &&
            updated.accountId === accountId
          ) {
            setRecords(current =>
              current.map(item => (item.depositId === updated.depositId ? updated : item))
            )
          }
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false
        })
    }, 15_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [viewedRecord, currentNetwork, walletId, accountId])

  const openReview = () => {
    setShowAmountError(true)
    setShowRefundError(true)
    setError(null)
    if (quoteAmountError) return
    if (
      historyLoading ||
      !account ||
      !canManageNear ||
      !walletId ||
      !accountId ||
      !selectedToken ||
      !selectedNetwork ||
      !sourceAssetId ||
      !amountRaw ||
      refundError
    )
      return
    setReviewOpen(true)
  }

  const createDeposit = async () => {
    if (
      !walletId ||
      !accountId ||
      !account ||
      !canManageNear ||
      !selectedToken ||
      !selectedNetwork ||
      !sourceAssetId ||
      !amountRaw ||
      refundError ||
      busy
    )
      return
    const requestId = requestIdRef.current ?? crypto.randomUUID()
    requestIdRef.current = requestId
    setBusy(true)
    setError(null)
    try {
      const created = await externalShieldDepositClient.create({
        network: currentNetwork,
        keyDomainId: walletId,
        accountId,
        source: {
          chainId: selectedNetwork.id,
          chainName: selectedNetwork.displayName,
          assetId: sourceAssetId,
          protocolAssetId: selectedToken.assetId,
          amountRaw
        },
        refundAddress: effectiveRefund.trim(),
        requestId
      })
      const wallet = useWalletStore.getState()
      if (
        !mounted.current ||
        wallet.currentNetwork !== currentNetwork ||
        scopeRef.current !== scopeKey
      )
        return
      setRecords(current => [
        created,
        ...current.filter(record => record.depositId !== created.depositId)
      ])
      setViewRecordId(created.depositId)
      setNow(Date.now())
      setReviewOpen(false)
      setQuoteAmountError(null)
      requestIdRef.current = null
    } catch (failure) {
      const wallet = useWalletStore.getState()
      if (
        mounted.current &&
        wallet.currentNetwork === currentNetwork &&
        scopeRef.current === scopeKey
      ) {
        const minimum = formatBridgeMinimumAmountError(
          failure instanceof Error ? failure.message : undefined,
          selectedToken
        )
        if (minimum) {
          setQuoteAmountError(minimum)
          setShowAmountError(true)
        } else {
          setError('Receiving address unavailable. Try again.')
        }
      }
    } finally {
      if (mounted.current && scopeRef.current === scopeKey) setBusy(false)
    }
  }

  const refreshDeposit = async () => {
    if (!viewedRecord || refreshing || !mounted.current) return
    setRefreshing(true)
    setError(null)
    try {
      const updated = await externalShieldDepositClient.refresh(viewedRecord.depositId)
      const wallet = useWalletStore.getState()
      if (
        !mounted.current ||
        wallet.currentNetwork !== updated.network ||
        scopeRef.current !== `${updated.network}:${updated.keyDomainId}:${updated.accountId}`
      )
        return
      setRecords(current =>
        current.map(record => (record.depositId === updated.depositId ? updated : record))
      )
      setNow(Date.now())
    } catch {
      if (mounted.current && scopeRef.current === scopeKey)
        setError('Could not check deposit status')
    } finally {
      if (mounted.current && scopeRef.current === scopeKey) setRefreshing(false)
    }
  }

  const selectToken = (token: SwapToken) => {
    const nextNetworkId = depositTokenChainId(token)
    setTokenId(token.assetId)
    setNetworkId(nextNetworkId)
    setRefundAddress('')
    setRefundEdited(false)
    setShowRefundError(false)
    setAmount('')
    setShowAmountError(false)
    setQuoteAmountError(null)
    requestIdRef.current = null
    setPicker(null)
  }
  const selectNetwork = (network: ChainDefinition) => {
    if (network.id !== selectedNetwork?.id) setTokenId(null)
    setNetworkId(network.id)
    setRefundAddress('')
    setRefundEdited(false)
    setShowRefundError(false)
    setAmount('')
    setShowAmountError(false)
    setQuoteAmountError(null)
    requestIdRef.current = null
    setPicker(null)
  }
  const openReceive = () => {
    if (!walletId || !accountId) return
    navigate(
      `/addresses-list?walletId=${encodeURIComponent(walletId)}&accountId=${encodeURIComponent(accountId)}&chain=zcash&privacy=shielded`
    )
  }

  return (
    <div className="page-container min-h-0 overflow-hidden">
      <PageHeader title="Receive" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5">
        {accountUnavailable && (
          <div
            role="alert"
            className="mt-3 flex items-center justify-between gap-3 text-xs text-danger"
          >
            <span>
              {accountCatalogError
                ? 'Account addresses unavailable'
                : account
                  ? 'Shield unavailable for this account'
                  : 'Account unavailable'}
            </span>
            <button
              type="button"
              onClick={() => void refreshAccountCatalog()}
              className="wallet-interactive shrink-0 text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            >
              Retry
            </button>
          </div>
        )}
        {viewedRecord && (
          <Dialog open onOpenChange={open => !open && setViewRecordId(null)}>
            <DialogContent
              position="bottom"
              className="max-h-[calc(100%-24px)] overflow-y-auto bg-wallet-surface p-4 pb-6"
            >
              <DialogTitle className="text-base font-medium">Receiving address</DialogTitle>
              <DialogDescription className="sr-only">
                Receive funds into Shield and check payment status
              </DialogDescription>
              <div className="pt-1">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-medium" role="status">
                    {depositStatusLabel(viewedRecord, now)}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setViewRecordId(null)
                      setAmount('')
                      setQuoteAmountError(null)
                      setError(null)
                      requestIdRef.current = null
                    }}
                    className="wallet-interactive rounded-sm text-sm text-primary hover:bg-primary/10 active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    New address
                  </button>
                </div>
                {viewedRecord.phase === 'awaiting-payment' &&
                  hasExternalShieldDepositFunding(viewedRecord) &&
                  now >= viewedRecord.expiresAt && (
                    <p className="mt-1 text-xs text-warning">Quote expired</p>
                  )}
                <div className="mt-5 flex items-center gap-3">
                  <TokenIcon
                    assetId={viewedRecord.source.assetId}
                    symbol={viewedRecord.sourceSymbol}
                    icon={viewedToken ? resolveSwapTokenIconUrl(viewedToken) : undefined}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{viewedRecord.sourceSymbol}</p>
                    <p className="truncate text-xs text-muted">
                      {viewedNetwork?.displayName ?? viewedRecord.source.chainName} · NEAR
                      Confidential
                    </p>
                  </div>
                </div>
                <div className="mt-5 space-y-3 border-t border-white/10 pt-4 text-sm">
                  <div className="flex items-start justify-between gap-4">
                    <span className="shrink-0 text-muted">
                      {canPay ? 'Send exactly' : 'Amount'}
                    </span>
                    <span className="min-w-0 break-all text-right font-medium">
                      {formatDepositAmount(
                        payment?.paymentAmountRaw ?? viewedRecord.amountRaw,
                        viewedRecord.sourceDecimals
                      ) ?? '—'}{' '}
                      {viewedRecord.sourceSymbol}
                    </span>
                  </div>
                  {viewedRecord.phase === 'awaiting-payment' && payment?.hasDeposit && (
                    <>
                      <div className="flex items-start justify-between gap-4">
                        <span className="shrink-0 text-muted">Deposited</span>
                        <span className="min-w-0 break-all text-right">
                          {formatDepositAmount(
                            viewedRecord.depositedAmountRaw ?? '0',
                            viewedRecord.sourceDecimals
                          ) ?? '—'}{' '}
                          {viewedRecord.sourceSymbol}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="shrink-0 text-muted">Remaining</span>
                        <span className="min-w-0 break-all text-right">
                          {formatDepositAmount(payment.remainingRaw, viewedRecord.sourceDecimals) ??
                            '—'}{' '}
                          {viewedRecord.sourceSymbol}
                        </span>
                      </div>
                    </>
                  )}
                  {!canPay && (
                    <>
                      <div className="flex items-start justify-between gap-4">
                        <span className="shrink-0 text-muted">Estimated receive</span>
                        <span className="min-w-0 break-all text-right">
                          {formatDepositAmount(
                            viewedRecord.expectedOutputRaw,
                            viewedRecord.sourceDecimals
                          ) ?? '—'}{' '}
                          {viewedRecord.sourceSymbol}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="shrink-0 text-muted">Minimum receive</span>
                        <span className="min-w-0 break-all text-right">
                          {formatDepositAmount(
                            viewedRecord.minimumOutputRaw,
                            viewedRecord.sourceDecimals
                          ) ?? '—'}{' '}
                          {viewedRecord.sourceSymbol}
                        </span>
                      </div>
                    </>
                  )}
                  {viewedRecord.settledOutputRaw && (
                    <div className="flex items-start justify-between gap-4">
                      <span className="shrink-0 text-muted">Received</span>
                      <span className="min-w-0 break-all text-right font-medium">
                        {formatDepositAmount(
                          viewedRecord.settledOutputRaw,
                          viewedRecord.sourceDecimals
                        ) ?? '—'}{' '}
                        {viewedRecord.sourceSymbol}
                      </span>
                    </div>
                  )}
                </div>
                {canPay && (
                  <div className="mt-5 flex flex-col items-center">
                    <div className="rounded-lg bg-white p-3">
                      <QRCodeSVG value={viewedRecord.depositAddress} size={164} level="M" />
                    </div>
                    <p className="mt-3 text-center text-xs text-muted">
                      Only send {viewedRecord.sourceSymbol} on{' '}
                      {viewedNetwork?.displayName ?? viewedRecord.source.chainName}.
                    </p>
                    <p className="mt-2 text-xs text-muted">
                      Valid until {new Date(viewedRecord.expiresAt).toLocaleString()}
                    </p>
                    <p className="mt-4 w-full text-sm text-warning">One-time receive address</p>
                    <div className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-lg bg-wallet-selected px-3">
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-xs"
                        title={viewedRecord.depositAddress}
                      >
                        {viewedRecord.depositAddress}
                      </span>
                      <button
                        type="button"
                        aria-label="Copy address"
                        onClick={() => {
                          if (canPayShieldDeposit(viewedRecord, Date.now()))
                            void copyToClipboard(viewedRecord.depositAddress)
                        }}
                        className="wallet-interactive flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-xs hover:bg-white/15 active:bg-white/20 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                      >
                        <Icon icon="lucide:copy" width={14} height={14} />
                        Copy
                      </button>
                    </div>
                    {viewedRecord.depositMemo && (
                      <div className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-lg bg-wallet-surface px-3">
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-xs"
                          title={viewedRecord.depositMemo}
                        >
                          Memo: {viewedRecord.depositMemo}
                        </span>
                        <button
                          type="button"
                          aria-label="Copy memo"
                          onClick={() => {
                            if (canPayShieldDeposit(viewedRecord, Date.now()))
                              void copyToClipboard(viewedRecord.depositMemo!)
                          }}
                          className="wallet-interactive flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-xs hover:bg-white/15 active:bg-white/20 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                        >
                          <Icon icon="lucide:copy" width={14} height={14} />
                          Copy
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-5 border-t border-white/10 pt-4">
                  <p className="text-xs text-muted">Refund address</p>
                  <p className="mt-1 break-all font-mono text-xs">{viewedRecord.refundAddress}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshDeposit()}
                  disabled={refreshing}
                  className="wallet-interactive mt-5 h-11 w-full rounded-lg border border-white/15 text-sm enabled:hover:border-white/30 enabled:hover:bg-white/5 enabled:active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  {refreshing ? 'Checking…' : 'Check deposit status'}
                </button>
                {error && (
                  <p role="alert" className="mt-3 text-xs text-danger">
                    {error}
                  </p>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
        {
          <>
            <div className="space-y-2.5 pt-3">
              <button
                type="button"
                onClick={() => setPicker('token')}
                disabled={loading || tokens.length === 0}
                className="wallet-interactive flex h-[62px] w-full items-center gap-2.5 rounded-lg bg-wallet-surface px-4 text-left enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
              >
                {selectedToken ? (
                  <TokenIcon
                    assetId={selectedToken.assetId}
                    symbol={selectedToken.symbol}
                    icon={resolveSwapTokenIconUrl(selectedToken)}
                    size={32}
                  />
                ) : (
                  <Icon
                    icon="lucide:circle-dollar-sign"
                    width={32}
                    height={32}
                    className="text-muted"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted">Token</span>
                  <span className="block truncate text-sm">
                    {selectedToken?.symbol ?? 'Select token'}
                  </span>
                </span>
                <Icon icon="lucide:chevron-down" width={17} height={17} />
              </button>
              <button
                type="button"
                onClick={() => setPicker('network')}
                disabled={loading || availableNetworks.length === 0}
                className="wallet-interactive flex h-[62px] w-full items-center gap-2.5 rounded-lg bg-wallet-surface px-4 text-left enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
              >
                {selectedNetwork ? (
                  <ChainIcon
                    chain={depositChainIconAlias(selectedNetwork)}
                    width={32}
                    height={32}
                    className="rounded-md"
                  />
                ) : (
                  <Icon icon="lucide:globe" width={32} height={32} className="text-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted">Network</span>
                  <span className="block truncate text-sm">
                    {selectedNetwork?.displayName ?? 'Select network'}
                  </span>
                </span>
                <Icon icon="lucide:chevron-down" width={17} height={17} />
              </button>
              <button
                type="button"
                onClick={() => setPicker('provider')}
                disabled={!selectedNetwork}
                className="wallet-interactive flex h-[62px] w-full items-center gap-2.5 rounded-lg bg-wallet-surface px-4 text-left enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
              >
                {selectedNetwork ? (
                  <ShieldProviderLogo provider={provider} size={32} />
                ) : (
                  <Icon icon="lucide:shield" width={32} height={32} className="text-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted">Shield provider</span>
                  <span className="block truncate text-sm">
                    {selectedNetwork ? SHIELD_PROVIDERS[provider].detailName : 'Select provider'}
                  </span>
                </span>
                <Icon icon="lucide:chevron-down" width={17} height={17} />
              </button>
            </div>
            {selectedToken && (
              <div className="mt-6">
                <label htmlFor="shield-deposit-amount" className="mb-2 block text-sm">
                  Amount to receive
                </label>
                <Input
                  id="shield-deposit-amount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={event => {
                    setAmount(event.target.value)
                    setQuoteAmountError(null)
                    requestIdRef.current = null
                  }}
                  onBlur={() => setShowAmountError(true)}
                  placeholder="0"
                  endContent={
                    <span
                      className="max-w-16 truncate text-sm text-muted"
                      title={selectedToken.symbol}
                    >
                      {selectedToken.symbol}
                    </span>
                  }
                  className="min-h-11"
                  aria-invalid={showAmountError && displayAmountError !== null}
                />
                {showAmountError && displayAmountError && (
                  <p role="alert" className="mt-1 text-xs text-danger">
                    {displayAmountError}
                  </p>
                )}
              </div>
            )}
            {selectedNetwork && (
              <div className="mt-6">
                <label htmlFor="shield-deposit-refund" className="mb-2 block text-sm">
                  Refund address
                </label>
                <Input
                  id="shield-deposit-refund"
                  value={effectiveRefund}
                  onChange={event => {
                    setRefundAddress(event.target.value)
                    setRefundEdited(true)
                    requestIdRef.current = null
                  }}
                  onBlur={() => setShowRefundError(true)}
                  placeholder="Enter refund address"
                  className="min-h-11 font-mono text-xs"
                  aria-invalid={showRefundError && refundError !== null}
                />
                {showRefundError && refundError && (
                  <p role="alert" className="mt-1 text-xs text-danger">
                    {refundError}
                  </p>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={openReview}
              disabled={
                loading ||
                !account ||
                !canManageNear ||
                historyLoading ||
                busy ||
                !selectedToken ||
                !selectedNetwork ||
                !sourceAssetId
              }
              className="wallet-interactive mt-6 h-11 w-full rounded-lg bg-primary text-sm font-medium text-background enabled:hover:brightness-110 enabled:active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
            >
              Receiving address
            </button>
          </>
        }
        {error && !viewedRecord && (
          <p role="alert" className="mt-3 text-center text-xs text-danger">
            {error}
          </p>
        )}
        {historyLoading ? (
          <p className="mt-5 text-center text-xs text-muted">Loading deposits…</p>
        ) : (
          scopedRecords.length > 0 && (
            <section className="mt-7 border-t border-white/10 pt-4" aria-label="Deposit history">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium">
                  {showAllHistory ? 'All deposits' : 'Recent deposits'}
                </h2>
                {hasHiddenHistory && (
                  <button
                    type="button"
                    onClick={() => setShowAllHistory(current => !current)}
                    className="wallet-interactive shrink-0 text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    {showAllHistory ? 'Show recent' : 'Show all'}
                  </button>
                )}
              </div>
              <div className="divide-y divide-white/10">
                {historyRecords.map(record => {
                  return (
                    <button
                      key={record.depositId}
                      type="button"
                      onClick={() => {
                        setViewRecordId(record.depositId)
                        setNow(Date.now())
                        setError(null)
                      }}
                      className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left text-xs"
                    >
                      <span className="min-w-0 truncate">
                        {record.sourceSymbol} · {record.source.chainName}
                      </span>
                      <span className="shrink-0 text-muted">{depositStatusLabel(record, now)}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )
        )}
      </div>
      <Dialog open={reviewOpen} onOpenChange={open => !open && !busy && setReviewOpen(false)}>
        <DialogContent position="bottom" className="gap-0 bg-wallet-surface p-4 pb-6">
          <DialogTitle className="text-base font-medium">Review receiving address</DialogTitle>
          <DialogDescription className="sr-only">
            Confirm the amount and refund address
          </DialogDescription>
          <div className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted">Amount</span>
              <span className="min-w-0 break-all text-right">
                {amount} {selectedToken?.symbol}
              </span>
            </div>
            {quoteAmountError && (
              <p role="alert" className="text-xs text-danger">
                {quoteAmountError}
              </p>
            )}
            <div className="flex justify-between gap-4">
              <span className="text-muted">Network</span>
              <span className="text-right">{selectedNetwork?.displayName}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted">Shield provider</span>
              <span className="text-right">NEAR Confidential Intents</span>
            </div>
            <div className="border-t border-white/10 pt-3">
              <span className="text-muted">Refund address</span>
              <p className="mt-1 break-all font-mono text-xs">{effectiveRefund}</p>
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void createDeposit()}
            disabled={busy || quoteAmountError !== null}
            className="wallet-interactive mt-5 h-11 w-full rounded-lg bg-primary text-sm font-medium text-background enabled:hover:brightness-110 enabled:active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
          >
            {busy ? 'Generating…' : 'Generate address'}
          </button>
        </DialogContent>
      </Dialog>
      <Dialog open={picker !== null} onOpenChange={open => !open && setPicker(null)}>
        <DialogContent
          position="bottom"
          showCloseButton={false}
          className="flex max-h-[90dvh] min-h-[320px] flex-col gap-0 bg-background p-0"
        >
          <div className="flex h-14 shrink-0 items-center justify-between px-4">
            <DialogTitle className="text-base font-medium">
              {picker === 'token'
                ? 'Select Token'
                : picker === 'network'
                  ? 'Select Network'
                  : 'Shield Provider'}
            </DialogTitle>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setPicker(null)}
              className="wallet-interactive flex size-6 items-center justify-center rounded-md hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            >
              <Icon icon="lucide:x" width={20} height={20} />
            </button>
          </div>
          <DialogDescription className="sr-only">Choose deposit source</DialogDescription>
          {picker === 'token' && (
            <TokenSelector tokens={tokens} onSelect={selectToken} fullHeight stableCatalogOrder />
          )}
          {picker === 'network' && (
            <div className="min-h-0 overflow-y-auto px-4 pb-5">
              {availableNetworks.map(network => (
                <button
                  key={network.id}
                  type="button"
                  onClick={() => selectNetwork(network)}
                  className="wallet-interactive flex h-14 w-full items-center gap-3 border-b border-white/5 text-left text-sm hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                >
                  <ChainIcon
                    chain={depositChainIconAlias(network)}
                    width={28}
                    height={28}
                    className="rounded-md"
                  />
                  {network.displayName}
                </button>
              ))}
            </div>
          )}
          {picker === 'provider' && (
            <div className="space-y-2 px-4 pb-5">
              <button
                type="button"
                aria-pressed={provider === 'near-confidential'}
                onClick={() => {
                  setProvider('near-confidential')
                  setPicker(null)
                }}
                className={`wallet-interactive flex h-14 w-full items-center gap-3 rounded-lg border bg-wallet-surface px-3 text-left text-sm hover:bg-wallet-selected active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 ${provider === 'near-confidential' ? 'border-primary' : 'border-transparent'}`}
              >
                <ShieldProviderLogo provider="near-confidential" size={30} />
                <span className="min-w-0 flex-1 truncate">
                  {SHIELD_PROVIDERS['near-confidential'].detailName}
                </span>
                {provider === 'near-confidential' && (
                  <Icon icon="lucide:check" width={18} height={18} className="text-primary" />
                )}
              </button>
              {selectedNetwork?.family === 'zcash' &&
                account?.networks.some(network => network.chain.family === 'zcash') && (
                  <button
                    type="button"
                    aria-pressed={provider === 'zcash-shield'}
                    onClick={() => {
                      setPicker(null)
                      openReceive()
                    }}
                    className={`wallet-interactive flex h-14 w-full items-center gap-3 rounded-lg border bg-wallet-surface px-3 text-left text-sm hover:bg-wallet-selected active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 ${provider === 'zcash-shield' ? 'border-primary' : 'border-transparent'}`}
                  >
                    <ShieldProviderLogo provider="zcash-shield" size={30} />
                    <span className="min-w-0 flex-1 truncate">Zcash shield</span>
                    {provider === 'zcash-shield' && (
                      <Icon icon="lucide:check" width={18} height={18} className="text-primary" />
                    )}
                  </button>
                )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <CopyToast show={showToast} />
    </div>
  )
}
