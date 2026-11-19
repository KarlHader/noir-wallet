import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { ReceivingAddressLayout } from '@/popup/components/common/ReceivingAddressLayout'
import { resolveEvmChainIconAlias } from '@/config/icons'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveSwapTokenIconUrl } from '@/core/services/intents-api'
import {
  hasExternalShieldDepositFunding,
  externalShieldDepositFailureMessage,
  isExternalShieldDepositAutoHidden,
  isExternalShieldDepositPending,
  shouldAutoRefreshExternalShieldDeposit
} from '@/core/services/confidential-funding/confidential-external-deposit'
import type { ChainDefinition } from '@/core/chains/registry'
import { getZcashChainId } from '@/core/chains/registry'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatSortAddress, formatSymbol } from '@/lib/format'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import {
  availableDepositTokens,
  canPayShieldDeposit,
  defaultDepositRefundAddress,
  depositPaymentProgress,
  depositRefundAddressError,
  depositSourceAssetId,
  depositSourceNetworks,
  depositStatusLabel,
  depositTokenForNetwork,
  listDepositTokenChoices,
  formatDepositAmount,
  formatMinimumDepositPaymentAmount,
  hasDepositSettlementShortfall
} from '@/popup/services/shield-deposit-options'
import {
  externalShieldDepositClient,
  type ExternalShieldDeposit
} from '@/popup/services/confidential-funding-client'
import { useWalletStore } from '@/store/wallet-store'
import { PublicReceive } from '@/popup/components/portfolio/PublicReceive'
import {
  ReceiveField,
  ReceiveForm,
  type ReceiveMode
} from '@/popup/components/portfolio/ReceiveForm'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { ChainSelector, type ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { TokenSelectorView } from '@/popup/components/tokens/TokenSelectorView'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
import { ShieldProviderLogo, SHIELD_PROVIDERS } from '@/popup/components/portfolio/shield-providers'
import { ShieldProviderDialog } from '@/popup/components/portfolio/ShieldProviderDialog'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import {
  CopyFeedbackIcon,
  CopyToast,
  useCopyToClipboard
} from '@/popup/components/common/CopyToast'
import { InlineError } from '@/popup/components/common/InlineError'

type Picker = 'provider' | 'token' | null

function depositChainIconAlias(network: ChainDefinition): string {
  return network.family === 'evm'
    ? resolveEvmChainIconAlias(network.id)
    : resolveChainIconAlias(network.family, network.displayName)
}

export function ReceivePage() {
  const { key } = useLocation()
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  return <ReceiveFlow key={`${network}:${walletId}:${accountId}:${key}`} />
}

function ReceiveFlow() {
  const [searchParams] = useSearchParams()
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const { catalog, activeAccount, loading, error, refresh, contextChanging } =
    useActiveAccountNetworks()
  const [mode, setMode] = useState<ReceiveMode>(
    searchParams.get('mode') === 'shield' ? 'shield' : 'public'
  )
  const requestedWalletId = searchParams.get('walletId')
  const requestedAccountId = searchParams.get('accountId')
  const account =
    !contextChanging &&
    (!requestedWalletId || requestedWalletId === activeAccount?.walletId) &&
    (!requestedAccountId || requestedAccountId === activeAccount?.accountId)
      ? activeAccount
      : null
  const canManageNear = getPrivateTransferChainIds(account, currentNetwork === 'mainnet').length > 0
  const zcashNetwork = account?.networks.find(
    item => item.chain.id === getZcashChainId(currentNetwork)
  )
  const shieldAvailable = canManageNear || Boolean(zcashNetwork)
  if (mode === 'public') {
    return (
      <PublicReceive
        account={account}
        assetId={searchParams.get('assetId')}
        chainId={searchParams.get('chainId')}
        loading={loading || contextChanging}
        shieldAvailable={shieldAvailable}
        refresh={refresh}
        onModeChange={setMode}
      />
    )
  }
  return (
    <ShieldReceive
      account={account}
      accountCatalog={catalog}
      loading={loading || contextChanging}
      accountCatalogError={error}
      refreshAccountCatalog={refresh}
      currentNetwork={currentNetwork}
      canManageNear={canManageNear}
      zcashNetwork={zcashNetwork}
      requestedProvider={searchParams.get('provider')}
      requestedAssetId={searchParams.get('assetId')}
      onModeChange={setMode}
    />
  )
}

type ReceiveAccountState = ReturnType<typeof useActiveAccountNetworks>

function ShieldReceive({
  account,
  accountCatalog,
  loading,
  accountCatalogError,
  refreshAccountCatalog,
  currentNetwork,
  canManageNear,
  zcashNetwork,
  requestedProvider,
  requestedAssetId,
  onModeChange
}: {
  readonly account: ReceiveAccountState['activeAccount']
  readonly accountCatalog: ReceiveAccountState['catalog']
  readonly loading: boolean
  readonly accountCatalogError: boolean
  readonly refreshAccountCatalog: ReceiveAccountState['refresh']
  readonly currentNetwork: ReturnType<typeof useWalletStore.getState>['currentNetwork']
  readonly canManageNear: boolean
  readonly zcashNetwork:
    | NonNullable<ReceiveAccountState['activeAccount']>['networks'][number]
    | undefined
  readonly requestedProvider: string | null
  readonly requestedAssetId: string | null
  readonly onModeChange: (mode: ReceiveMode) => void
}) {
  const walletId = account?.walletId ?? null
  const accountId = account?.accountId ?? null
  const requestedProviderIsNear = requestedProvider === 'near-confidential'
  const requestedProviderIsZcash = requestedProvider === 'zcash-shield'
  const zcashAddress = zcashNetwork?.addresses.find(
    address => address.scheme === 'zcash-shielded-unified' && address.privacy === 'shielded'
  )?.value
  const canReceiveZcash = Boolean(zcashNetwork)
  const accountUnavailable = !loading && (!account || (!canManageNear && !canReceiveZcash))
  const scopeKey = `${currentNetwork}:${walletId ?? ''}:${accountId ?? ''}`
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey
  const mounted = useRef(false)
  const { copyToClipboard, showToast, isCopied } = useCopyToClipboard()
  const [catalog, setCatalog] = useState<readonly SwapToken[]>([])
  const [picker, setPicker] = useState<Picker>(null)
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const [tokenId, setTokenId] = useState<string | null | undefined>(undefined)
  const [tokenSearch, setTokenSearch] = useState('')
  const [networkId, setNetworkId] = useState<string | null>(null)
  const [provider, setProvider] = useState<ShieldProvider>(
    requestedProviderIsZcash ? 'zcash-shield' : 'near-confidential'
  )
  const providerRef = useRef<ShieldProvider>(
    requestedProviderIsZcash ? 'zcash-shield' : 'near-confidential'
  )
  const [showZcashAddress, setShowZcashAddress] = useState(false)
  const [records, setRecords] = useState<readonly ExternalShieldDeposit[]>([])
  const [viewRecordId, setViewRecordId] = useState<string | null>(null)
  const viewRecordIdRef = useRef(viewRecordId)
  viewRecordIdRef.current = viewRecordId
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [checkResult, setCheckResult] = useState<{ scope: string; depositId: string } | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showRefundInfo, setShowRefundInfo] = useState(false)
  const [now, setNow] = useState(Date.now())
  const requestIdRef = useRef<string | null>(null)
  const providerRevisionRef = useRef(0)
  const checkAttemptRef = useRef(0)
  const checkInFlightRef = useRef(false)
  const refreshRequests = useRef(new Map<string, Promise<ExternalShieldDeposit>>())
  const depositPollDelayMsRef = useRef(20_000)
  const refreshDepositRecord = useCallback((depositId: string, scope: string, force = true) => {
    const key = `${scope}:${depositId}`
    const existing = refreshRequests.current.get(key)
    if (existing) {
      return force
        ? existing.then(
            () => externalShieldDepositClient.refresh(depositId, true),
            () => externalShieldDepositClient.refresh(depositId, true)
          )
        : existing
    }
    const request = externalShieldDepositClient.refresh(depositId, force).finally(() => {
      if (refreshRequests.current.get(key) === request) refreshRequests.current.delete(key)
    })
    refreshRequests.current.set(key, request)
    return request
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setTokenId(undefined)
    setNetworkId(null)
    const nextProvider = requestedProviderIsZcash ? 'zcash-shield' : 'near-confidential'
    setProvider(nextProvider)
    providerRef.current = nextProvider
    setShowZcashAddress(false)
    setPicker(null)
    setNetworkPickerOpen(false)
    setBusy(false)
    setRefreshing(false)
    setCheckResult(null)
    setCheckError(null)
    checkAttemptRef.current += 1
    checkInFlightRef.current = false
    setError(null)
    requestIdRef.current = null
    providerRevisionRef.current += 1
  }, [walletId, accountId, currentNetwork, requestedProviderIsNear, requestedProviderIsZcash])

  useEffect(() => {
    if (
      !loading &&
      !requestedProviderIsNear &&
      !requestedProviderIsZcash &&
      !canManageNear &&
      canReceiveZcash
    ) {
      providerRef.current = 'zcash-shield'
      setProvider('zcash-shield')
    }
  }, [loading, requestedProviderIsNear, requestedProviderIsZcash, canManageNear, canReceiveZcash])

  useEffect(() => {
    checkAttemptRef.current += 1
    checkInFlightRef.current = false
    setRefreshing(false)
    setCheckResult(null)
    setCheckError(null)
  }, [viewRecordId])

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
    setRecords([])
    setViewRecordId(null)
    setShowAllHistory(false)
    setShowHistory(false)
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
          if (
            !active ||
            requestRevision !== revision ||
            !mounted.current ||
            scopeRef.current !== scopeKey
          )
            return
          setRecords(result)
        })
        .catch(() => {
          if (
            active &&
            requestRevision === revision &&
            mounted.current &&
            scopeRef.current === scopeKey
          )
            setError('Deposit history unavailable')
        })
        .finally(() => {
          if (
            active &&
            requestRevision === revision &&
            mounted.current &&
            scopeRef.current === scopeKey
          )
            setHistoryLoading(false)
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
  const tokenChoices = useMemo(() => listDepositTokenChoices(tokens), [tokens])
  const requestedTokenId = useMemo(() => {
    if (!requestedAssetId) return null
    const requested =
      tokens.find(token => token.assetId === requestedAssetId) ??
      tokens.find(token =>
        networks.some(network => depositSourceAssetId(token, network) === requestedAssetId)
      )
    return (
      tokenChoices.find(choice => choice.assetIds.includes(requested?.assetId ?? ''))?.id ?? null
    )
  }, [requestedAssetId, tokens, networks, tokenChoices])
  const selectedChoiceId =
    tokenId === undefined
      ? (requestedTokenId ??
        tokenChoices.find(choice => choice.token.symbol === 'USDT')?.id ??
        tokenChoices.find(choice => choice.token.symbol === 'USDC')?.id ??
        tokenChoices.find(choice => choice.token.symbol === 'ETH')?.id ??
        tokenChoices[0]?.id ??
        null)
      : tokenId
  const availableNetworks = networks.filter(
    network => depositTokenForNetwork(tokens, selectedChoiceId, network) !== null
  )
  const networkOptions: ChainSelectorOption[] = availableNetworks.map(network => ({
    id: network.id,
    name: network.displayName,
    icon: depositChainIconAlias(network)
  }))
  const selectedNetwork = networks.find(network => network.id === networkId) ?? null
  const selectedToken = depositTokenForNetwork(tokens, selectedChoiceId, selectedNetwork)
  const displayedToken =
    selectedToken ?? tokenChoices.find(choice => choice.id === selectedChoiceId)?.token ?? null
  const defaultRefund = defaultDepositRefundAddress(selectedNetwork, account?.networks ?? [])
  const effectiveRefund = defaultRefund
  const refundError = depositRefundAddressError(effectiveRefund, selectedNetwork)
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
  const hasPendingDeposits = recentRecords.some(record =>
    isExternalShieldDepositPending(record, now)
  )
  const viewedRecord = scopedRecords.find(record => record.depositId === viewRecordId) ?? null
  const viewedToken = catalog.find(token => token.assetId === viewedRecord?.source.protocolAssetId)
  const viewedNetwork = networks.find(network => network.id === viewedRecord?.source.chainId)
  const payment = viewedRecord ? depositPaymentProgress(viewedRecord, now) : null
  const canPay = payment?.canPay ?? false

  useEffect(() => {
    if (records.length === 0) return
    const timer = window.setInterval(
      () => setNow(Date.now()),
      viewedRecord?.phase === 'awaiting-payment' ? 10_000 : 20_000
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
    let timeoutId: number | undefined
    depositPollDelayMsRef.current = 20_000

    const poll = () => {
      if (!active || !shouldAutoRefreshExternalShieldDeposit(viewedRecord, Date.now())) {
        return
      }
      if (inFlight) {
        timeoutId = window.setTimeout(poll, depositPollDelayMsRef.current)
        return
      }
      inFlight = true
      const checkAttemptAtStart = checkAttemptRef.current
      const manualCheckInFlightAtStart = checkInFlightRef.current
      void refreshDepositRecord(viewedRecord.depositId, scopeKey, false)
        .then(updated => {
          depositPollDelayMsRef.current = 20_000
          if (
            active &&
            mounted.current &&
            scopeRef.current === scopeKey &&
            updated.network === currentNetwork &&
            updated.keyDomainId === walletId &&
            updated.accountId === accountId &&
            updated.depositId === viewedRecord.depositId
          ) {
            setRecords(current =>
              current.map(item =>
                item.depositId === updated.depositId && item.updatedAt <= updated.updatedAt
                  ? updated
                  : item
              )
            )
            if (!manualCheckInFlightAtStart && checkAttemptRef.current === checkAttemptAtStart)
              setCheckResult(current =>
                current?.scope === scopeKey && current.depositId === updated.depositId
                  ? null
                  : current
              )
          }
        })
        .catch(() => {
          depositPollDelayMsRef.current = Math.min(depositPollDelayMsRef.current * 2, 120_000)
        })
        .finally(() => {
          inFlight = false
          if (active) timeoutId = window.setTimeout(poll, depositPollDelayMsRef.current)
        })
    }

    timeoutId = window.setTimeout(poll, depositPollDelayMsRef.current)
    return () => {
      active = false
      depositPollDelayMsRef.current = 20_000
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [viewedRecord, currentNetwork, walletId, accountId, scopeKey, refreshDepositRecord])

  const createDeposit = async () => {
    if (historyLoading) return
    if (refundError) {
      setError('Receiving address unavailable for this account on the selected network.')
      return
    }
    if (
      !walletId ||
      !accountId ||
      !account ||
      !canManageNear ||
      !selectedToken ||
      !selectedNetwork ||
      providerRef.current !== 'near-confidential' ||
      !sourceAssetId ||
      refundError ||
      busy
    )
      return
    const requestId = requestIdRef.current ?? crypto.randomUUID()
    const providerRevision = providerRevisionRef.current
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
          protocolAssetId: selectedToken.assetId
        },
        refundAddress: effectiveRefund.trim(),
        requestId
      })
      const wallet = useWalletStore.getState()
      if (
        !mounted.current ||
        wallet.currentNetwork !== currentNetwork ||
        scopeRef.current !== scopeKey ||
        providerRef.current !== 'near-confidential' ||
        providerRevisionRef.current !== providerRevision
      )
        return
      setRecords(current => [
        created,
        ...current.filter(record => record.depositId !== created.depositId)
      ])
      setViewRecordId(created.depositId)
      setNow(Date.now())
      requestIdRef.current = null
    } catch (error) {
      const wallet = useWalletStore.getState()
      if (
        mounted.current &&
        wallet.currentNetwork === currentNetwork &&
        scopeRef.current === scopeKey &&
        providerRef.current === 'near-confidential' &&
        providerRevisionRef.current === providerRevision
      ) {
        setError(externalShieldDepositFailureMessage(error))
      }
    } finally {
      if (mounted.current && scopeRef.current === scopeKey) setBusy(false)
    }
  }

  const refreshDeposit = async () => {
    if (!viewedRecord || checkInFlightRef.current || !mounted.current) return
    const depositId = viewedRecord.depositId
    const requestScope = scopeKey
    const attempt = ++checkAttemptRef.current
    const isCurrentCheck = () =>
      attempt === checkAttemptRef.current &&
      mounted.current &&
      useWalletStore.getState().currentNetwork === currentNetwork &&
      scopeRef.current === requestScope &&
      viewRecordIdRef.current === depositId
    checkInFlightRef.current = true
    setRefreshing(true)
    setCheckResult(null)
    setCheckError(null)
    try {
      const updated = await refreshDepositRecord(depositId, requestScope)
      if (!isCurrentCheck()) return
      if (
        updated.depositId !== depositId ||
        `${updated.network}:${updated.keyDomainId}:${updated.accountId}` !== requestScope
      )
        throw new Error('Deposit status response scope mismatch')
      setRecords(current =>
        current.map(record =>
          record.depositId === depositId && record.updatedAt <= updated.updatedAt ? updated : record
        )
      )
      setNow(Date.now())
      setCheckResult({ scope: requestScope, depositId })
    } catch {
      if (isCurrentCheck()) setCheckError('Could not check deposit status')
    } finally {
      if (isCurrentCheck()) {
        checkInFlightRef.current = false
        setRefreshing(false)
      }
    }
  }

  const selectToken = (choice: (typeof tokenChoices)[number]) => {
    setTokenId(choice.id)
    setNetworkId(null)
    requestIdRef.current = null
    setError(null)
    setPicker(null)
  }
  const selectNetwork = (id: string) => {
    if (!availableNetworks.some(network => network.id === id)) return
    setNetworkId(id)
    requestIdRef.current = null
    setError(null)
  }
  const selectProvider = (nextProvider: ShieldProvider) => {
    if (nextProvider === 'near-confidential' && !canManageNear) return
    if (nextProvider === 'zcash-shield' && !canReceiveZcash) return
    providerRef.current = nextProvider
    providerRevisionRef.current += 1
    setProvider(nextProvider)
    setPicker(null)
    setShowZcashAddress(false)
    setViewRecordId(null)
    setError(null)
    requestIdRef.current = null
    checkAttemptRef.current += 1
  }

  if (
    (provider === 'near-confidential' && viewedRecord) ||
    (provider === 'zcash-shield' && showZcashAddress && zcashAddress)
  ) {
    const near = provider === 'near-confidential' && viewedRecord !== null
    const refundAccount = near
      ? accountCatalog?.accounts.find(candidate =>
          candidate.networks.some(
            network =>
              network.chain.id === viewedRecord.source.chainId &&
              (network.privateExecutionAddress?.toLowerCase() ===
                viewedRecord.refundAddress.toLowerCase() ||
                network.addresses.some(
                  address =>
                    address.value === viewedRecord.refundAddress ||
                    (network.chain.family === 'evm' &&
                      address.value.toLowerCase() === viewedRecord.refundAddress.toLowerCase())
                ))
          )
        )
      : undefined
    const refundNetwork = refundAccount?.networks.find(
      network => near && network.chain.id === viewedRecord.source.chainId
    )
    const refundIsPrivate =
      near &&
      refundNetwork?.privateExecutionAddress?.toLowerCase() ===
        viewedRecord.refundAddress.toLowerCase()
    return (
      <>
        <ReceivingAddressLayout
          qrSize={160}
          headerAction={
            near && (
              <button
                type="button"
                aria-label="Check deposit status"
                title="Check deposit status"
                onClick={() => void refreshDeposit()}
                disabled={refreshing}
                aria-busy={refreshing || undefined}
                className="wallet-interactive flex h-8 items-center justify-center gap-1 rounded-lg px-2 text-xs text-wallet-secondary hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45"
              >
                <Icon
                  icon="lucide:scan-search"
                  width={16}
                  height={16}
                  className={refreshing ? 'animate-spin' : undefined}
                />
                Check
              </button>
            )
          }
          onClose={() => {
            setViewRecordId(null)
            setShowZcashAddress(false)
          }}
          identity={
            <div className="flex flex-col items-center gap-5">
              <div className="flex items-center justify-center gap-5">
                {near ? (
                  <TokenIcon
                    assetId={viewedRecord.source.assetId}
                    symbol={formatSymbol(viewedRecord.sourceSymbol)}
                    icon={viewedToken ? resolveSwapTokenIconUrl(viewedToken) : undefined}
                    size={40}
                    blockchain={viewedNetwork ? depositChainIconAlias(viewedNetwork) : undefined}
                  />
                ) : (
                  <TokenIcon symbol="ZEC" nativeChain="zcash" blockchain="zcash" size={40} />
                )}
                <Icon icon="lucide:arrow-right" width={20} className="text-muted" />
                <ShieldProviderLogo provider={provider} size={40} />
              </div>
              <p className="text-center text-base leading-5 text-muted">
                Asking to receive
                <br />
                {near ? viewedRecord.sourceSymbol : 'ZEC'} on {SHIELD_PROVIDERS[provider].name}{' '}
                address
              </p>
            </div>
          }
          qrValue={near ? (canPay ? viewedRecord.depositAddress : undefined) : zcashAddress}
          beforeQr={
            near && canPay && !payment?.hasDeposit ? (
              <p className="text-center text-base font-medium">
                {viewedRecord.amountMode === 'minimum' ? 'Send at least' : 'Send exactly'}{' '}
                {(viewedRecord.amountMode === 'minimum'
                  ? formatMinimumDepositPaymentAmount
                  : formatDepositAmount)(viewedRecord.amountRaw, viewedRecord.sourceDecimals)}{' '}
                {viewedRecord.sourceSymbol}
              </p>
            ) : undefined
          }
          qrLabel={
            near ? 'One-time receiving address QR code' : 'Zcash shielded receiving address QR code'
          }
          warning={
            (!near || canPay) && (
              <div className="flex items-start gap-2 text-sm leading-5 text-muted">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-wallet-selected font-bold text-foreground"
                >
                  !
                </span>
                <p>
                  Only send {near ? viewedRecord.sourceSymbol : 'ZEC'} on{' '}
                  {near
                    ? (viewedNetwork?.displayName ?? viewedRecord.source.chainName)
                    : zcashNetwork?.chain.displayName}
                  . Sending other assets or using a different network will result in loss of funds.
                </p>
              </div>
            )
          }
        >
          {near ? (
            <div className="w-full">
              {canPay && (
                <div className="mt-8 flex flex-col items-center">
                  <p
                    className="w-full text-base text-warning"
                    title={`Valid until ${new Date(viewedRecord.expiresAt).toLocaleString()}`}
                  >
                    One-time receive address
                  </p>
                  <div className="mt-2 flex min-h-12 w-full items-center gap-2 rounded-xl bg-wallet-surface px-3">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-sm"
                      title={viewedRecord.depositAddress}
                    >
                      {formatSortAddress(viewedRecord.depositAddress)}
                    </span>
                    <button
                      type="button"
                      aria-label="Copy address"
                      disabled={!canPayShieldDeposit(viewedRecord, now)}
                      onClick={() => {
                        if (canPayShieldDeposit(viewedRecord, Date.now()))
                          void copyToClipboard(
                            viewedRecord.depositAddress,
                            `deposit-address:${viewedRecord.depositId}`
                          )
                      }}
                      className="wallet-interactive flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-wallet-selected px-3 text-sm enabled:hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                    >
                      <CopyFeedbackIcon
                        copied={isCopied(`deposit-address:${viewedRecord.depositId}`)}
                        width={14}
                      />
                      {isCopied(`deposit-address:${viewedRecord.depositId}`) ? 'Copied' : 'Copy'}
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
                        disabled={!canPayShieldDeposit(viewedRecord, now)}
                        onClick={() => {
                          if (canPayShieldDeposit(viewedRecord, Date.now()))
                            void copyToClipboard(
                              viewedRecord.depositMemo!,
                              `deposit-memo:${viewedRecord.depositId}`
                            )
                        }}
                        className="wallet-interactive flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-xs enabled:hover:bg-white/15 enabled:active:bg-white/20 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                      >
                        <CopyFeedbackIcon
                          copied={isCopied(`deposit-memo:${viewedRecord.depositId}`)}
                          width={14}
                        />
                        {isCopied(`deposit-memo:${viewedRecord.depositId}`) ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-6 flex items-start justify-between gap-3 text-sm">
                <div className="flex shrink-0 items-center gap-1 text-muted">
                  <span>Refund address</span>
                  <button
                    type="button"
                    aria-label="About refund address"
                    aria-expanded={showRefundInfo}
                    title="About refund address"
                    onClick={() => setShowRefundInfo(value => !value)}
                    className="wallet-interactive flex size-5 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <Icon icon="lucide:circle-help" width={15} height={15} />
                  </button>
                </div>
                <div className="min-w-0 text-right">
                  {refundAccount && (
                    <div className="flex min-w-0 items-center justify-end gap-2">
                      <span className="truncate">{refundAccount.accountDisplayName}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${refundIsPrivate ? 'bg-warning/10 text-warning' : 'bg-wallet-selected text-muted'}`}
                      >
                        {refundIsPrivate
                          ? 'Private'
                          : refundNetwork?.chain.family === 'zcash'
                            ? 'Transparent'
                            : 'Public'}
                      </span>
                    </div>
                  )}
                  <p
                    className="mt-1 truncate font-mono text-xs text-muted"
                    title={viewedRecord.refundAddress}
                  >
                    {formatSortAddress(viewedRecord.refundAddress)}
                  </p>
                </div>
              </div>
              {showRefundInfo && (
                <p className="mt-2 text-xs text-muted">
                  If this deposit cannot complete, funds return to this address on the sending
                  network.
                </p>
              )}
              {(!canPay || payment?.hasDeposit) && (
                <div className="mt-5 flex items-center justify-between gap-3">
                  <h2
                    className={`text-base font-medium ${hasDepositSettlementShortfall(viewedRecord) ? 'text-warning' : ''}`}
                    role="status"
                  >
                    {depositStatusLabel(viewedRecord, now)}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setViewRecordId(null)
                      setError(null)
                      requestIdRef.current = null
                    }}
                    className="wallet-interactive rounded-sm text-sm text-primary hover:bg-primary/10 active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    New address
                  </button>
                </div>
              )}
              {viewedRecord.phase === 'awaiting-payment' &&
                hasExternalShieldDepositFunding(viewedRecord) &&
                now >= viewedRecord.expiresAt && (
                  <p className="mt-1 text-xs text-warning">Quote expired</p>
                )}
              {(!canPay || payment?.hasDeposit || viewedRecord.settledOutputRaw) && (
                <div className="mt-5 space-y-3 border-t border-white/10 pt-4 text-sm">
                  {!canPay && (
                    <div className="flex items-start justify-between gap-4">
                      <span className="shrink-0 text-muted">Amount</span>
                      <span className="min-w-0 break-all text-right font-medium">
                        {formatDepositAmount(
                          payment?.paymentAmountRaw ?? viewedRecord.amountRaw,
                          viewedRecord.sourceDecimals
                        ) ?? '—'}{' '}
                        {viewedRecord.sourceSymbol}
                      </span>
                    </div>
                  )}
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
              )}
              {checkResult?.scope === scopeKey &&
                checkResult.depositId === viewedRecord.depositId && (
                  <p role="status" className="mt-3 text-xs text-muted">
                    Checked · {depositStatusLabel(viewedRecord, now)}
                  </p>
                )}
              <InlineError
                message={checkError ?? error}
                onRetry={checkError ? () => void refreshDeposit() : undefined}
                retrying={refreshing}
                className="mt-3"
              />
            </div>
          ) : (
            <div className="mt-8 w-full">
              <p className="mb-2 text-base text-muted">Receive address</p>
              <div className="flex min-h-12 items-center gap-2 rounded-xl bg-wallet-surface px-3">
                <p
                  className="min-w-0 flex-1 truncate font-mono text-sm leading-5"
                  title={zcashAddress}
                >
                  {formatSortAddress(zcashAddress)}
                </p>
                <button
                  type="button"
                  aria-label="Copy Zcash shielded address"
                  onClick={() => void copyToClipboard(zcashAddress!, 'zcash-shield-address')}
                  className="wallet-interactive flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-wallet-selected px-3 text-sm enabled:hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                >
                  <CopyFeedbackIcon copied={isCopied('zcash-shield-address')} width={16} />
                  {isCopied('zcash-shield-address') ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </ReceivingAddressLayout>
        <CopyToast show={showToast} />
      </>
    )
  }

  return (
    <>
      <ReceiveForm
        mode="shield"
        onModeChange={onModeChange}
        shieldAvailable={canManageNear || canReceiveZcash}
        busy={busy}
        disabled={
          loading ||
          !account ||
          busy ||
          (provider === 'zcash-shield'
            ? !zcashAddress
            : !canManageNear ||
              historyLoading ||
              !selectedToken ||
              !selectedNetwork ||
              !sourceAssetId)
        }
        onShowAddress={() =>
          provider === 'zcash-shield' ? setShowZcashAddress(true) : void createDeposit()
        }
        headerAction={
          provider === 'near-confidential' && (
            <button
              type="button"
              aria-label="Deposit history"
              title="Deposit history"
              aria-haspopup="dialog"
              aria-expanded={showHistory}
              disabled={loading || !walletId || !accountId}
              onClick={() => setShowHistory(true)}
              className="wallet-interactive relative flex size-8 items-center justify-center rounded-lg text-foreground hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            >
              <Icon icon="lucide:history" width={20} height={20} />
              {hasPendingDeposits && (
                <span
                  aria-hidden="true"
                  className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary"
                />
              )}
            </button>
          )
        }
      >
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
        {(canManageNear || canReceiveZcash) && (
          <ReceiveField
            label="Shield Provider"
            value={SHIELD_PROVIDERS[provider].detailName}
            icon={<ShieldProviderLogo provider={provider} size={32} />}
            onClick={() => setPicker('provider')}
          />
        )}
        {!loading &&
          ((provider === 'near-confidential' && !canManageNear) ||
            (provider === 'zcash-shield' && !canReceiveZcash)) &&
          account && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {SHIELD_PROVIDERS[provider].name} unavailable for this account
            </p>
          )}
        {provider === 'near-confidential' && canManageNear && (
          <>
            <ReceiveField
              label="Receive Token"
              value={displayedToken ? formatSymbol(displayedToken.symbol) : undefined}
              placeholderIcon="lucide:coins"
              onClick={() => setPicker('token')}
              disabled={loading || tokenChoices.length === 0}
              icon={
                displayedToken && (
                  <TokenIcon
                    assetId={displayedToken.assetId}
                    symbol={formatSymbol(displayedToken.symbol)}
                    icon={resolveSwapTokenIconUrl(displayedToken)}
                    size={32}
                  />
                )
              }
            />
            <ReceiveField
              label={selectedNetwork ? 'Network' : 'Select Network'}
              value={selectedNetwork?.displayName}
              placeholderIcon="lucide:globe"
              onClick={() => setNetworkPickerOpen(true)}
              disabled={loading || !displayedToken || availableNetworks.length === 0}
              icon={
                selectedNetwork && (
                  <ChainIcon
                    chain={depositChainIconAlias(selectedNetwork)}
                    width={32}
                    height={32}
                    className="rounded-md"
                  />
                )
              }
            />
          </>
        )}
        {provider === 'zcash-shield' && canReceiveZcash && (
          <section className="space-y-2.5" aria-label="Zcash shielded receive address">
            <ReceiveField
              label="Receive Token"
              value="ZEC"
              icon={<TokenIcon symbol="ZEC" nativeChain="zcash" size={32} />}
            />
            <ReceiveField
              label="Network"
              value={zcashNetwork?.chain.displayName}
              icon={<ChainIcon chain="zcash" width={32} height={32} className="rounded-md" />}
            />
            {!zcashAddress && (
              <InlineError
                message="Shielded receiving address unavailable"
                onRetry={() => void refreshAccountCatalog()}
                retrying={loading}
                className="mt-4"
              />
            )}
          </section>
        )}
        {provider === 'near-confidential' && error && !viewedRecord && (
          <p role="alert" className="mt-3 text-center text-xs text-danger">
            {error}
          </p>
        )}
      </ReceiveForm>
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent
          position="bottom"
          showCloseButton={false}
          className="flex max-h-[80dvh] min-h-[220px] flex-col gap-0 bg-background p-0"
        >
          <div className="flex h-14 shrink-0 items-center justify-between px-4">
            <DialogTitle className="text-base font-medium">Deposit history</DialogTitle>
            <button
              type="button"
              aria-label="Close deposit history"
              onClick={() => setShowHistory(false)}
              className="wallet-interactive flex size-8 items-center justify-center rounded-lg hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            >
              <Icon icon="lucide:x" width={20} height={20} />
            </button>
          </div>
          <DialogDescription className="sr-only">
            Previous receiving addresses and deposit status
          </DialogDescription>
          <section
            aria-label="Deposit history"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5"
          >
            {hasHiddenHistory && (
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-sm text-muted">
                  {showAllHistory ? 'All deposits' : 'Recent deposits'}
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAllHistory(current => !current)}
                  className="wallet-interactive shrink-0 text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                >
                  {showAllHistory ? 'Show recent' : 'Show all'}
                </button>
              </div>
            )}
            {historyLoading ? (
              <p role="status" className="py-6 text-center text-sm text-muted">
                Loading deposits…
              </p>
            ) : error === 'Deposit history unavailable' ? (
              <InlineError message={error} />
            ) : historyRecords.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">
                {hasHiddenHistory && !showAllHistory ? 'No recent deposits' : 'No deposits yet'}
              </p>
            ) : (
              <div className="divide-y divide-white/10">
                {historyRecords.map(record => (
                  <button
                    key={record.depositId}
                    type="button"
                    onClick={() => {
                      setShowHistory(false)
                      setViewRecordId(record.depositId)
                      setNow(Date.now())
                      setError(null)
                    }}
                    className="wallet-interactive flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left text-sm hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    <span className="min-w-0 truncate">
                      {record.sourceSymbol} · {record.source.chainName}
                    </span>
                    <span
                      className={`shrink-0 text-xs ${hasDepositSettlementShortfall(record) ? 'text-warning' : 'text-muted'}`}
                    >
                      {depositStatusLabel(record, now)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </DialogContent>
      </Dialog>
      <ShieldProviderDialog
        open={picker === 'provider'}
        onClose={() => setPicker(null)}
        selected={provider}
        available={{ 'near-confidential': canManageNear, 'zcash-shield': canReceiveZcash }}
        onSelect={selectProvider}
        networks={networks}
        tokens={catalog.length > 0 ? tokens : null}
      />
      <TokenSelectorDialog
        open={picker === 'token'}
        onOpenChange={open => !open && setPicker(null)}
      >
        <TokenSelectorView
          search={tokenSearch}
          onSearchChange={setTokenSearch}
          networks={[]}
          selectedNetwork="all"
          onNetworkChange={() => {}}
          items={tokenChoices
            .filter(choice => rankTokenSearchFields(choice.token, tokenSearch) < 99)
            .sort(
              (left, right) =>
                rankTokenSearchFields(left.token, tokenSearch) -
                rankTokenSearchFields(right.token, tokenSearch)
            )
            .map(choice => ({
              key: choice.id,
              symbol: formatSymbol(choice.token.symbol),
              icon: (
                <TokenIcon
                  assetId={choice.token.assetId}
                  symbol={formatSymbol(choice.token.symbol)}
                  icon={resolveSwapTokenIconUrl(choice.token)}
                  size={32}
                />
              ),
              subtitle: choice.distinguish
                ? choice.token.contractAddress
                  ? `${choice.token.contractAddress.slice(0, 8)}...${choice.token.contractAddress.slice(-6)}`
                  : choice.token.assetId
                : undefined,
              subtitleTitle: choice.distinguish ? choice.token.assetId : undefined
            }))}
          selectedKey={selectedChoiceId ?? undefined}
          onSelect={key => {
            const choice = tokenChoices.find(item => item.id === key)
            if (choice) selectToken(choice)
          }}
        />
      </TokenSelectorDialog>
      <ChainSelector
        open={networkPickerOpen}
        onOpenChange={setNetworkPickerOpen}
        options={networkOptions}
        selectedId={networkId}
        onSelect={selectNetwork}
      />
      <CopyToast show={showToast} />
    </>
  )
}
