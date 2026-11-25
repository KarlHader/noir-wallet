import { useState } from 'react'
import nearConfidentialIcon from '@/images/figma-near-confidential.svg'
import { cn } from '@/lib/utils'
import {
  getRheaProviderIconUrl,
  providerDisplayName
} from '@/popup/services/swap-provider-presentation'

const iconSizes = { 20: 'size-5', 24: 'size-6', 28: 'size-7' }

export function RouteProviderLabel({
  router,
  size = 20,
  className
}: {
  readonly router: string
  readonly size?: keyof typeof iconSizes
  readonly className?: string
}) {
  const name = providerDisplayName(router)
  const iconUrl =
    router.trim().toLowerCase() === 'near-confidential'
      ? nearConfidentialIcon
      : getRheaProviderIconUrl(router)
  const [failedIcon, setFailedIcon] = useState<string | null>(null)

  return (
    <span
      className={cn('inline-flex min-w-0 max-w-full items-center gap-2 align-middle', className)}
    >
      {iconUrl && failedIcon !== iconUrl ? (
        <img
          src={iconUrl}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          alt=""
          width={size}
          height={size}
          className={cn('shrink-0 rounded object-contain', iconSizes[size])}
          onError={() => setFailedIcon(iconUrl)}
        />
      ) : (
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold',
            iconSizes[size]
          )}
          aria-hidden="true"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
    </span>
  )
}
