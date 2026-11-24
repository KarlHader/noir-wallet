import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { AccountRef, ConnectedDApp } from '@/core/dapp/dapp-manager'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

export function ConnectedDAppBar({
  dapp,
  account,
  executionMode,
  darkPalette = false,
  modeControl,
  onManage,
  onDisconnect
}: {
  readonly dapp: ConnectedDApp
  readonly account: AccountRef | null
  readonly executionMode: DAppExecutionMode | null
  readonly darkPalette?: boolean
  readonly modeControl?: {
    readonly busy: boolean
    readonly incognitoAvailable: boolean
    readonly onChange: (mode: DAppExecutionMode) => void
  }
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
  const incognito = hasEvm && executionMode === 'private'
  const modeLabel = incognito ? 'Incognito' : 'Public'
  const walletPalette = incognito || darkPalette ? undefined : 'public'
  return (
    <footer
      aria-label="Current dApp connection"
      data-wallet-palette={walletPalette}
      className="dapp-connection-bar relative z-10 flex h-[66px] shrink-0 items-start gap-2.5 px-4 pt-2.5 text-foreground"
    >
      <button
        type="button"
        onClick={onManage}
        className="wallet-interactive flex h-10 min-w-0 flex-1 items-center gap-[9px] rounded-md text-left hover:bg-foreground/5 active:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
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
          <span className="block truncate text-base leading-5 font-medium">{dapp.name}</span>
          <span className="block truncate text-xs leading-4 text-muted">{dapp.host}</span>
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
            className="dapp-connection-control flex h-10 w-[55px] shrink-0 items-center justify-center rounded-lg"
          >
            <ChainIcon
              chain={permissions[0].iconChain}
              width={20}
              height={20}
              showTooltip={false}
              className="shrink-0 rounded-[5px]"
            />
          </span>
        )
      )}
      {hasEvm && modeControl && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={executionMode ? `DApp address: ${modeLabel}` : 'DApp address'}
              aria-busy={modeControl.busy || undefined}
              disabled={!executionMode || modeControl.busy || disconnecting}
              className="dapp-connection-control wallet-interactive flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            >
              <Icon
                icon={incognito ? 'noir:private-assets' : 'lucide:eye'}
                className="shrink-0"
                width={14}
                aria-hidden="true"
              />
              {executionMode ? modeLabel : '—'}
              <Icon icon="lucide:chevron-up" width={12} className="ml-auto" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" data-wallet-palette={walletPalette}>
            <DropdownMenuRadioGroup
              value={executionMode ?? ''}
              onValueChange={value => {
                if (value === 'main' || value === 'private') modeControl.onChange(value)
              }}
            >
              <DropdownMenuRadioItem value="main">
                <Icon icon="lucide:eye" aria-hidden="true" />
                Public
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="private" disabled={!modeControl.incognitoAvailable}>
                <Icon icon="noir:private-assets" className="text-private" aria-hidden="true" />
                Incognito
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="button"
        aria-label={`Disconnect ${dapp.name}`}
        disabled={disconnecting}
        className="dapp-connection-control wallet-interactive flex h-10 w-[42px] shrink-0 items-center justify-center rounded-lg text-muted hover:text-foreground active:brightness-90 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
        className="dapp-connection-control wallet-interactive flex h-10 w-[55px] shrink-0 items-center justify-between rounded-lg px-2 text-muted hover:text-foreground active:brightness-90 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      >
        {active ? (
          <ChainIcon
            chain={active.iconChain}
            width={20}
            height={20}
            aria-hidden="true"
            showTooltip={false}
            className="shrink-0 rounded-[5px]"
          />
        ) : (
          <Icon
            icon={loading ? 'lucide:loader-circle' : 'lucide:network'}
            width={20}
            height={20}
            className={loading ? 'animate-spin' : ''}
          />
        )}
        <Icon icon="lucide:chevron-down" width={12} height={12} />
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
