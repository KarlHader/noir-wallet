import { cn } from '@/lib/utils'
import type { ActivityItem } from '@/core/activity'
import { TokenIcon } from '../tokens/TokenIcon'
import {
  hasMatchingActivityTokenIcons,
  type ActivitySwapPresentation
} from '@/popup/services/multichain-activity-presentation'

export function ActivityRouteTokenIcons({
  item,
  route,
  size = 'row'
}: {
  readonly item: ActivityItem
  readonly route: ActivitySwapPresentation
  readonly size?: 'row' | 'detail'
}) {
  const exchange = item.snapshot?.shield
    ? item.snapshot.shield.operation === 'swap'
    : item.kind === 'swap' && item.snapshot?.protocol?.userAction !== 'transfer'
  const singleAsset = !exchange || hasMatchingActivityTokenIcons(route)
  const primaryAsset =
    !exchange && route.isExternalDeposit
      ? (route.destination ?? route.source)
      : (route.source ?? route.destination)
  const iconSize = size === 'detail' ? 40 : singleAsset ? 36 : 30
  return (
    <div
      data-activity-avatar="swap"
      className={cn(
        'relative shrink-0',
        size === 'detail' ? (singleAsset ? 'size-10' : 'h-10 w-16') : 'size-9'
      )}
    >
      <TokenIcon
        assetId={primaryAsset?.assetId}
        symbol={primaryAsset?.symbol ?? 'Asset'}
        icon={primaryAsset?.iconUrl}
        size={iconSize}
        className="absolute left-0 top-0"
      />
      {!singleAsset && (
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
