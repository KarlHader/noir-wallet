import { formatChainIconUrl } from '@/lib/chain-icon'
import { formatChainName } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Icon } from '@iconify/react'
import { useState } from 'react'

interface ChainIconProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  chain: string
  showTooltip?: boolean
}

export function ChainIcon({
  chain,
  className,
  showTooltip = true,
  alt,
  crossOrigin,
  onLoad,
  onError,
  ...props
}: ChainIconProps) {
  const chainName = formatChainName(chain)
  const iconUrl = formatChainIconUrl(chain)
  const [loadedIconUrl, setLoadedIconUrl] = useState<string | null>(null)
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null)
  const isLoaded = loadedIconUrl === iconUrl

  if (!iconUrl || failedIconUrl === iconUrl) {
    return (
      <span
        role="img"
        aria-label={alt || chainName}
        className={cn(
          'inline-flex items-center justify-center rounded-[20%] bg-card text-muted',
          className
        )}
        style={{ width: props.width, height: props.height, ...props.style }}
        title={showTooltip ? chainName : undefined}
      >
        <Icon icon="lucide:network" className="size-[65%]" aria-hidden="true" />
      </span>
    )
  }

  return (
    <img
      src={iconUrl}
      alt={alt || chainName}
      crossOrigin={crossOrigin}
      className={cn(
        'bg-card object-cover',
        !isLoaded && 'animate-pulse',
        className,
        'rounded-[20%]'
      )}
      title={showTooltip ? chainName : undefined}
      onLoad={event => {
        setLoadedIconUrl(iconUrl)
        onLoad?.(event)
      }}
      onError={event => {
        setFailedIconUrl(iconUrl)
        onError?.(event)
      }}
      {...props}
    />
  )
}
