import { Icon } from '@iconify/react'
import { Button } from '../ui/button'
import { useDAppConnection } from '@/popup/hooks/useDAppConnection'
import { useState } from 'react'
import { ListSkeleton } from '../ui/skeleton'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { ChainIcon } from '../common/ChainIcon'
import { presentDAppPermissions } from '@/popup/services/dapp-connection-presentation'

export function DAppConnectionModal() {
  const { connectedDApps, loading, disconnectDApp } = useDAppConnection()
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const networkMode = useWalletStore(state => state.currentNetwork)
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)

  const handleDisconnect = async (origin: string) => {
    if (disconnecting) return

    setDisconnecting(origin)
    try {
      await disconnectDApp(origin)
    } catch (error) {
      console.error('Failed to disconnect:', error)
    } finally {
      setDisconnecting(null)
    }
  }

  return (
    <div>
      {networkMode === 'testnet' && (
        <div className="mb-6">
          <div className="text-xs text-muted mb-2">Environment</div>
          <div className="flex items-center gap-2 px-4 py-3 bg-card rounded-xl">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Icon icon="lucide:globe-2" width={16} height={16} className="text-primary" />
            </div>
            <div>
              <div className="font-medium">Testnet Mode</div>
              <div className="text-xs text-muted">Permissions may span multiple chains.</div>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="text-xs text-muted mb-3">Connected dApps</div>
        {loading ? (
          <ListSkeleton rows={3} label="Loading connected dApps" card />
        ) : connectedDApps.length === 0 ? (
          <div className="text-center py-8 text-muted">
            <Icon icon="lucide:unplug" width={32} height={32} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">No connected dApps</p>
          </div>
        ) : (
          <div className="max-h-[calc(100dvh-15rem)] space-y-2 overflow-y-auto overscroll-contain pr-1">
            {connectedDApps.map(dapp => {
              const permissions = presentDAppPermissions(dapp, {
                network: networkMode,
                endpointSettings
              })
              return (
                <div key={dapp.id} className="space-y-3 rounded-xl bg-card px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3 overflow-hidden">
                    <img
                      src={dapp.favicon || 'icons/icon128.png'}
                      alt={dapp.name}
                      crossOrigin="anonymous"
                      className="size-8 shrink-0 rounded-full"
                      onError={e => {
                        ;(e.target as HTMLImageElement).src =
                          'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNlNmU2ZTYiIHN0cm9rZS13aWR0aD0iMS41Ij48cGF0aCBkPSJtOS44NTMgMTQuNjMzbC02LjIwMS0zLjk0NmEyIDIgMCAwIDEgMC0zLjM3NGw2LjItMy45NDZhNCA0IDAgMCAxIDQuMjk2IDBsNi4yIDMuOTQ2YTIgMiAwIDAgMSAwIDMuMzc0bC02LjIgMy45NDZhNCA0IDAgMCAxLTQuMjk2IDBaIi8+PHBhdGggZD0ibTE4LjI4NiAxMmwyLjA2MyAxLjMxM2EyIDIgMCAwIDEgMCAzLjM3NGwtNi4yMDEgMy45NDZhNCA0IDAgMCAxLTQuMjk2IDBsLTYuMi0zLjk0NmEyIDIgMCAwIDEgMC0zLjM3NEw1LjcxNCAxMiIvPjwvZz48L3N2Zz4='
                      }}
                    />
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="truncate text-sm font-medium">{dapp.name}</div>
                      <div className="truncate text-xs text-muted">{dapp.host}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDisconnect(dapp.origin)}
                      disabled={disconnecting === dapp.origin}
                      className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                    >
                      {disconnecting === dapp.origin ? (
                        <Icon
                          icon="lucide:loader-2"
                          width={16}
                          height={16}
                          className="animate-spin"
                        />
                      ) : (
                        'Disconnect all'
                      )}
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-1.5" aria-label="Authorized networks">
                    {permissions.length === 0 ? (
                      <span className="text-[11px] text-muted">No active network permissions</span>
                    ) : (
                      permissions.map(permission => (
                        <div
                          key={permission.chainId}
                          className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[11px] text-muted-foreground"
                          title={permission.chainId}
                        >
                          <ChainIcon
                            chain={permission.iconChain}
                            width={14}
                            height={14}
                            className="rounded-full"
                            showTooltip={false}
                          />
                          <span className="max-w-32 truncate">{permission.label}</span>
                          {permission.accountCount > 1 && (
                            <span className="text-primary">
                              · {permission.accountCount} accounts
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
