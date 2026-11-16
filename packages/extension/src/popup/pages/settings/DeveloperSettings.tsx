import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { Network } from '@/types'
import { PageHeader } from '../../components/common/PageHeader'
import { Switch } from '../../components/ui/switch'
import { useDialog } from '../../hooks/useDialog'
import { networkModeClient } from '../../services/network-mode-client'

export function DeveloperSettings() {
  const { confirm, alert } = useDialog()
  const [networkMode, setNetworkMode] = useState<Network>(DEFAULT_NETWORK)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    void networkModeClient
      .read()
      .then(result => setNetworkMode(result.networkMode))
      .catch(() => {})
  }, [])

  const handleToggle = async () => {
    if (switching) return
    const target: Network = networkMode === 'mainnet' ? 'testnet' : 'mainnet'
    const accepted = await confirm({
      title: target === 'testnet' ? 'Enable Testnet Mode?' : 'Return to Mainnet?',
      message:
        target === 'testnet'
          ? 'Noir Wallet will lock and restart. Only test networks, test balances, and test activity will be visible. Test assets have no real value.'
          : 'Noir Wallet will lock and restart. Only main networks, balances, and activity will be visible.',
      confirmText: target === 'testnet' ? 'Enable & Restart' : 'Switch & Restart'
    })
    if (!accepted) return

    setSwitching(true)
    try {
      await networkModeClient.switch(target)
      setNetworkMode(target)
    } catch (error) {
      setSwitching(false)
      await alert({
        title: 'Network switch unavailable',
        message: error instanceof Error ? error.message : 'Network mode could not be switched.'
      })
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Developer Settings" showBack backDisabled={switching} />

      <div className="page-content space-y-4">
        <button
          type="button"
          role="switch"
          aria-checked={networkMode === 'testnet'}
          disabled={switching}
          onClick={handleToggle}
          className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-card p-4 text-left transition-colors hover:bg-white/5 disabled:cursor-wait disabled:opacity-70"
        >
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">Testnet Mode</span>
              {networkMode === 'testnet' && (
                <span className="rounded-full bg-warning-surface px-2 py-0.5 text-[10px] font-medium text-warning">
                  ACTIVE
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-warning">
              Show only test networks across Zcash, EVM, Bitcoin, and supported chains.
            </p>
          </div>
          {switching ? (
            <Icon
              icon="lucide:loader-2"
              className="shrink-0 animate-spin text-primary"
              width={22}
            />
          ) : (
            <Switch checked={networkMode === 'testnet'} />
          )}
        </button>

        <div className="rounded-xl border border-warning/20 bg-warning-surface p-4">
          <div className="flex gap-3">
            <Icon
              icon="lucide:triangle-alert"
              className="mt-0.5 shrink-0 text-warning"
              width={18}
            />
            <p className="text-xs leading-5 text-warning">
              Switching networks cancels unsigned approvals, disconnects dApps, locks the wallet,
              and restarts the extension. Mainnet and testnet balances and activity remain isolated.
              Keystone accounts may need to reconnect a firmware export for the target network.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
