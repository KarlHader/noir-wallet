import { useState } from 'react'
import { Icon } from '@iconify/react'
import type { AccountRef, ConnectedDApp } from '@/core/dapp/dapp-manager'
import { presentDAppPermissions } from '@/popup/services/dapp-connection-presentation'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { ChainIcon } from '../common/ChainIcon'
import { toast } from '@/store/toast-store'

export function ConnectedDAppBar({
  dapp,
  account,
  onManage,
  onDisconnect
}: {
  readonly dapp: ConnectedDApp
  readonly account: AccountRef | null
  readonly onManage: () => void
  readonly onDisconnect: (origin: string) => Promise<void>
}) {
  const [disconnecting, setDisconnecting] = useState(false)
  const network = useWalletStore(state => state.currentNetwork)
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)
  const permissions = presentDAppPermissions(dapp, { network, endpointSettings, account })
  return (
    <footer
      aria-label="Current dApp connection"
      className="flex h-16 shrink-0 items-center gap-3 bg-wallet-surface px-4 py-3"
    >
      <button
        type="button"
        onClick={onManage}
        className="wallet-interactive flex min-w-0 flex-1 items-center gap-[9px] rounded-md text-left hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
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
          <span className="block truncate text-base font-normal">{dapp.name}</span>
          <span className="block truncate text-xs text-muted">{dapp.host}</span>
        </span>
      </button>
      {permissions.length > 0 && (
        <button
          type="button"
          aria-label="View connected networks"
          onClick={onManage}
          className="wallet-interactive flex h-[30px] min-w-[51px] shrink-0 items-center justify-between gap-1 rounded-lg bg-wallet-selected/80 px-1.5 hover:bg-wallet-selected active:brightness-90 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          <ChainIcon
            chain={permissions[0].iconChain}
            width={20}
            height={20}
            showTooltip={false}
            className="shrink-0 rounded-full"
          />
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
        className="wallet-interactive flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-wallet-selected/80 text-muted hover:bg-wallet-selected hover:text-foreground active:brightness-90 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
          icon={disconnecting ? 'lucide:loader-circle' : 'lucide:link-2-off'}
          width={16}
          height={16}
          className={disconnecting ? 'animate-spin' : ''}
        />
      </button>
    </footer>
  )
}
