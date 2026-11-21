import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { AccountRef, ConnectedDApp } from '@/core/dapp/dapp-manager'
import { presentDAppPermissions } from '@/popup/services/dapp-connection-presentation'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { ChainIcon } from '../common/ChainIcon'
import { toast } from '@/store/toast-store'
import { SETTINGS_STORAGE_KEY } from '@/lib/wallet-settings-storage'
import {
  readCurrentDAppEvmNetworks,
  selectCurrentDAppEvmNetwork,
  type CurrentDAppEvmNetworkState
} from '@/popup/services/dapp-network-client'
import { ChainSelector, type ChainSelectorOption } from '../common/ChainSelector'

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

function DAppNetworkSelector({
  origin,
  account
}: {
  readonly origin: string
  readonly account: AccountRef | null
}) {
  const [state, setState] = useState<CurrentDAppEvmNetworkState | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState<string | null>(null)
  const [error, setError] = useState('')
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    try {
      const next = await readCurrentDAppEvmNetworks()
      if (current !== request.current) return
      setState(
        next?.origin === origin &&
          next.selectionContext.walletId === account?.walletId &&
          next.selectionContext.accountId === account?.accountId
          ? next
          : null
      )
      setError('')
    } catch {
      if (current === request.current) setError('Unable to load networks')
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [origin, account?.walletId, account?.accountId])

  useEffect(() => {
    setOpen(false)
    setState(null)
    void refresh()
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && ('connectedDApps' in changes || SETTINGS_STORAGE_KEY in changes)) {
        void refresh()
      }
    }
    chrome.storage.onChanged.addListener(listener)
    return () => {
      ++request.current
      chrome.storage.onChanged.removeListener(listener)
    }
  }, [refresh])

  const active = state?.options.find(option => option.chainId === state.activeChainId)
  const options: readonly ChainSelectorOption[] =
    state?.options.map(option => ({
      id: option.chainId,
      name: option.displayName,
      icon: option.iconChain,
      disabled: loading || switching !== null
    })) ?? []
  if (!loading && !state && !error) return null
  return (
    <>
      <button
        type="button"
        aria-label={`Switch site network${active ? `: ${active.displayName}` : ''}`}
        aria-haspopup="dialog"
        title={active?.displayName}
        onClick={() => {
          setOpen(true)
          void refresh()
        }}
        className="wallet-interactive flex h-[30px] w-[51px] shrink-0 items-center justify-between rounded-lg bg-wallet-selected/80 px-1.5 hover:bg-wallet-selected active:brightness-90 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      >
        {active ? (
          <ChainIcon
            chain={active.iconChain}
            width={20}
            height={20}
            aria-hidden="true"
            showTooltip={false}
            className="shrink-0 rounded-full"
          />
        ) : (
          <Icon
            icon={loading ? 'lucide:loader-circle' : 'lucide:network'}
            width={20}
            height={20}
            className={loading ? 'animate-spin' : ''}
          />
        )}
        <Icon icon="lucide:chevron-right" width={12} height={12} />
      </button>
      <ChainSelector
        open={open}
        onOpenChange={next => {
          if (!switching) setOpen(next)
        }}
        options={options}
        selectedId={state?.activeChainId}
        title="Site network"
        loading={loading && !state}
        error={error}
        onRetry={() => void refresh()}
        onSelect={async id => {
          if (!state || id === state.activeChainId) return
          setSwitching(id)
          setError('')
          try {
            await selectCurrentDAppEvmNetwork(id, state.selectionContext)
            setOpen(false)
            await refresh()
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to switch network')
            throw cause
          } finally {
            setSwitching(null)
          }
        }}
      />
    </>
  )
}
