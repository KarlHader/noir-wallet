import { useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../ui/button'
import { ListSkeleton } from '../ui/skeleton'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { ChainIcon } from '../common/ChainIcon'
import { InlineError } from '../common/InlineError'
import { useDAppConnection } from '@/popup/hooks/useDAppConnection'
import { presentDAppPermissions } from '@/popup/services/dapp-connection-presentation'
import { toast } from '@/store/toast-store'

export function DAppConnectionModal() {
  const { connectedDApps, loading, connectionError, refreshConnectedDApps, disconnectDApp } =
    useDAppConnection()
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const networkMode = useWalletStore(state => state.currentNetwork)
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)

  const handleDisconnect = async (origin?: string) => {
    if (disconnecting) return
    setDisconnecting(origin ?? 'all')
    try {
      const origins = origin ? [origin] : connectedDApps.map(dapp => dapp.origin)
      for (const currentOrigin of origins) await disconnectDApp(currentOrigin)
    } catch {
      toast.error('Unable to disconnect dApp')
    } finally {
      setDisconnecting(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1">
        {loading && connectedDApps.length === 0 ? (
          <ListSkeleton rows={3} label="Loading connected dApps" />
        ) : connectionError && connectedDApps.length === 0 ? (
          <div className="px-4 py-12">
            <InlineError
              message="Unable to load connected dApps"
              onRetry={() => void refreshConnectedDApps()}
            />
          </div>
        ) : connectedDApps.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">No connected dApps</div>
        ) : (
          <>
            {connectionError && (
              <div className="px-4 py-3">
                <InlineError
                  message="Unable to refresh connected dApps"
                  onRetry={() => void refreshConnectedDApps()}
                />
              </div>
            )}
            {connectedDApps.map(dapp => {
              const permissions = presentDAppPermissions(dapp, {
                network: networkMode,
                endpointSettings
              })
              return (
                <div key={dapp.id}>
                  <div className="flex min-h-[68px] items-center gap-3 px-4">
                    <div className="flex min-w-0 flex-1 items-center gap-[9px]">
                      <img
                        src={dapp.favicon || 'icons/icon128.png'}
                        alt=""
                        crossOrigin="anonymous"
                        className="size-9 shrink-0 rounded-lg"
                        onError={event => {
                          event.currentTarget.src = 'icons/icon128.png'
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-base font-medium">{dapp.name}</span>
                        <span className="block truncate text-xs text-muted">{dapp.host}</span>
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label={`Disconnect ${dapp.name}`}
                      title={`Disconnect ${dapp.name}`}
                      onClick={() => void handleDisconnect(dapp.origin)}
                      disabled={disconnecting !== null}
                      className="wallet-interactive flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-wallet-surface text-danger enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
                    >
                      <Icon
                        icon={
                          disconnecting === dapp.origin ? 'lucide:loader-circle' : 'lucide:unplug'
                        }
                        width={16}
                        height={16}
                        className={disconnecting === dapp.origin ? 'animate-spin' : undefined}
                      />
                    </button>
                    <button
                      type="button"
                      aria-label={`View ${dapp.name} permissions`}
                      aria-expanded={expanded === dapp.id}
                      title={expanded === dapp.id ? 'Hide permissions' : 'View permissions'}
                      onClick={() => setExpanded(expanded === dapp.id ? null : dapp.id)}
                      className="wallet-interactive flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-wallet-surface text-muted hover:bg-wallet-selected hover:text-foreground active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                    >
                      <Icon
                        icon={expanded === dapp.id ? 'lucide:chevron-down' : 'lucide:chevron-right'}
                        width={16}
                        height={16}
                      />
                    </button>
                  </div>
                  {expanded === dapp.id && (
                    <div
                      className="flex flex-wrap gap-2 px-4 pb-3 pl-[61px]"
                      aria-label="Authorized networks"
                    >
                      {permissions.map(permission => (
                        <span
                          key={permission.chainId}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-wallet-surface px-2 py-1 text-xs text-wallet-secondary"
                        >
                          <ChainIcon
                            chain={permission.iconChain}
                            width={14}
                            height={14}
                            showTooltip={false}
                          />
                          {permission.label}
                          {permission.accountCount > 1 && <span>· {permission.accountCount}</span>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
      <div className="page-footer">
        <Button
          variant="ghost"
          className="h-[45px] w-full rounded-[10px] border border-white/6 bg-white/5 text-base font-medium"
          onClick={() => void handleDisconnect()}
          disabled={
            loading || connectionError || connectedDApps.length === 0 || disconnecting !== null
          }
          isLoading={disconnecting === 'all'}
        >
          Disconnect all
        </Button>
      </div>
    </div>
  )
}
