import { cn } from '@/lib/utils'
import { TokenIcon } from '../tokens/TokenIcon'
import {
  hasMatchingActivityTokenIcons,
  type ActivitySwapPresentation
} from './multichain-activity-presentation'

export function ActivityRouteTokenIcons({
  route,
  size = 'row'
}: {
  readonly route: ActivitySwapPresentation
  readonly size?: 'row' | 'detail'
}) {
  const matching = hasMatchingActivityTokenIcons(route)
  const iconSize = size === 'detail' ? 40 : matching ? 36 : 30
  return (
    <div
      data-activity-avatar="swap"
      className={cn('relative shrink-0', size === 'detail' ? 'h-10 w-16' : 'size-9')}
    >
      <TokenIcon
        assetId={route.source?.assetId}
        symbol={route.source?.symbol ?? 'Asset'}
        icon={route.source?.iconUrl}
        size={iconSize}
        className={cn('absolute top-0', size === 'detail' && matching ? 'left-3' : 'left-0')}
      />
      {!matching && (
        <TokenIcon
          assetId={route.destination?.assetId}
          symbol={route.destination?.symbol ?? 'Asset'}
          icon={route.destination?.iconUrl}
          size={iconSize}
          className={cn(
            'absolute top-0 rounded-full ring-2 ring-background',
            size === 'detail' ? 'left-6' : 'left-3.5'
          )}
        />
      )}
    </div>
  )
}
