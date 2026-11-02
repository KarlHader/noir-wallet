import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import {
  EVM_WALLET_PREFERENCE_STORAGE_KEY,
  readEvmWalletPreference,
  type EvmWalletPreference
} from '@/lib/evm-wallet-preference'
import { cn } from '@/lib/utils'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'

const options: readonly { value: EvmWalletPreference; label: string; icon?: string }[] = [
  { value: 'ask', label: 'Ask every time', icon: 'lucide:circle-help' },
  { value: 'noir', label: 'Use Noir Wallet' },
  { value: 'other', label: 'Use another wallet', icon: 'lucide:wallet-cards' }
]

export function DefaultEvmWallet() {
  const [preference, setPreference] = useState<EvmWalletPreference>('ask')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showReload, setShowReload] = useState(false)
  const [loadVersion, setLoadVersion] = useState(0)

  useEffect(() => {
    let active = true
    void chrome.storage.local
      .get(EVM_WALLET_PREFERENCE_STORAGE_KEY)
      .then(result => {
        if (!active) return
        setPreference(readEvmWalletPreference(result[EVM_WALLET_PREFERENCE_STORAGE_KEY]))
        setError(null)
        setReady(true)
      })
      .catch(() => {
        if (active) setError('Could not load your wallet preference')
      })
    return () => {
      active = false
    }
  }, [loadVersion])

  useEffect(() => {
    if (!showReload) return
    const timeout = window.setTimeout(() => setShowReload(false), 5000)
    return () => window.clearTimeout(timeout)
  }, [showReload])

  const select = async (next: EvmWalletPreference) => {
    if (!ready || busy || next === preference) return
    setBusy(true)
    setError(null)
    setShowReload(false)
    try {
      await chrome.storage.local.set({ [EVM_WALLET_PREFERENCE_STORAGE_KEY]: next })
      setPreference(next)
      setShowReload(true)
    } catch {
      setError('Could not save your wallet preference')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Default EVM Wallet" showBack />
      <div className="page-content min-h-0 space-y-3">
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {!ready && error && (
          <Button size="sm" variant="outline" onClick={() => setLoadVersion(value => value + 1)}>
            Retry
          </Button>
        )}
        {options.map(option => {
          const selected = preference === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={!ready || busy}
              onClick={() => void select(option.value)}
              className={cn(
                'flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-3 text-left transition-colors disabled:cursor-not-allowed',
                selected
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/60 hover:border-primary/30'
              )}
            >
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background"
              >
                {option.icon ? (
                  <Icon icon={option.icon} className="size-5 text-muted" />
                ) : (
                  <img src="/icons/icon128.png" alt="" className="size-6 object-contain" />
                )}
              </span>
              <span className="min-w-0 flex-1 text-sm font-medium">{option.label}</span>
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border',
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-transparent'
                )}
              >
                <Icon icon="lucide:check" className="size-3" />
              </span>
            </button>
          )
        })}
        {showReload && (
          <p role="status" className="px-1 text-xs text-muted">
            Reload open websites to apply.
          </p>
        )}
      </div>
    </div>
  )
}
