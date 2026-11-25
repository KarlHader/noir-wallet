import { useState } from 'react'
import { Icon } from '@iconify/react'
import { formatAccountName } from '@/lib/format'
import { toast } from '@/store/toast-store'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { resolveDAppFooterPalette } from '@/popup/services/dapp-connection-presentation'
import { DAppAddressModeSelector, type DAppAddressModeControl } from './DAppAddressModeSelector'

interface DAppConnectPromptProps {
  host: string
  favicon: string
  accountName: string
  executionMode: DAppExecutionMode | null
  darkPalette?: boolean
  modeControl?: DAppAddressModeControl
  onConnect: () => Promise<void>
}

export function DAppConnectPrompt({
  host,
  favicon,
  accountName,
  executionMode,
  darkPalette = false,
  modeControl,
  onConnect
}: DAppConnectPromptProps) {
  const [connecting, setConnecting] = useState(false)
  const incognito = executionMode === 'private'
  const palette = resolveDAppFooterPalette(darkPalette, executionMode)
  const connectionBusy = connecting || Boolean(modeControl?.busy || (modeControl && !executionMode))

  const handleConnect = async () => {
    if (connectionBusy) return
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
    <footer
      aria-label="Current dApp connection"
      data-testid="dapp-connect-prompt"
      data-wallet-palette={palette}
      className="dapp-connection-bar relative z-10 flex h-[66px] shrink-0 items-center gap-[9px] px-4 text-foreground"
    >
      <div className="relative shrink-0">
        <img
          src={favicon || 'icons/icon128.png'}
          alt=""
          crossOrigin="anonymous"
          className="size-9 rounded-lg bg-muted/20"
          onError={e => {
            ;(e.target as HTMLImageElement).src = 'icons/icon128.png'
          }}
        />
        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-muted-foreground/60 border-2 border-card" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-base leading-5 font-medium">{host}</div>
        <div className="text-xs text-muted truncate">
          {`${formatAccountName(accountName, 14)} · Not connected`}
        </div>
      </div>
      {modeControl ? (
        <DAppAddressModeSelector
          executionMode={executionMode}
          palette={palette}
          control={modeControl}
          disabled={connecting}
          compact
        />
      ) : (
        executionMode && (
          <span
            data-incognito={incognito || undefined}
            className="dapp-connection-control flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted"
          >
            <Icon
              icon={incognito ? 'noir:private-assets' : 'lucide:eye'}
              width={14}
              aria-hidden="true"
            />
            {incognito ? 'Incognito' : 'Public'}
          </span>
        )
      )}
      <button
        type="button"
        onClick={handleConnect}
        disabled={connectionBusy}
        className="wallet-interactive shrink-0 h-8 px-4 rounded-lg bg-primary text-black text-xs font-semibold hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 inline-flex items-center gap-1.5"
      >
        {connecting && (
          <Icon icon="lucide:loader-2" width={12} height={12} className="animate-spin" />
        )}
        Connect
      </button>
    </footer>
  )
}
