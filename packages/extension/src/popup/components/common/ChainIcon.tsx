import { GENERIC_CHAIN_ICON_URL, isDynamicEvmChainIcon } from '@/config/icons'
import { formatChainIconUrl, resolveRemoteEvmChainIconUrl } from '@/lib/chain-icon'
import { formatChainName } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'

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
  const [remoteIcon, setRemoteIcon] = useState<{ chain: string; url: string } | null>(null)
  const iconUrl = remoteIcon?.chain === chain ? remoteIcon.url : formatChainIconUrl(chain)
  const [loadedIconUrl, setLoadedIconUrl] = useState<string | null>(null)
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null)
  const hasFailed = failedIconUrl === iconUrl
  const displayedIconUrl = hasFailed ? GENERIC_CHAIN_ICON_URL : iconUrl
  const isLoaded = loadedIconUrl === displayedIconUrl

  useEffect(() => {
    if (!isDynamicEvmChainIcon(chain)) return
    let cancelled = false
    void resolveRemoteEvmChainIconUrl(chain).then(url => {
      if (!cancelled && url) setRemoteIcon({ chain, url })
    })
    return () => {
      cancelled = true
    }
  }, [chain])

  return (
    <img
      src={displayedIconUrl}
      alt={alt || chainName}
      crossOrigin={crossOrigin}
      className={cn('bg-card object-cover', !isLoaded && 'animate-pulse', className)}
      title={showTooltip ? chainName : undefined}
      onLoad={event => {
        setLoadedIconUrl(displayedIconUrl)
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
