import { formatFiatAmount, formatTokenPrice, formatTokenQuantity } from '@/lib/number-format'
import type { NearConfidentialHolding } from '@/popup/services/near-confidential-holdings'
import type { PortfolioChainView } from '@/core/portfolio'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'

export function NearConfidentialHoldingRow({
  entry,
  balancesHidden,
  chain,
  showProvider = false,
  onClick
}: {
  readonly entry: NearConfidentialHolding
  readonly balancesHidden: boolean
  readonly chain?: PortfolioChainView['chain']
  readonly showProvider?: boolean
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
        blockchain={
          chain ? resolveChainIconAlias(chain.family, chain.displayName, chain.id) : undefined
        }
        size={36}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-base font-medium" title={symbol}>
          {symbol}
        </span>
        <span
          className="block truncate text-xs text-muted"
          title={
            entry.identityLabel ? asset.protocolAssetId : asset.symbol ? undefined : asset.tokenId
          }
        >
          {asset.symbol
            ? showProvider
              ? `${price} · NEAR Confidential`
              : (entry.identityLabel ?? price)
            : asset.tokenId}
        </span>
      </span>
      <span className="min-w-0 max-w-[45%] text-right">
        <span
          className="block break-all text-base font-medium"
          title={balancesHidden ? undefined : (entry.fiat ?? undefined)}
        >
          {balancesHidden
            ? '••••'
            : entry.fiat === null
              ? '—'
              : formatFiatAmount(entry.fiat, { showSign: true })}
        </span>
        <span
          className="block break-all text-xs text-muted"
          title={balancesHidden ? undefined : (entry.amount ?? undefined)}
        >
          {balancesHidden
            ? '••••'
            : entry.amount === null
              ? '—'
              : `${formatTokenQuantity(entry.amount)} ${symbol}`}
        </span>
      </span>
    </>
  )
  const className = 'flex min-h-[72px] w-full min-w-0 items-center gap-3 px-4 py-2.5'
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
