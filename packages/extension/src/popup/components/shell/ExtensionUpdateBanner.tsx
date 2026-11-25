import { Icon } from '@iconify/react'
import { useExtensionUpdate } from '../../hooks/useExtensionUpdate'
import { useNavigate } from '../../provider/Router'

export function ExtensionUpdateBanner() {
  const { state, isLoading } = useExtensionUpdate()
  const { navigate } = useNavigate()

  if (isLoading || state?.status !== 'available') return null

  return (
    <div className="px-4 pb-2">
      <button
        type="button"
        onClick={() => navigate('/update?from=wallet')}
        className="w-full rounded-xl border border-primary/25 bg-primary/10 px-3 py-2.5 text-left hover:bg-primary/15 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Icon icon="lucide:download" width={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Version {state.version} is ready</p>
            <p className="text-xs text-muted">Restart Noir Wallet to update</p>
          </div>
          <Icon icon="lucide:chevron-right" width={16} className="shrink-0 text-muted" />
        </div>
      </button>
    </div>
  )
}
