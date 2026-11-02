import { Icon } from '@iconify/react'
import { Button } from '@/popup/components/ui/button'
import { InlineError } from '@/popup/components/common/InlineError'

/**
 * Full-page status notice with a primary action, used by hardware tab flows
 * for success / failure / invalid-request states.
 */
export function CenteredNotice({
  icon,
  iconClass,
  title,
  description,
  actionText,
  onAction,
  secondaryText,
  onSecondary,
  onRetry
}: {
  icon: string
  iconClass: string
  title: string
  description: string
  actionText: string
  onAction: () => void
  secondaryText?: string
  onSecondary?: () => void
  onRetry?: () => void
}) {
  return (
    <>
      <div className="page-content flex flex-col items-center justify-center">
        <Icon icon={icon} width={40} height={40} className={`${iconClass} mb-4`} />
        <h2 className="text-base font-semibold mb-2">{title}</h2>
        {onRetry ? (
          <InlineError className="w-full" message={description} onRetry={onRetry} />
        ) : (
          <p className="text-sm text-muted text-center break-words max-w-full">{description}</p>
        )}
      </div>
      <div className="page-footer space-y-3">
        {!onRetry && (
          <Button onClick={onAction} className="w-full h-[45px]">
            {actionText}
          </Button>
        )}
        {secondaryText && onSecondary && (
          <Button variant="outline" onClick={onSecondary} className="w-full h-[45px]">
            {secondaryText}
          </Button>
        )}
      </div>
    </>
  )
}
