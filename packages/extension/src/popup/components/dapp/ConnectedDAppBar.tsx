import { useState } from 'react'
import { Icon } from '@iconify/react'
import type { AccountRef, ConnectedDApp } from '@/core/dapp/dapp-manager'
import { presentDAppPermissions } from '@/popup/services/dapp-connection-presentation'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { ChainIcon } from '../common/ChainIcon'
import { toast } from '@/store/toast-store'
import { DAppNetworkSelector } from './DAppNetworkSelector'

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
  const hasEvm = permissions.some(
    permission => permission.chainId === 'evm' || permission.chainId.startsWith('eip155:')
  )
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
      {hasEvm ? (
        <DAppNetworkSelector
          key={`${dapp.origin}:${account?.walletId}:${account?.accountId}`}
          origin={dapp.origin}
          account={account}
        />
      ) : (
        permissions.length > 0 && (
          <span
            title={permissions[0].label}
            className="flex size-[30px] shrink-0 items-center justify-center"
          >
            <ChainIcon
              chain={permissions[0].iconChain}
              width={20}
              height={20}
              showTooltip={false}
              className="shrink-0 rounded-full"
            />
          </span>
        )
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
