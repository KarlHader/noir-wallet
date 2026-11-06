import { formatFiatAmount, formatTokenPrice, formatTokenQuantity } from '@/lib/number-format'
import type { NearConfidentialHolding } from '@/popup/services/near-confidential-holdings'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'

export function NearConfidentialHoldingRow({
  entry,
  balancesHidden,
  onClick
}: {
  readonly entry: NearConfidentialHolding
  readonly balancesHidden: boolean
  readonly onClick?: () => void
}) {
  const { asset } = entry
  const symbol = asset.symbol ?? 'Unknown token'
  const price = entry.priceUsd ? formatTokenPrice(entry.priceUsd, { showSign: true }) : '—'
  const content = (
    <>
      <TokenIcon
        assetId={asset.assetId}
        symbol={asset.symbol ?? '?'}
        icon={asset.iconUrl}
        size={32}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium" title={symbol}>
          {symbol}
        </span>
        <span
          className="block truncate text-xs text-muted"
          title={
            entry.identityLabel ? asset.protocolAssetId : asset.symbol ? undefined : asset.tokenId
          }
        >
          {asset.symbol ? (entry.identityLabel ?? price) : asset.tokenId}
        </span>
      </span>
      <span className="min-w-0 max-w-[45%] text-right">
        <span
          className="block truncate text-sm font-medium"
          title={balancesHidden ? undefined : (entry.fiat ?? undefined)}
        >
          {balancesHidden
            ? '••••'
            : entry.fiat === null
              ? '—'
              : formatFiatAmount(entry.fiat, { showSign: true })}
        </span>
        <span
          className="block truncate text-xs text-muted"
          title={balancesHidden ? undefined : (entry.amount ?? undefined)}
        >
          {balancesHidden
            ? '••••'
            : entry.amount === null
              ? '—'
              : formatTokenQuantity(entry.amount)}
        </span>
      </span>
    </>
  )
  const className = 'flex min-h-[72px] w-full items-center gap-3 px-4 py-2'
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`${className} wallet-interactive hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary`}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}
