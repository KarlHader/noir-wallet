import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { formatBaseUnitAmount, formatTokenQuantity } from '@/lib/number-format'
import { SendAmountInputCard } from '@/popup/components/transaction/SendInputCards'
import { formatSortAddress } from '@/lib/format'

import { ExecutionAccountBadge } from '@/popup/components/account/ExecutionAccountSelector'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Button } from '@/popup/components/ui/button'
import { InlineError } from '@/popup/components/common/InlineError'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import {
  estimateConfidentialTransferMaximum,
  fallbackTransferMaximum,
  createNativeTransferSource
} from '@/popup/services/transfer-maximum'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import {
  normalizePrivateBalanceTransferInput,
  resolvePrivateBalanceTransferAmount,
  resolvePrivateBalanceTransferSource,
  type PrivateBalanceTransferDirection
} from '@/popup/services/private-balance-transfer'

interface TransferAccountRowProps {
  readonly account: 'main' | 'private'
  readonly assetId: string
  readonly symbol: string
  readonly icon?: string
  readonly blockchain?: string
  readonly balance: string
  readonly address: string
}

function TransferAccountRow({
  account,
  assetId,
  symbol,
  icon,
  blockchain,
  balance,
  address
}: TransferAccountRowProps) {
  return (
    <div className="flex min-h-16 flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card/55 px-3.5 py-3">
      <TokenIcon assetId={assetId} symbol={symbol} icon={icon} blockchain={blockchain} size={36} />
      <div className="min-w-[7rem] flex-1">
        <ExecutionAccountBadge mode={account === 'private' ? 'private' : 'main'} />
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={address}>
          {formatSortAddress(address)}
        </p>
      </div>
      <p
        className="ml-auto max-w-full break-all text-right font-mono text-sm"
        title={`${balance} ${symbol}`}
      >
        {formatTokenQuantity(balance)} {symbol}
      </p>
    </div>
  )
}

