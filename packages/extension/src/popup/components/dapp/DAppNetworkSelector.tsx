import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { AccountRef } from '@/core/dapp/dapp-manager'
import {
  readCurrentDAppEvmNetworks,
  selectCurrentDAppEvmNetwork,
  type CurrentDAppEvmNetworkState
} from '@/popup/services/dapp-network-client'
import { ChainSelector, type ChainSelectorOption } from '../common/ChainSelector'
import { ChainIcon } from '../common/ChainIcon'
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
