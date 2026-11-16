import { useNavigate } from '../../provider/Router'

interface PageHeaderProps {
  title?: string
  onBack?: () => void
  showBack?: boolean
  backDisabled?: boolean
  rightContent?: React.ReactNode
  action?: {
    ariaLabel: string
    icon: React.ReactNode
    onClick: () => void
  }
}

export function PageHeader({
  title = 'Noir Wallet',
  onBack,
  showBack = false,
  backDisabled = false,
  rightContent,
  action
}: PageHeaderProps) {
  const { goBack } = useNavigate()
  const handleBack = onBack || goBack
  const visibleTitle = title.trim()

  if (!visibleTitle && !showBack && !rightContent && !action) return null

  return (
    <header className="h-14 flex items-center justify-center shrink-0 relative px-4">
      {showBack && (
        <button
          type="button"
          onClick={handleBack}
          disabled={backDisabled}
          aria-label="Back"
          className="wallet-interactive absolute left-3 size-8 rounded-lg text-foreground flex items-center justify-center hover:bg-accent enabled:active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer disabled:pointer-events-none disabled:opacity-50"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width={18}
            height={18}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      )}
      {visibleTitle && (
        <h1 className="text-lg font-medium leading-[23px] text-white">{visibleTitle}</h1>
      )}

      {(rightContent || action) && (
        <div className="absolute right-4 flex items-center">
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              aria-label={action.ariaLabel}
              className="wallet-interactive w-[26px] h-[26px] flex items-center justify-center rounded-full hover:bg-accent enabled:active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring text-muted-foreground hover:text-foreground"
            >
              {action.icon}
            </button>
          )}
          {rightContent}
        </div>
      )}
    </header>
  )
}
