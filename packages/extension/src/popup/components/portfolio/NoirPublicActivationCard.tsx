import { useState } from 'react'
import type { NoirPublicAccount } from '@/core/services/noir-protocol/public/types'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Button } from '@/popup/components/ui/button'
import { noirPublicWalletClient } from '@/popup/services/noir-public-wallet-client'

interface NoirPublicActivationCardProps {
  readonly account: NoirPublicAccount | null
  readonly status: 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly onRefresh: () => Promise<void>
}

export function NoirPublicActivationCard({
  account,
  status,
  error,
  onRefresh
}: NoirPublicActivationCardProps) {
  const [activating, setActivating] = useState(false)
  const [activationError, setActivationError] = useState<string | null>(null)
  if (account?.status === 'active' || (!account && status !== 'error')) return null

  const activate = async () => {
    if (activating) return
    setActivating(true)
    setActivationError(null)
    try {
      await noirPublicWalletClient.activate()
      await onRefresh()
    } catch (cause) {
      setActivationError(
        cause instanceof Error ? cause.message : 'Unable to activate Public account'
      )
    } finally {
      setActivating(false)
    }
  }

  return (
    <section aria-label="Zcash L2 activation" className="mx-4 mb-4 rounded-xl bg-card p-3">
      <div className="flex items-center gap-3">
        <TokenIcon symbol="ZEC" nativeChain="zcash" size={36} />
        <p className="text-base font-medium">Zcash L2</p>
      </div>
      {(error || activationError) && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {activationError ?? error}
        </p>
      )}
      {account?.status === 'inactive' && (
        <Button
          className="mt-3 w-full"
          disabled={activating}
          isLoading={activating}
          onClick={() => void activate()}
        >
          Activate Public
        </Button>
      )}
      {account?.status === 'activating' && (
        <p role="status" className="mt-3 text-xs text-muted">
          Activation pending
        </p>
      )}
      {!account && error && (
        <Button className="mt-3 w-full" onClick={() => void onRefresh()}>
          Retry
        </Button>
      )}
    </section>
  )
}
