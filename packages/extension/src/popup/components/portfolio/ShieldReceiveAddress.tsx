import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { ChainDefinition } from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveSwapTokenIconUrl } from '@/core/services/intents-api'
import {
  externalShieldDepositFailureMessage,
  hasExternalShieldDepositFunding,
  shouldAutoRefreshExternalShieldDeposit
} from '@/core/services/confidential-funding/confidential-external-deposit'
import type { Network } from '@/types'
import { formatSortAddress, formatSymbol } from '@/lib/format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { resolveEvmChainIconAlias } from '@/config/icons'
import { cn } from '@/lib/utils'
import { useWalletStore } from '@/store/wallet-store'
import { ReceivingAddressLayout } from '@/popup/components/account/ReceivingAddressLayout'
import {
  CopyFeedbackIcon,
  CopyToast,
  useCopyToClipboard
} from '@/popup/components/common/CopyToast'
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { Skeleton } from '@/popup/components/ui/skeleton'
import { ShieldProviderLogo, SHIELD_PROVIDERS } from './shield-providers'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import type {
  AccountNetworksCatalogView,
  AccountNetworksView
} from '@/popup/services/account-networks-client'
import {
  canPayShieldDeposit,
  defaultDepositRefundAddress,
  depositPaymentProgress,
  depositRefundAddressError,
  depositSourceAssetId,
  depositStatusLabel,
  formatDepositAmount,
  formatShieldReceiveNetworkMinimum,
  hasDepositSettlementShortfall
} from '@/popup/services/shield-deposit-options'
import {
  externalShieldDepositClient,
  type ExternalShieldDeposit
} from '@/popup/services/confidential-funding-client'

export interface ShieldReceiveAddressProps {
  readonly provider: ShieldProvider
  readonly network: Network
  readonly account: AccountNetworksView | null
  readonly accountCatalog: AccountNetworksCatalogView | null
  readonly asset: { assetId: string; token: SwapToken; chain: ChainDefinition } | null
  readonly zcashAddress?: string
  readonly slippageBps: number
  readonly enabled: boolean
  readonly inline?: boolean
}

function chainIcon(chain: ChainDefinition): string {
  return chain.family === 'evm'
    ? resolveEvmChainIconAlias(chain.id)
    : resolveChainIconAlias(chain.family, chain.displayName)
}

function sameScope(
  record: ExternalShieldDeposit,
  network: Network,
  walletId: string,
  accountId: string
): boolean {
  return (
    record.network === network && record.keyDomainId === walletId && record.accountId === accountId
  )
}

export function ShieldReceiveAddressSkeleton() {
  return (
    <div role="status" aria-label="Loading receive address" className="pb-5">
      <Skeleton className="mx-auto mt-14 size-[184px] rounded-xl" />
      <Skeleton className="mt-12 h-4 w-44" />
      <Skeleton className="mt-2 h-[62px] w-full rounded-xl" />
      <Skeleton className="mt-4 h-3 w-4/5" />
    </div>
  )
}

