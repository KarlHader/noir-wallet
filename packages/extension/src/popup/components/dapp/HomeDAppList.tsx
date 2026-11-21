import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { InlineError } from '@/popup/components/common/InlineError'
import {
  getCachedHomeDApps,
  loadCachedHomeDApps,
  refreshHomeDApps,
  type HomeDApp
} from '@/popup/services/home-dapp-directory-client'
import {
  connectionAuthorizesAccountForWalletStatus,
  type AccountRef,
  type ConnectedDApp
} from '@/core/dapp/dapp-manager'

export function HomeDAppList({
  account,
  connections
}: {
  readonly account: AccountRef | null
  readonly connections: readonly ConnectedDApp[]
}) {
  const [dapps, setDapps] = useState<readonly HomeDApp[] | null>(getCachedHomeDApps)
  const [loading, setLoading] = useState(dapps === null)
  const [failed, setFailed] = useState(false)

  const retry = useCallback(() => {
    setLoading(true)
    setFailed(false)
    void refreshHomeDApps(true)
      .then(setDapps)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let active = true
    void loadCachedHomeDApps()
      .then(cached => {
        if (active && cached) {
          setDapps(cached)
          setLoading(false)
        }
        return refreshHomeDApps()
      })
      .then(updated => {
        if (active) {
          setDapps(updated)
          setFailed(false)
        }
      })
      .catch(() => {
        if (active && !getCachedHomeDApps()) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="flex flex-col gap-3 px-4 py-5" aria-label="DApps">
      {dapps === null && loading && (
        <div className="flex flex-col gap-3" aria-label="Loading DApps">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex items-center gap-2" aria-hidden="true">
              <span className="size-11 shrink-0 animate-pulse rounded-lg bg-wallet-surface" />
              <span className="h-5 w-28 animate-pulse rounded bg-wallet-surface" />
            </div>
          ))}
        </div>
      )}
      {dapps === null && failed && !loading && (
        <InlineError message="DApps unavailable" tone="muted" onRetry={retry} />
      )}
      {dapps?.map(dapp => {
        const connected =
          account !== null &&
          connections.some(
            connection =>
              connection.origin === dapp.origin &&
              connectionAuthorizesAccountForWalletStatus(connection, account)
          )
        return (
          <a
            key={dapp.id}
            href={dapp.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${dapp.name} ${dapp.category}`}
            className="wallet-interactive -mx-2 flex min-w-0 items-center gap-2 rounded-lg p-2 text-left hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
          >
            <span className="relative flex size-11 shrink-0 items-center justify-center rounded-[13px] border-2 border-wallet-selected bg-wallet-surface">
              <Icon icon="lucide:globe" width={24} height={24} className="text-muted" />
              <img
                src={dapp.iconUrl}
                crossOrigin="anonymous"
                referrerPolicy="no-referrer"
                alt=""
                className="absolute inset-0 size-full rounded-[11px] object-cover"
                onError={event => {
                  event.currentTarget.hidden = true
                }}
              />
              {connected && (
                <span
                  role="img"
                  aria-label="Connected"
                  title="Connected"
                  className="absolute -right-1 -top-1 size-3.5 rounded-full border-2 border-background bg-primary"
                />
              )}
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-lg font-semibold leading-6">
                  {dapp.name}
                </span>
                <span className="max-w-24 shrink-0 truncate rounded-md bg-wallet-selected px-1.5 py-0.5 text-[10px] leading-3 text-muted">
                  {dapp.category}
                </span>
              </span>
              <span className="mt-1 block truncate text-xs leading-[18px] text-muted">
                {dapp.url}
              </span>
            </span>
          </a>
        )
      })}
    </div>
  )
}
