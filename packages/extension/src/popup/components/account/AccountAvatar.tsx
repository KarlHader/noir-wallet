import { useState, type ImgHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { getAccountAvatarSrc } from '@/popup/lib/account-avatars'

interface AccountAvatarProps extends Pick<
  ImgHTMLAttributes<HTMLImageElement>,
  'width' | 'height' | 'className' | 'title'
> {
  readonly walletId: string | null
}

export function AccountAvatar({ walletId, ...props }: AccountAvatarProps) {
  const src = getAccountAvatarSrc(walletId)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  if (!src || failedSrc === src) {
    return (
      <svg
        width={props.width}
        height={props.height}
        className={cn('rounded-full bg-card text-muted', props.className)}
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {props.title && <title>{props.title}</title>}
        <circle cx="12" cy="8" r="3" />
        <path d="M6 20v-2a6 6 0 0 1 12 0v2" />
      </svg>
    )
  }

  return (
    <img
      {...props}
      src={src}
      alt=""
      aria-hidden="true"
      referrerPolicy="no-referrer"
      decoding="async"
      onError={() => setFailedSrc(src)}
    />
  )
}
