import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { ChainIcon } from '../common/ChainIcon'
import type { ActivityInteractionPresentation } from './activity-interaction-adapters'

interface ActivityInteractionIconProps {
  readonly presentation: ActivityInteractionPresentation
  readonly chainIconAlias?: string
  readonly size?: 'row' | 'hero'
}

export function ActivityInteractionIcon({
  presentation,
  chainIconAlias,
  size = 'row'
}: ActivityInteractionIconProps) {
  const isHero = size === 'hero'
  const resolvedChainIconAlias = chainIconAlias ?? presentation.fallbackChainIconAlias

  return (
    <div
      className={cn('relative shrink-0', isHero ? 'size-16' : 'size-9')}
      data-activity-avatar="contract"
      data-activity-interaction-family={presentation.family}
    >
      <div
        className={cn(
          'flex items-center justify-center rounded-full bg-foreground/8 text-foreground',
          isHero ? 'size-16' : 'size-9'
        )}
      >
        <Icon icon={presentation.icon} width={isHero ? 28 : 18} height={isHero ? 28 : 18} />
      </div>
      {resolvedChainIconAlias && (
        <ChainIcon
          chain={resolvedChainIconAlias}
          width={isHero ? 22 : 16}
          height={isHero ? 22 : 16}
          className={cn(
            'absolute z-20 rounded-[5px] bg-background ring-2 ring-background',
            isHero ? '-bottom-0.5 -right-0.5 size-[22px]' : '-bottom-0.5 -right-0.5 size-4'
          )}
          showTooltip={false}
          alt=""
          aria-hidden="true"
          data-activity-chain-badge
        />
      )}
    </div>
  )
}
