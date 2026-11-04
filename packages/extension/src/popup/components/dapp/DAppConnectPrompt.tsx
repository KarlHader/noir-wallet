import { useState } from 'react'
import { Icon } from '@iconify/react'
import { formatAccountName } from '@/lib/format'
import { toast } from '@/store/toast-store'

interface DAppConnectPromptProps {
  host: string
  favicon: string
  accountName: string
  onConnect: () => Promise<void>
}

/**
 * MetaMask-style bottom bar shown when the current tab's dApp is connected to
 * the wallet but the active account is not in its authorized list. Offers a
 * one-click connect for the active account.
 */
export function DAppConnectPrompt({
  host,
  favicon,
  accountName,
  onConnect
}: DAppConnectPromptProps) {
  const [connecting, setConnecting] = useState(false)

  const handleConnect = async () => {
    if (connecting) return
    setConnecting(true)
    try {
      await onConnect()
    } catch (error) {
      console.error('Failed to connect account to dApp:', error)
      toast.error(error instanceof Error ? error.message : 'Unable to connect this account')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div
      data-testid="dapp-connect-prompt"
      className="shrink-0 border-t border-border bg-card/80 backdrop-blur-md px-4 py-3 flex items-center gap-3"
    >
      <div className="relative shrink-0">
        <img
          src={favicon}
          alt={host}
          crossOrigin="anonymous"
          className="w-8 h-8 rounded-full bg-muted/20"
          onError={e => {
            ;(e.target as HTMLImageElement).src = 'icons/icon128.png'
          }}
        />
        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-muted-foreground/60 border-2 border-card" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{host}</div>
        <div className="text-xs text-muted truncate">
          {formatAccountName(accountName, 14)} · Not connected
        </div>
      </div>
      <button
        onClick={handleConnect}
        disabled={connecting}
        className="shrink-0 h-8 px-4 rounded-full bg-primary text-background text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 inline-flex items-center gap-1.5 cursor-pointer"
      >
        {connecting && (
          <Icon icon="lucide:loader-2" width={12} height={12} className="animate-spin" />
        )}
        Connect
      </button>
    </div>
  )
}
