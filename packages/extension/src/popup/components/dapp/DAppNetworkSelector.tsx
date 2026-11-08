import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { AccountRef } from '@/core/dapp/dapp-manager'
import {
  readCurrentDAppEvmNetworks,
  selectCurrentDAppEvmNetwork,
  type CurrentDAppEvmNetworkState
} from '@/popup/services/dapp-network-client'
import { ChainIcon } from '../common/ChainIcon'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '@/lib/utils'
import { SETTINGS_STORAGE_KEY } from '@/lib/wallet-settings-storage'

export function DAppNetworkSelector({
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
  if (!loading && !state && !error) return null
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (switching) return
        setOpen(next)
        if (next) void refresh()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Switch site network${active ? `: ${active.displayName}` : ''}`}
          title={active?.displayName}
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
          <Icon icon="lucide:chevron-down" width={12} height={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-[240px] border-0 p-2"
        aria-label="Site network"
      >
        <div
          className="max-h-[min(360px,60dvh)] overflow-y-auto overscroll-contain"
          role="radiogroup"
          aria-label="Site network"
        >
          {state?.options.map(option => (
            <button
              key={option.chainId}
              type="button"
              role="radio"
              aria-checked={option.chainId === state.activeChainId}
              disabled={loading || switching !== null}
              className={cn(
                'wallet-interactive flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-50',
                option.chainId === state.activeChainId && 'bg-white/6'
              )}
              onClick={async () => {
                if (option.chainId === state.activeChainId) {
                  setOpen(false)
                  return
                }
                setSwitching(option.chainId)
                setError('')
                try {
                  await selectCurrentDAppEvmNetwork(option.chainId, state.selectionContext)
                  setOpen(false)
                  await refresh()
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'Unable to switch network')
                } finally {
                  setSwitching(null)
                }
              }}
            >
              <ChainIcon
                chain={option.iconChain}
                width={24}
                height={24}
                aria-hidden="true"
                showTooltip={false}
                className="shrink-0 rounded-full"
              />
              <span className="min-w-0 flex-1 truncate">{option.displayName}</span>
              {switching === option.chainId ? (
                <Icon icon="lucide:loader-circle" width={16} className="animate-spin" />
              ) : (
                option.chainId === state.activeChainId && (
                  <Icon icon="lucide:check" width={16} className="text-primary" />
                )
              )}
            </button>
          ))}
        </div>
        {loading && !state && (
          <div className="p-3 text-sm text-muted" role="status">
            Loading networks…
          </div>
        )}
        {error && (
          <div className="px-3 py-2 text-sm">
            <p role="alert" className="text-destructive">
              {error}
            </p>
            <button type="button" onClick={() => void refresh()} className="mt-2 text-primary">
              Retry
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