export function ShieldReceiveAddress({
  provider,
  network,
  account,
  accountCatalog,
  asset,
  zcashAddress,
  slippageBps,
  enabled,
  inline = false
}: ShieldReceiveAddressProps) {
  const walletId = account?.walletId ?? ''
  const accountId = account?.accountId ?? ''
  const scope = `${network}:${walletId}:${accountId}:${provider}:${asset?.assetId ?? ''}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const mounted = useRef(false)
  const busyRef = useRef(false)
  const pendingRequest = useRef<{ id: string; slippageBps: number } | null>(null)
  const refreshInFlight = useRef(new Map<string, Promise<ExternalShieldDeposit>>())
  const pollDelay = useRef(20_000)
  const { copyToClipboard, showToast, isCopied } = useCopyToClipboard()
  const [record, setRecord] = useState<ExternalShieldDeposit | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [showRefundInfo, setShowRefundInfo] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setRecord(null)
    setOpen(false)
    setError(null)
    setCheckError(null)
    setChecked(false)
    pendingRequest.current = null
  }, [scope])

  const currentRecord =
    record &&
    provider === 'near-confidential' &&
    sameScope(record, network, walletId, accountId) &&
    record.source.assetId === asset?.assetId
      ? record
      : null
  const payment = currentRecord ? depositPaymentProgress(currentRecord, now) : null
  const canPay = payment?.canPay ?? false
  const refundAddress = defaultDepositRefundAddress(asset?.chain ?? null, account?.networks ?? [])
  const sourceAssetId = asset ? depositSourceAssetId(asset.token, asset.chain) : null
  const nearReady =
    provider === 'near-confidential' &&
    network === 'mainnet' &&
    account !== null &&
    asset !== null &&
    sourceAssetId !== null &&
    sourceAssetId === asset.assetId
  const canGenerate =
    enabled &&
    Boolean(walletId && accountId) &&
    (provider === 'zcash-shield'
      ? Boolean(zcashAddress)
      : nearReady && !depositRefundAddressError(refundAddress, asset?.chain ?? null))

  const refreshRecord = useCallback((depositId: string, force: boolean) => {
    const existing = refreshInFlight.current.get(depositId)
    if (existing) {
      return force
        ? existing.then(
            () => externalShieldDepositClient.refresh(depositId, true),
            () => externalShieldDepositClient.refresh(depositId, true)
          )
        : existing
    }
    const request = externalShieldDepositClient.refresh(depositId, force).finally(() => {
      if (refreshInFlight.current.get(depositId) === request)
        refreshInFlight.current.delete(depositId)
    })
    refreshInFlight.current.set(depositId, request)
    return request
  }, [])

  const visible = inline || open
  useEffect(() => {
    if (!visible || !currentRecord) return
    const timer = window.setInterval(
      () => setNow(Date.now()),
      currentRecord.phase === 'awaiting-payment' ? 10_000 : 20_000
    )
    return () => window.clearInterval(timer)
  }, [visible, currentRecord?.depositId, currentRecord?.phase])

  useEffect(() => {
    if (!visible || !currentRecord || !shouldAutoRefreshExternalShieldDeposit(currentRecord)) return
    const depositId = currentRecord.depositId
    const requestScope = scope
    let active = true
    let timeout: number | undefined
    pollDelay.current = 20_000
    const poll = () => {
      if (!active || !shouldAutoRefreshExternalShieldDeposit(currentRecord, Date.now())) return
      void refreshRecord(depositId, false)
        .then(updated => {
          pollDelay.current = 20_000
          if (
            active &&
            mounted.current &&
            scopeRef.current === requestScope &&
            updated.depositId === depositId &&
            sameScope(updated, network, walletId, accountId)
          )
            setRecord(previous =>
              previous?.depositId === depositId && previous.updatedAt <= updated.updatedAt
                ? updated
                : previous
            )
        })
        .catch(() => {
          pollDelay.current = Math.min(pollDelay.current * 2, 120_000)
        })
        .finally(() => {
          if (active) timeout = window.setTimeout(poll, pollDelay.current)
        })
    }
    timeout = window.setTimeout(poll, pollDelay.current)
    return () => {
      active = false
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [visible, currentRecord?.depositId, currentRecord?.phase, scope, refreshRecord])

  const createAddress = async (newAddress = false) => {
    if (busyRef.current || !canGenerate) return
    setError(null)
    if (provider === 'zcash-shield') {
      setOpen(true)
      return
    }
    if (!asset || !sourceAssetId || !account) return
    if (currentRecord && !newAddress) {
      setOpen(true)
      return
    }
    if (newAddress) {
      setRecord(null)
      setCheckError(null)
      setChecked(false)
      pendingRequest.current = null
    }
    const requestScope = scope
    const requestWallet = useWalletStore.getState()
    const requestId =
      pendingRequest.current?.slippageBps === slippageBps
        ? pendingRequest.current.id
        : crypto.randomUUID()
    pendingRequest.current = { id: requestId, slippageBps }
    busyRef.current = true
    setBusy(true)
    try {
      const created = await externalShieldDepositClient.create({
        network,
        keyDomainId: walletId,
        accountId,
        source: {
          chainId: asset.chain.id,
          chainName: asset.chain.displayName,
          assetId: sourceAssetId,
          protocolAssetId: asset.token.assetId
        },
        refundAddress: refundAddress.trim(),
        slippageBps,
        requestId
      })
      const currentWallet = useWalletStore.getState()
      if (
        !mounted.current ||
        scopeRef.current !== requestScope ||
        currentWallet.currentNetwork !== network ||
        currentWallet.currentWalletId !== requestWallet.currentWalletId ||
        currentWallet.currentAccountId !== requestWallet.currentAccountId
      )
        return
      if (
        !sameScope(created, network, walletId, accountId) ||
        created.source.assetId !== sourceAssetId ||
        created.source.protocolAssetId !== asset.token.assetId ||
        created.slippageBps !== slippageBps
      )
        throw new Error('Receiving address scope mismatch')
      setRecord(created)
      setNow(Date.now())
      setOpen(true)
      pendingRequest.current = null
    } catch (cause) {
      if (mounted.current && scopeRef.current === requestScope)
        setError(externalShieldDepositFailureMessage(cause))
    } finally {
      busyRef.current = false
      if (mounted.current && scopeRef.current === requestScope) setBusy(false)
    }
  }

  const createInlineAddress = useEffectEvent(() => {
    if (!error) void createAddress()
  })
  useEffect(() => {
    if (inline && canGenerate && provider === 'near-confidential') createInlineAddress()
  }, [inline, canGenerate, provider, scope])

  const checkStatus = async () => {
    if (!currentRecord || refreshing) return
    const depositId = currentRecord.depositId
    const requestScope = scope
    setRefreshing(true)
    setChecked(false)
    setCheckError(null)
    try {
      const updated = await refreshRecord(depositId, true)
      if (!mounted.current || scopeRef.current !== requestScope || !visible) return
      if (updated.depositId !== depositId || !sameScope(updated, network, walletId, accountId))
        throw new Error('Deposit status response scope mismatch')
      setRecord(previous =>
        previous?.depositId === depositId && previous.updatedAt <= updated.updatedAt
          ? updated
          : previous
      )
      setNow(Date.now())
      setChecked(true)
    } catch {
      if (mounted.current && scopeRef.current === requestScope)
        setCheckError('Could not check deposit status')
    } finally {
      if (mounted.current && scopeRef.current === requestScope) setRefreshing(false)
    }
  }

  const refundAccount = currentRecord
    ? accountCatalog?.accounts.find(candidate =>
        candidate.networks.some(
          item =>
            item.chain.id === currentRecord.source.chainId &&
            (item.privateExecutionAddress?.toLowerCase() ===
              currentRecord.refundAddress.toLowerCase() ||
              item.addresses.some(
                address =>
                  address.value === currentRecord.refundAddress ||
                  (item.chain.family === 'evm' &&
                    address.value.toLowerCase() === currentRecord.refundAddress.toLowerCase())
              ))
        )
      )
    : undefined
  const refundNetwork = refundAccount?.networks.find(
    item => item.chain.id === currentRecord?.source.chainId
  )
  const refundIsPrivate =
    Boolean(currentRecord) &&
    refundNetwork?.privateExecutionAddress?.toLowerCase() ===
      currentRecord?.refundAddress.toLowerCase()
  const sourceChain = asset && asset.chain.id === currentRecord?.source.chainId ? asset.chain : null
  const symbol = currentRecord?.sourceSymbol ?? 'ZEC'
  const displayNetwork =
    currentRecord?.source.chainName ??
    account?.networks.find(item => item.chain.family === 'zcash')?.chain.displayName ??
    'Zcash'
  const receiveWarning = `Only send ${symbol} on ${displayNetwork}. Using a different asset or network can result in loss of funds.`
  const networkMinimum =
    currentRecord?.amountMode === 'minimum'
      ? formatShieldReceiveNetworkMinimum(currentRecord, asset?.token.price)
      : null
  const paymentRequirement =
    currentRecord && canPay && !payment?.hasDeposit
      ? currentRecord.amountMode === 'minimum'
        ? networkMinimum
          ? `Minimum deposit $1 (at least ${networkMinimum} ${symbol} on this network)`
          : 'Minimum deposit $1'
        : `Send exactly ${formatDepositAmount(currentRecord.amountRaw, currentRecord.sourceDecimals)} ${symbol}`
      : null
  const inlineWarning = (
    <div className="mt-4 flex items-start gap-2 text-xs leading-4 text-muted">
      <Icon icon="lucide:circle-alert" width={24} className="shrink-0" aria-hidden="true" />
      <p>{receiveWarning}</p>
    </div>
  )

  const statusAction = currentRecord && (
    <button
      type="button"
      aria-label="Check deposit status"
      title="Check deposit status"
      onClick={() => void checkStatus()}
      disabled={refreshing}
      aria-busy={refreshing || undefined}
      className="wallet-interactive flex size-8 items-center justify-center rounded-lg text-wallet-secondary hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45"
    >
      <Icon
        icon="lucide:scan-search"
        width={17}
        height={17}
        className={refreshing ? 'animate-spin' : undefined}
      />
    </button>
  )
  const addressContent = (
    <ReceivingAddressLayout
      onClose={inline ? undefined : () => setOpen(false)}
      qrSize={inline ? 154 : 160}
      qrClassName={inline ? 'mt-14 rounded-xl p-[15px]' : undefined}
      headerAction={statusAction}
      identity={
        inline ? undefined : (
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-5">
              {currentRecord ? (
                <TokenIcon
                  assetId={currentRecord.source.assetId}
                  symbol={formatSymbol(symbol)}
                  icon={asset ? resolveSwapTokenIconUrl(asset.token) : undefined}
                  blockchain={sourceChain ? chainIcon(sourceChain) : undefined}
                  size={40}
                />
              ) : (
                <TokenIcon symbol="ZEC" nativeChain="zcash" blockchain="zcash" size={40} />
              )}
              <Icon icon="lucide:arrow-right" width={20} className="text-muted" />
              <ShieldProviderLogo provider={provider} size={40} />
            </div>
            <p className="text-center text-base text-muted">
              {symbol} on {SHIELD_PROVIDERS[provider].name}
            </p>
          </div>
        )
      }
      beforeQr={
        !inline && paymentRequirement ? (
          <p className="text-center text-base font-medium">{paymentRequirement}</p>
        ) : undefined
      }
      qrValue={currentRecord ? (canPay ? currentRecord.depositAddress : undefined) : zcashAddress}
      qrLabel={
        currentRecord
          ? 'One-time receiving address QR code'
          : 'Zcash shielded receiving address QR code'
      }
      warning={
        !inline &&
        (!currentRecord || canPay) && <TransactionNotice tone="warning" message={receiveWarning} />
      }
    >
      {currentRecord ? (
        <div className={inline && canPay ? 'mt-12 w-full text-sm' : 'mt-7 w-full text-sm'}>
          {canPay && (
            <>
              <p
                className="text-warning"
                title={`Valid until ${new Date(currentRecord.expiresAt).toLocaleString()}`}
              >
                One-time receive address
              </p>
              <div
                className={cn(
                  'mt-2 flex items-center gap-2',
                  inline
                    ? 'min-h-[62px] rounded-xl bg-accent px-4'
                    : 'min-h-12 rounded-lg bg-wallet-surface px-3'
                )}
              >
                <span
                  className={cn('min-w-0 flex-1 truncate', !inline && 'font-mono')}
                  title={currentRecord.depositAddress}
                >
                  {formatSortAddress(currentRecord.depositAddress)}
                </span>
                <button
                  type="button"
                  aria-label="Copy address"
                  disabled={!canPayShieldDeposit(currentRecord, now)}
                  onClick={() => {
                    if (canPayShieldDeposit(currentRecord, Date.now()))
                      void copyToClipboard(
                        currentRecord.depositAddress,
                        `deposit-address:${currentRecord.depositId}`
                      )
                  }}
                  className="wallet-interactive flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-wallet-selected px-3 disabled:opacity-45"
                >
                  <CopyFeedbackIcon
                    copied={isCopied(`deposit-address:${currentRecord.depositId}`)}
                    width={14}
                  />
                  {isCopied(`deposit-address:${currentRecord.depositId}`) ? 'Copied' : 'Copy'}
                </button>
              </div>
              {currentRecord.depositMemo && (
                <div className="mt-2 flex min-h-11 items-center gap-2 rounded-lg bg-wallet-surface px-3">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    title={currentRecord.depositMemo}
                  >
                    Memo: {currentRecord.depositMemo}
                  </span>
                  <button
                    type="button"
                    aria-label="Copy memo"
                    disabled={!canPayShieldDeposit(currentRecord, now)}
                    onClick={() => {
                      if (
                        currentRecord.depositMemo &&
                        canPayShieldDeposit(currentRecord, Date.now())
                      )
                        void copyToClipboard(
                          currentRecord.depositMemo,
                          `deposit-memo:${currentRecord.depositId}`
                        )
                    }}
                    className="wallet-interactive flex h-8 shrink-0 items-center gap-1 rounded-lg bg-wallet-selected px-2 disabled:opacity-45"
                  >
                    <CopyFeedbackIcon
                      copied={isCopied(`deposit-memo:${currentRecord.depositId}`)}
                      width={14}
                    />
                    {isCopied(`deposit-memo:${currentRecord.depositId}`) ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
              {inline && inlineWarning}
              {inline && paymentRequirement && (
                <p className="mt-2 pl-8 text-xs text-muted">{paymentRequirement}</p>
              )}
            </>
          )}
          <div
            className={cn(
              'mt-6 items-start justify-between gap-3',
              inline && canPay && !payment?.hasDeposit ? 'hidden' : 'flex'
            )}
          >
            <span className="flex shrink-0 items-center gap-1 text-muted">
              Refund address
              <button
                type="button"
                aria-label="About refund address"
                aria-expanded={showRefundInfo}
                title="About refund address"
                onClick={() => setShowRefundInfo(value => !value)}
                className="wallet-interactive flex size-5 items-center justify-center rounded-full"
              >
                <Icon icon="lucide:circle-help" width={15} height={15} />
              </button>
            </span>
            <span className="min-w-0 text-right">
              {refundAccount && (
                <span className="flex items-center justify-end gap-2">
                  <span className="truncate">{refundAccount.accountDisplayName}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {refundIsPrivate
                      ? 'Incognito'
                      : refundNetwork?.chain.family === 'zcash'
                        ? 'Transparent'
                        : 'Public'}
                  </span>
                </span>
              )}
              <span
                className="mt-1 block truncate font-mono text-xs text-muted"
                title={currentRecord.refundAddress}
              >
                {formatSortAddress(currentRecord.refundAddress)}
              </span>
            </span>
          </div>
          {showRefundInfo && (!inline || !canPay || payment?.hasDeposit) && (
            <p className="mt-2 text-xs text-muted">
              If this deposit cannot complete, funds return to this address on the sending network.
            </p>
          )}
          {(!canPay || payment?.hasDeposit) && (
            <div className="mt-5 flex items-center justify-between gap-3">
              <h2
                role="status"
                className={`text-base font-medium ${hasDepositSettlementShortfall(currentRecord) ? 'text-warning' : ''}`}
              >
                {depositStatusLabel(currentRecord, now)}
              </h2>
              <button
                type="button"
                onClick={() => {
                  if (inline) void createAddress(true)
                  else {
                    setRecord(null)
                    setOpen(false)
                    setError(null)
                    pendingRequest.current = null
                  }
                }}
                className="wallet-interactive text-sm text-primary hover:underline"
              >
                New address
              </button>
            </div>
          )}
          {currentRecord.phase === 'awaiting-payment' &&
            hasExternalShieldDepositFunding(currentRecord) &&
            now >= currentRecord.expiresAt && (
              <p role="status" className="mt-1 text-xs text-muted">
                Payment window closed
              </p>
            )}
          {(!canPay || payment?.hasDeposit || currentRecord.settledOutputRaw) && (
            <div className="mt-5 space-y-2 border-t border-white/10 pt-4">
              {!canPay && (
                <p className="flex justify-between gap-4">
                  <span className="text-muted">Amount</span>
                  <span className="break-all text-right">
                    {formatDepositAmount(
                      payment?.paymentAmountRaw ?? currentRecord.amountRaw,
                      currentRecord.sourceDecimals
                    ) ?? '-'}{' '}
                    {symbol}
                  </span>
                </p>
              )}
              {payment?.hasDeposit && currentRecord.phase === 'awaiting-payment' && (
                <>
                  <p className="flex justify-between gap-4">
                    <span className="text-muted">Deposited</span>
                    <span className="break-all text-right">
                      {formatDepositAmount(
                        currentRecord.depositedAmountRaw ?? '0',
                        currentRecord.sourceDecimals
                      ) ?? '-'}{' '}
                      {symbol}
                    </span>
                  </p>
                  <p className="flex justify-between gap-4">
                    <span className="text-muted">Remaining</span>
                    <span className="break-all text-right">
                      {formatDepositAmount(payment.remainingRaw, currentRecord.sourceDecimals) ??
                        '-'}{' '}
                      {symbol}
                    </span>
                  </p>
                </>
              )}
              {!canPay && (
                <>
                  <p className="flex justify-between gap-4">
                    <span className="text-muted">Estimated receive</span>
                    <span className="break-all text-right">
                      {formatDepositAmount(
                        currentRecord.expectedOutputRaw,
                        currentRecord.sourceDecimals
                      ) ?? '-'}{' '}
                      {symbol}
                    </span>
                  </p>
                  <p className="flex justify-between gap-4">
                    <span className="text-muted">Minimum receive</span>
                    <span className="break-all text-right">
                      {formatDepositAmount(
                        currentRecord.minimumOutputRaw,
                        currentRecord.sourceDecimals
                      ) ?? '-'}{' '}
                      {symbol}
                    </span>
                  </p>
                </>
              )}
              {currentRecord.settledOutputRaw && (
                <p className="flex justify-between gap-4">
                  <span className="text-muted">Received</span>
                  <span className="break-all text-right">
                    {formatDepositAmount(
                      currentRecord.settledOutputRaw,
                      currentRecord.sourceDecimals
                    ) ?? '-'}{' '}
                    {symbol}
                  </span>
                </p>
              )}
            </div>
          )}
          {checked && (
            <p role="status" className="mt-3 text-xs text-muted">
              Checked: {depositStatusLabel(currentRecord, now)}
            </p>
          )}
          <TransactionNotice
            message={checkError}
            onRetry={checkError ? () => void checkStatus() : undefined}
            retrying={refreshing}
            className="mt-3"
          />
          {inline && (!canPay || payment?.hasDeposit) && statusAction && (
            <div className="mt-2 flex justify-end">{statusAction}</div>
          )}
        </div>
      ) : (
        <div className={inline ? 'mt-12 w-full' : 'mt-8 w-full'}>
          <p className="mb-2 text-base text-muted">Receive address</p>
          <div className="flex min-h-12 items-center gap-2 rounded-lg bg-wallet-surface px-3">
            <span className="min-w-0 flex-1 truncate font-mono text-sm" title={zcashAddress}>
              {zcashAddress ? formatSortAddress(zcashAddress) : ''}
            </span>
            <button
              type="button"
              aria-label="Copy Zcash shielded address"
              disabled={!zcashAddress}
              onClick={() =>
                zcashAddress && void copyToClipboard(zcashAddress, 'zcash-shield-address')
              }
              className="wallet-interactive flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-wallet-selected px-3 disabled:opacity-45"
            >
              <CopyFeedbackIcon copied={isCopied('zcash-shield-address')} width={16} />
              {isCopied('zcash-shield-address') ? 'Copied' : 'Copy'}
            </button>
          </div>
          {inline && inlineWarning}
        </div>
      )}
    </ReceivingAddressLayout>
  )

  if (inline) {
    return (
      <>
        {currentRecord || (provider === 'zcash-shield' && zcashAddress) ? (
          addressContent
        ) : !error && canGenerate ? (
          <ShieldReceiveAddressSkeleton />
        ) : (
          <div className="mt-5">
            {error ? (
              <TransactionNotice
                message={error}
                onRetry={() => void createAddress()}
                retrying={busy}
              />
            ) : (
              <TransactionNotice tone="muted" message="Receiving address unavailable" />
            )}
          </div>
        )}
        <CopyToast show={showToast} />
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        disabled={!canGenerate || busy}
        aria-busy={busy || undefined}
        onClick={() => void createAddress()}
        className="wallet-interactive h-11 w-full rounded-lg bg-primary text-sm font-medium text-background enabled:hover:brightness-110 enabled:active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
      >
        {busy ? 'Generating...' : 'Generate QR Code'}
      </button>
      {error && <TransactionNotice message={error} className="mt-2" />}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          position="bottom"
          showCloseButton={false}
          scroll="body"
          className="gap-0 p-0"
        >
          <DialogTitle className="sr-only">Receiving Address</DialogTitle>
          <DialogDescription className="sr-only">
            Address and QR code for the selected asset
          </DialogDescription>
          {addressContent}
        </DialogContent>
      </Dialog>
      <CopyToast show={showToast} />
    </>
  )
}
