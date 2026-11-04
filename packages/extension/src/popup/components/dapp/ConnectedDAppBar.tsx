import { useState } from 'react'
import { Icon } from '@iconify/react'
import type { ConnectedDApp } from '@/core/dapp/dapp-manager'
import { presentDAppPermissions } from '@/popup/services/dapp-connection-presentation'
import { ChainIcon } from '../common/ChainIcon'
import { toast } from '@/store/toast-store'

export function ConnectedDAppBar({
  dapp,
  onManage,
  onDisconnect
}: {
  readonly dapp: ConnectedDApp
  readonly onManage: () => void
  readonly onDisconnect: (origin: string) => Promise<void>
}) {
  const [disconnecting, setDisconnecting] = useState(false)
  const permissions = presentDAppPermissions(dapp)
  return (
    <footer
      aria-label="Current dApp connection"
      className="flex h-16 shrink-0 items-center gap-3 bg-wallet-surface px-4 py-3"
    >
      <button
        type="button"
        onClick={onManage}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <img
          src={dapp.favicon || 'icons/icon128.png'}
          alt=""
          className="size-9 shrink-0 rounded-lg"
          crossOrigin="anonymous"
          onError={event => {
            event.currentTarget.src = 'icons/icon128.png'
          }}
        />
        <span className="min-w-0">
          <span className="block truncate text-base font-medium">{dapp.name}</span>
          <span className="block truncate text-xs text-muted">{dapp.host}</span>
        </span>
      </button>
      {permissions.length > 0 && (
        <button
          type="button"
          aria-label="View connected networks"
          onClick={onManage}
          className="flex h-[30px] items-center gap-1 rounded-lg bg-white/10 px-1.5"
        >
          <ChainIcon chain={permissions[0].iconChain} width={18} height={18} showTooltip={false} />
          {permissions.length > 1 && (
            <span className="text-xs text-muted">+{permissions.length - 1}</span>
          )}
          <Icon icon="lucide:chevron-down" width={12} height={12} />
        </button>
      )}
      <button
        type="button"
        aria-label={`Disconnect ${dapp.name}`}
        disabled={disconnecting}
        className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-white/10 text-muted hover:text-foreground disabled:opacity-50"
        onClick={async () => {
          setDisconnecting(true)
          try {
            await onDisconnect(dapp.origin)
          } catch {
            toast.error('Unable to disconnect dApp')
          } finally {
            setDisconnecting(false)
          }
        }}
      >
        <Icon
          icon={disconnecting ? 'lucide:loader-circle' : 'lucide:unplug'}
          width={16}
          height={16}
          className={disconnecting ? 'animate-spin' : ''}
        />
      </button>
    </footer>
  )
}
