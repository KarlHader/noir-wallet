import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { loadHomeAd, readCachedHomeAd } from '../../services/home-ad-client'

export function HomeAdBanner() {
  const [ad, setAd] = useState(readCachedHomeAd)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let active = true
    void loadHomeAd(next => {
      if (active) setAd(next)
    }).catch(() => {})
    return () => {
      active = false
    }
  }, [])

  if (!ad || dismissed) return null

  return (
    <div className="relative mx-4 mb-3 shrink-0 overflow-hidden rounded-xl">
      <a
        href={ad.jumpUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${ad.title}. ${ad.text}`}
        data-analytics-outbound="home_ad"
        data-analytics-domain={new URL(ad.jumpUrl).hostname}
        className="block focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      >
        <img src={ad.imageSrc} alt="" className="block max-h-24 w-full object-contain" />
      </a>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss advertisement"
        className="absolute right-1 top-1 grid size-6 cursor-pointer place-items-center rounded-full bg-black/55 text-white/80 hover:text-white focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Icon icon="lucide:x" width={13} height={13} />
      </button>
    </div>
  )
}