export function PrivateBalanceTransferDialog({
  open,
  onOpenChange,
  defaultDirection,
  assetId,
  symbol,
  icon,
  blockchain,
  decimals,
  priceUsd,
  mainBalanceRaw,
  privateBalanceRaw,
  unavailableReason,
  loading = false,
  lockDirection = false,
  asset,
  chain,
  mainAddress,
  privateAddress,
  onRetryAvailability,
  onContinue
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly defaultDirection: PrivateBalanceTransferDirection
  readonly assetId: string
  readonly symbol: string
  readonly icon?: string
  readonly blockchain?: string
  readonly decimals: number
  readonly priceUsd?: string | number | null
  readonly mainBalanceRaw: string
  readonly privateBalanceRaw: string
  readonly unavailableReason: string | null
  readonly loading?: boolean
  readonly lockDirection?: boolean
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly mainAddress: string
  readonly privateAddress: string
  readonly onRetryAvailability?: () => void
  readonly onContinue: (
    direction: PrivateBalanceTransferDirection,
    amount: string,
    maximum: boolean
  ) => void
}) {
  const [direction, setDirection] = useState<PrivateBalanceTransferDirection>(defaultDirection)
  const [amount, setAmount] = useState('')
  const [maxSelected, setMaxSelected] = useState(false)

  useEffect(() => {
    if (!open) return
    setDirection(defaultDirection)
    setAmount('')
    setMaxSelected(false)
  }, [defaultDirection, open])

  const mainBalance = formatBaseUnitAmount(mainBalanceRaw, decimals)
  const privateBalance = formatBaseUnitAmount(privateBalanceRaw, decimals)
  const mainToPrivate = direction === 'main-to-private'
  const source = resolvePrivateBalanceTransferSource({
    direction,
    mainBalanceRaw,
    privateBalanceRaw,
    mainAddress,
    privateAddress
  })
  const availableRaw = source.availableRaw
  const maximum = useTransferMaximum({
    enabled:
      open &&
      !loading &&
      unavailableReason === null &&
      asset.asset.kind === 'native' &&
      BigInt(availableRaw) > 0n,
    requestKey: `${assetId}:${direction}:${mainAddress}:${privateAddress}:${availableRaw}`,
    fallback: () =>
      fallbackTransferMaximum(
        createNativeTransferSource({
          asset,
          chain,
          availableRaw,
          sender: source.sender
        })
      ),
    estimate: () =>
      estimateConfidentialTransferMaximum({
        asset,
        chain,
        availableRaw,
        sender: source.sender,
        recipient: source.recipient,
        executionMode: source.executionMode
      })
  })
  const transferAvailability = resolvePortfolioTransferAvailability({
    balanceRaw: availableRaw,
    decimals,
    isNative: asset.asset.kind === 'native',
    maximumRaw: maximum.value?.amountRaw ?? null
  })
  const spendableRaw = transferAvailability.amountRaw
  const available = transferAvailability.display
  useEffect(() => {
    if (maxSelected) setAmount(available)
  }, [maxSelected, available])
  const amountState = useMemo(
    () =>
      resolvePrivateBalanceTransferAmount({
        amount,
        decimals,
        availableRaw: spendableRaw,
        sourceLabel: source.sourceLabel
      }),
    [amount, spendableRaw, decimals, source.sourceLabel]
  )
  const error = (loading ? null : unavailableReason) ?? amountState.error
  const canContinue = !loading && unavailableReason === null && amountState.amountRaw !== null

  const switchDirection = () => {
    setDirection(current => (current === 'main-to-private' ? 'private-to-main' : 'main-to-private'))
    setAmount('')
    setMaxSelected(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        position="bottom"
        className="max-h-[calc(100vh-32px)] gap-0 overflow-y-auto p-0"
        showCloseButton
      >
        <DialogHeader className="px-5 pb-4 pt-5 text-left">
          <DialogTitle>Transfer {symbol}</DialogTitle>
          <DialogDescription className="sr-only">
            Move this asset between the Public and Confidential accounts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-4 pb-5">
          <div className="relative space-y-2" aria-label="Transfer direction">
            <div>
              <p className="mb-1.5 px-1 text-xs text-muted">From</p>
              <TransferAccountRow
                account={mainToPrivate ? 'main' : 'private'}
                assetId={assetId}
                symbol={symbol}
                icon={icon}
                blockchain={blockchain}
                balance={mainToPrivate ? mainBalance : privateBalance}
                address={mainToPrivate ? mainAddress : privateAddress}
              />
            </div>
            <div>
              <p className="mb-1.5 px-1 text-xs text-muted">To</p>
              <TransferAccountRow
                account={mainToPrivate ? 'private' : 'main'}
                assetId={assetId}
                symbol={symbol}
                icon={icon}
                blockchain={blockchain}
                balance={mainToPrivate ? privateBalance : mainBalance}
                address={mainToPrivate ? privateAddress : mainAddress}
              />
            </div>
            {!lockDirection && (
              <button
                type="button"
                aria-label="Switch transfer direction"
                onClick={switchDirection}
                className="absolute left-1/2 top-[calc(50%+2px)] z-10 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md transition-colors hover:border-primary/40 hover:text-primary"
              >
                <Icon icon="lucide:arrow-up-down" width={19} height={19} />
              </button>
            )}
          </div>

          <SendAmountInputCard
            ariaLabel="Transfer amount"
            value={amount}
            onChange={value => {
              const normalized = normalizePrivateBalanceTransferInput(value)
              if (normalized !== null) {
                setMaxSelected(false)
                setAmount(normalized)
              }
            }}
            available={available}
            availableLabel={transferAvailability.label}
            symbol={symbol}
            priceUsd={priceUsd}
            onMax={() => {
              setMaxSelected(true)
              if (asset.asset.kind === 'native') void maximum.request()
              else setAmount(available)
            }}
            maxSelected={maxSelected}
            maxLoading={maximum.loading}
            maxDisabled={BigInt(availableRaw) === 0n || loading || unavailableReason !== null}
            invalid={Boolean(error && amount.length > 0)}
            testId="private-balance-transfer-amount"
          />

          {error && (
            <InlineError
              message={error}
              onRetry={onRetryAvailability}
              retrying={loading}
              className="px-1 leading-4"
            />
          )}

          <Button
            className="h-11 w-full"
            disabled={!canContinue}
            isLoading={loading}
            onClick={() => onContinue(direction, amount, maxSelected)}
          >
            Review transfer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
