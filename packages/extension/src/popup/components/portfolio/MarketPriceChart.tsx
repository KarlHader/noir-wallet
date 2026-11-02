import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { AssetMarketHistoryPoint, AssetMarketHistoryRange } from '@/core/prices'
import { formatTimestamp } from '@/lib/format'
import { formatTokenPrice } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/popup/components/ui/skeleton'
import {
  buildMarketPriceChartModel,
  MARKET_PRICE_CHART_HEIGHT,
  MARKET_PRICE_CHART_PLOT_TOP,
  MARKET_PRICE_CHART_WIDTH,
  normalizeMarketPriceTimestamp
} from '@/popup/services/market-price-chart-model'

const RANGE_LABELS: Readonly<Record<AssetMarketHistoryRange, string>> = Object.freeze({
  '1d': '1D',
  '1w': '1W',
  '1m': '1M',
  '3m': '3M',
  '1y': '1Y',
  all: 'All'
})

// Ranges that span less than a few days show the time of day in the hover label.
const INTRADAY_RANGES: ReadonlySet<AssetMarketHistoryRange> = new Set(['1d', '1w'])

interface MarketPriceChartProps {
  readonly points: readonly AssetMarketHistoryPoint[] | null
  readonly range: AssetMarketHistoryRange
  readonly loading: boolean
  readonly priceLoading: boolean
  readonly priceLabel: string | null
  readonly changeLabel: string | null
  readonly changeDirection: 'positive' | 'negative' | 'neutral'
  readonly delayed: boolean
  readonly showRanges?: boolean
  readonly availableRanges: readonly AssetMarketHistoryRange[]
  readonly onRangeChange: (range: AssetMarketHistoryRange) => void
}

export function MarketPriceChart({
  points,
  range,
  loading,
  priceLoading,
  priceLabel,
  changeLabel,
  changeDirection,
  delayed,
  showRanges = true,
  availableRanges,
  onRangeChange
}: MarketPriceChartProps) {
  const gradientId = useId().replace(/:/g, '')
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const chart = useMemo(() => buildMarketPriceChartModel(points), [points])

  const color = chart?.positive ? 'var(--color-success)' : 'var(--color-destructive)'
  // Replay the draw animation whenever the plotted series changes.
  const drawKey = `${range}:${chart?.coordinates.length ?? 0}`

  const active = chart && activeIndex !== null ? (chart.coordinates[activeIndex] ?? null) : null

  const updateActiveFromPointer = useCallback(
    (clientX: number) => {
      const surface = surfaceRef.current
      if (!surface || !chart) return
      const rect = surface.getBoundingClientRect()
      if (rect.width === 0) return
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const index = Math.round(ratio * (chart.coordinates.length - 1))
      setActiveIndex(index)
    },
    [chart]
  )

  const hoverDateLabel = active
    ? formatTimestamp(
        normalizeMarketPriceTimestamp(active.timestamp),
        INTRADAY_RANGES.has(range) ? 'MMM D · HH:mm' : 'MMM D, YYYY'
      )
    : null

  return (
    <div>
      <div
        ref={surfaceRef}
        className="relative h-[148px] touch-none overflow-hidden"
        aria-live="polite"
        onPointerMove={event => {
          if (chart) updateActiveFromPointer(event.clientX)
        }}
        onPointerDown={event => {
          if (chart) updateActiveFromPointer(event.clientX)
        }}
        onPointerLeave={() => setActiveIndex(null)}
      >
        <div className="absolute left-0 top-0 z-10">
          {priceLoading && !priceLabel ? (
            <>
              <Skeleton className="h-7 w-24" />
              <Skeleton className="mt-1.5 h-3 w-16" />
            </>
          ) : (
            <>
              <p className="text-[26px] font-medium leading-none tracking-tight tabular-nums">
                {active
                  ? formatTokenPrice(active.priceUsd, { showSign: true })
                  : (priceLabel ?? '—')}
              </p>
              <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                {active ? (
                  <span className="text-muted">{hoverDateLabel}</span>
                ) : (
                  <>
                    <span
                      className={cn(
                        'font-medium',
                        changeDirection === 'positive'
                          ? 'text-success'
                          : changeDirection === 'negative'
                            ? 'text-danger'
                            : 'text-muted'
                      )}
                    >
                      {changeLabel ?? '—'}
                    </span>
                    <span className="text-muted">24h</span>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {delayed && !active && (
          <span className="absolute right-0 top-1 z-10 flex items-center gap-1 text-[11px] text-muted">
            <Icon icon="lucide:clock-3" width={12} height={12} />
            Delayed
          </span>
        )}
        {loading && !chart ? (
          <Skeleton className="absolute inset-x-0 bottom-0 h-[92px] rounded-xl" />
        ) : chart ? (
          <>
            <svg
              role="img"
              aria-label={`${RANGE_LABELS[range]} price history`}
              viewBox={`0 0 ${MARKET_PRICE_CHART_WIDTH} ${MARKET_PRICE_CHART_HEIGHT}`}
              preserveAspectRatio="none"
              className={cn('h-full w-full transition-opacity', loading && 'opacity-55')}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                key={`area:${drawKey}`}
                d={chart.area}
                fill={`url(#${gradientId})`}
                className="animate-in fade-in duration-700"
              />
              <path
                d={chart.line}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {active && (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-0 z-10 w-px bg-white/15"
                  style={{
                    left: `${(active.x / MARKET_PRICE_CHART_WIDTH) * 100}%`,
                    top: `${MARKET_PRICE_CHART_PLOT_TOP}px`
                  }}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
                  style={{
                    left: `${(active.x / MARKET_PRICE_CHART_WIDTH) * 100}%`,
                    top: `${(active.y / MARKET_PRICE_CHART_HEIGHT) * 100}%`,
                    backgroundColor: color
                  }}
                />
              </>
            )}
          </>
        ) : null}
      </div>

      {showRanges && (
        <div className="mt-2 flex gap-1" aria-label="Price history range">
          {availableRanges.map(item => (
            <button
              key={item}
              type="button"
              aria-pressed={range === item}
              onClick={() => onRangeChange(item)}
              className={cn(
                'h-7 flex-1 rounded-md text-[11px] font-medium transition-colors',
                range === item
                  ? 'bg-white/10 text-foreground'
                  : 'text-muted hover:bg-white/5 hover:text-foreground'
              )}
            >
              {RANGE_LABELS[item]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
