import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { NoirPublicAccount } from '@/core/services/noir-protocol/public/types'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Button } from '@/popup/components/ui/button'
import { noirPublicWalletClient } from '@/popup/services/noir-public-wallet-client'
import { toast } from '@/store/toast-store'
import { InlineError } from '@/popup/components/common/InlineError'

interface NoirPublicActivationCardProps {
  readonly account: NoirPublicAccount | null
  readonly status: 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly onRefresh: () => Promise<void>
  readonly onViewActivity: () => void
}

export function NoirPublicActivationCard({
  account,
  status,
  error,
  onRefresh,
  onViewActivity
}: NoirPublicActivationCardProps) {
  const [activating, setActivating] = useState(false)
  const [activationError, setActivationError] = useState<string | null>(null)
  const previousAccount = useRef(account)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const previous = previousAccount.current
    previousAccount.current = account
    if (
      account?.status === 'active' &&
      previous?.address === account.address &&
      previous.status !== 'active' &&
      (previous.status === 'activating' || activating)
    ) {
      toast.success('Public account activated')
    }
  }, [account, activating])

  if (account?.status === 'active' || (!account && status !== 'error')) return null

  const activate = async () => {
    if (activating) return
    setActivating(true)
    setActivationError(null)
    try {
      await noirPublicWalletClient.activate()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to activate Public account'
      if (mounted.current && message !== 'User rejected Public activation')
        setActivationError(message)
    } finally {
      if (mounted.current) {
        await onRefresh()
        if (mounted.current) setActivating(false)
      }
    }
  }

  return (
    <section aria-label="Zcash activation" className="mx-5 mb-4 border-t border-border/50 py-3">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TokenIcon symbol="ZEC" nativeChain="zcash" size={24} />
          {account?.status === 'activating' ? (
            <p role="status" className="text-sm text-muted">
              Activating Public
            </p>
          ) : (
            <p className="text-sm text-muted">Public account</p>
          )}
        </div>
        {account?.status === 'inactive' && (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 gap-1 px-2 text-primary hover:text-primary"
            aria-label="Activate Public"
            disabled={activating}
            isLoading={activating}
            onClick={() => void activate()}
          >
            {activationError ? 'Try again' : 'Activate'}
            <Icon icon="lucide:chevron-right" width={14} height={14} />
          </Button>
        )}
        {account?.status === 'activating' && (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 gap-1 px-2 text-primary hover:text-primary"
            onClick={onViewActivity}
          >
            View activity
            <Icon icon="lucide:chevron-right" width={14} height={14} />
          </Button>
        )}
        {!account && error && (
          <Button variant="ghost" size="sm" className="-mr-2" onClick={() => void onRefresh()}>
            Retry
          </Button>
        )}
      </div>
      {(error || activationError) && (
        <InlineError className="mt-2" message={activationError ?? error} />
      )}
    </section>
  )
}
