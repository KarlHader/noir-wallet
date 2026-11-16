import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { EvmWalletChoiceRequest, EvmWalletOption } from '@/lib/evm-wallet-preference'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'

function parseChoice(value: unknown, requestId: string): EvmWalletChoiceRequest | null {
  if (!value || typeof value !== 'object' || !('result' in value)) return null
  const request = value.result
  if (!request || typeof request !== 'object') return null
  if (!('requestId' in request) || request.requestId !== requestId) return null
  if (!('origin' in request) || typeof request.origin !== 'string') return null
  if (!('wallets' in request) || !Array.isArray(request.wallets)) return null
  try {
    const url = new URL(request.origin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  } catch {
    return null
  }
  if (
    request.wallets.length === 0 ||
    !request.wallets.every(
      (wallet: unknown) =>
        wallet !== null &&
        typeof wallet === 'object' &&
        'id' in wallet &&
        typeof wallet.id === 'string' &&
        wallet.id.length > 0 &&
        'name' in wallet &&
        typeof wallet.name === 'string' &&
        wallet.name.length > 0 &&
        (!('icon' in wallet) || wallet.icon === undefined || typeof wallet.icon === 'string')
    )
  )
    return null
  return request as EvmWalletChoiceRequest
}

function WalletIcon({ wallet }: { wallet: EvmWalletOption }) {
  const [failed, setFailed] = useState(false)
  const imageIcon =
    wallet.icon &&
    (wallet.icon.startsWith('chrome-extension://') ||
      /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i.test(wallet.icon))
      ? wallet.icon
      : null

  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background">
      {imageIcon && !failed ? (
        <img
          src={imageIcon}
          alt=""
          className="size-7 object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true" className="text-sm font-semibold text-muted">
          {wallet.name.charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  )
}

export function EvmWalletChoice() {
  const [searchParams] = useSearchParams()
  const requestId = searchParams.get('requestId') ?? ''
  const [request, setRequest] = useState<EvmWalletChoiceRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadVersion, setLoadVersion] = useState(0)

  useEffect(() => {
    let active = true
    if (!requestId) {
      setError('This wallet request is no longer available')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void chrome.runtime
      .sendMessage({ type: 'GET_EVM_WALLET_CHOICE', requestId })
      .then((response: unknown) => {
        if (!active) return
        const choice = parseChoice(response, requestId)
        setRequest(choice)
        setError(choice ? null : 'This wallet request is no longer available')
      })
      .catch(() => {
        if (active) setError('Could not load available wallets')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [loadVersion, requestId])

  const resolve = async (walletId: string | null) => {
    if (!request || busy || completed) return
    setBusy(true)
    setError(null)
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'RESOLVE_EVM_WALLET_CHOICE',
        requestId,
        walletId
      })
      if (
        !response ||
        typeof response !== 'object' ||
        !('result' in response) ||
        response.result !== true
      )
        throw new Error('Choice was not accepted')
      setCompleted(true)
      window.close()
    } catch {
      setError('Could not send your wallet choice')
    } finally {
      setBusy(false)
    }
  }

  const host = request ? new URL(request.origin).host : null

  return (
    <div className="page-container">
      <PageHeader title="Choose EVM Wallet" />
      <div className="page-content min-h-0 space-y-3">
        {host && <p className="break-all text-sm text-muted">{host}</p>}
        {loading && (
          <p role="status" className="text-sm text-muted">
            Loading wallets...
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {!loading && !request && error === 'Could not load available wallets' && (
          <Button variant="outline" size="sm" onClick={() => setLoadVersion(value => value + 1)}>
            Retry
          </Button>
        )}
        {!completed &&
          request?.wallets.map(wallet => (
            <button
              key={wallet.id}
              type="button"
              disabled={busy}
              onClick={() => void resolve(wallet.id)}
              className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/30 disabled:cursor-wait disabled:opacity-50"
            >
              <WalletIcon wallet={wallet} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={wallet.name}>
                {wallet.name}
              </span>
            </button>
          ))}
        {completed && (
          <p role="status" className="text-sm text-muted">
            Wallet choice sent
          </p>
        )}
      </div>
    </div>
  )
}
