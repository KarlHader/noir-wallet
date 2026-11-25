import { Icon } from '@iconify/react'
import { SOCIAL_LINKS } from '@/config/social-links'

export function SocialLinks() {
  return (
    <div className="flex items-center justify-center gap-2">
      {SOCIAL_LINKS.map(link => (
        <a
          key={link.label}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={link.label}
          title={link.label}
          data-analytics-outbound={`social_${link.label.toLowerCase()}`}
          data-analytics-domain={new URL(link.url).hostname}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/5 hover:text-foreground"
        >
          {link.icon ? (
            <Icon icon={link.icon} width={18} height={18} />
          ) : (
            <span className="text-sm font-medium">X</span>
          )}
        </a>
      ))}
    </div>
  )
}
