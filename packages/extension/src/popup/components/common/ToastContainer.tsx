import { Icon } from '@iconify/react'
import { useToastStore, type ToastType } from '@/store/toast-store'

const iconConfig: Record<ToastType, { icon: string; color: string; bg: string }> = {
  success: { icon: 'lucide:check', color: 'text-primary', bg: 'bg-primary/20' },
  error: { icon: 'lucide:x', color: 'text-red-500', bg: 'bg-red-500/20' },
  warning: { icon: 'lucide:alert-triangle', color: 'text-warning', bg: 'bg-warning-surface' },
  info: { icon: 'lucide:info', color: 'text-primary', bg: 'bg-primary/15' }
}

export function ToastContainer() {
  const toasts = useToastStore(state => state.toasts)
  const removeToast = useToastStore(state => state.removeToast)

  if (toasts.length === 0) return null

  const renderToast = (toast: (typeof toasts)[number]) => {
    const config = iconConfig[toast.type]
    if (toast.variant === 'bottom-action') {
      return (
        <div
          key={toast.id}
          data-toast-variant="bottom-action"
          className="pointer-events-auto w-full max-w-[351px] animate-in rounded-2xl border border-white/15 bg-[#24242d]/98 px-4 py-3.5 shadow-[0_18px_42px_rgba(0,0,0,0.58)] backdrop-blur-2xl fade-in slide-in-from-bottom-3 duration-200"
        >
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Icon icon="lucide:book-user" width={18} height={18} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-5 text-white">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 truncate font-mono text-[11px] leading-4 text-white/55">
                  {toast.description}
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                removeToast(toast.id)
                toast.secondaryAction?.onClick()
              }}
              className="h-8 rounded-lg px-3 text-xs font-medium text-white/65 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              {toast.secondaryAction?.label ?? 'Not now'}
            </button>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  removeToast(toast.id)
                  toast.action?.onClick()
                }}
                className="h-8 rounded-lg bg-primary px-3.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                {toast.action.label}
              </button>
            )}
          </div>
        </div>
      )
    }
    if (toast.variant === 'notification') {
      return (
        <div
          key={toast.id}
          data-toast-variant="notification"
          className="pointer-events-auto w-full max-w-[351px] animate-in overflow-hidden rounded-2xl border border-white/15 bg-[#242429]/95 shadow-[0_14px_36px_rgba(0,0,0,0.48)] backdrop-blur-2xl fade-in slide-in-from-top-2 duration-200"
        >
          <button
            type="button"
            aria-label={toast.action?.label || toast.title}
            onClick={() => {
              removeToast(toast.id)
              toast.action?.onClick()
            }}
            className="grid w-full grid-cols-[44px_minmax(0,1fr)] items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.04] active:bg-white/[0.07]"
          >
            <img
              src="/icons/icon128.png"
              alt=""
              className="size-11 shrink-0 rounded-[12px] shadow-[0_2px_8px_rgba(0,0,0,0.35)]"
            />
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-sm font-semibold leading-5 text-white">{toast.title}</p>
                <span className="shrink-0 text-[11px] leading-4 text-muted">Now</span>
              </div>
              {toast.description && (
                <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-white/65">
                  {toast.description}
                </p>
              )}
            </div>
          </button>
        </div>
      )
    }

    return (
      <div
        key={toast.id}
        data-toast-variant="compact"
        className={`pointer-events-auto w-full max-w-[340px] animate-in rounded-xl border px-4 py-3 shadow-lg fade-in slide-in-from-top-2 duration-200 ${toast.type === 'warning' ? 'border-warning/20 bg-warning-surface' : 'border-white/10 bg-card'}`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex size-8 shrink-0 items-center justify-center rounded-full ${config.bg}`}
          >
            <Icon icon={config.icon} width={16} height={16} className={config.color} />
          </div>
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-medium ${toast.type === 'warning' ? 'text-warning' : ''}`}>
              {toast.title}
            </p>
            {toast.description && (
              <p
                className={`mt-0.5 text-xs ${toast.type === 'warning' ? 'text-warning' : 'text-muted'}`}
              >
                {toast.description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => removeToast(toast.id)}
            className="shrink-0 text-muted transition-colors hover:text-white"
          >
            <Icon icon="lucide:x" width={14} height={14} />
          </button>
        </div>
      </div>
    )
  }

  const topToasts = toasts.filter(toast => toast.variant !== 'bottom-action')
  const bottomToasts = toasts.filter(toast => toast.variant === 'bottom-action')

  return (
    <>
      {topToasts.length > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3"
        >
          {topToasts.map(renderToast)}
        </div>
      )}
      {bottomToasts.length > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex flex-col items-center gap-2 px-3"
        >
          {bottomToasts.map(renderToast)}
        </div>
      )}
    </>
  )
}
