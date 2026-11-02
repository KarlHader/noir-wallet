import { InlineError } from '@/popup/components/common/InlineError'
import { useState } from 'react'
import { ChainIcon } from '../../components/common/ChainIcon'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { cn } from '@/lib/utils'
import type { LedgerDerivationMode } from '@/core/wallet/ledger-derivation-path'
import {
  LEDGER_PATH_MODES,
  LEDGER_ACCOUNT_PAGE_SIZE,
  type LedgerAccountCandidate,
  type LedgerSelectableFamily
} from '../../services/ledger-account-discovery-model'
import {
  ledgerAccountPreviewLabel,
  ledgerAccountPreviewNetworkName,
  type LedgerAccountPreview
} from '../../services/ledger-account-preview'
import { parseLedgerAccountIndex } from './ledger-connect-model'

export function LedgerAccountPicker(props: {
  readonly family: LedgerSelectableFamily
  readonly mode: LedgerDerivationMode
  readonly start: number
  readonly candidates: readonly LedgerAccountCandidate[]
  readonly selectedPath?: string
  readonly previews: Readonly<Record<string, LedgerAccountPreview>>
  readonly busy: boolean
  readonly busyMessage: string
  readonly error: string
  readonly onMode: (mode: LedgerDerivationMode) => void
  readonly onPage: (start: number) => void
  readonly onSelect: (candidate: LedgerAccountCandidate) => void
  readonly onRetryPreview: () => void
}) {
  const [customIndex, setCustomIndex] = useState(String(props.start))
  const parsedIndex = parseLedgerAccountIndex(customIndex)
  const modes = LEDGER_PATH_MODES[props.family]
  const nextStart = props.start + LEDGER_ACCOUNT_PAGE_SIZE
  return (
    <div className="page-content min-h-0 space-y-2">
      <div className="flex items-center gap-2">
        <ChainIcon chain={props.family} showTooltip={false} className="size-6 rounded-full" />
        <h2 className="text-sm font-medium">Select an account</h2>
        <span className="ml-auto max-w-32 truncate text-xs text-muted">
          {ledgerAccountPreviewNetworkName(props.previews)}
        </span>
      </div>
      {modes.length > 1 && (
        <select
          aria-label="Derivation mode"
          value={props.mode}
          disabled={props.busy}
          className="h-8 w-full rounded-md border border-input bg-card px-3 text-xs"
          onChange={event => {
            const option = modes.find(mode => mode.value === event.target.value)
            if (option) props.onMode(option.value)
          }}
        >
          {modes.map(mode => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      )}
      <div className="space-y-1.5" aria-busy={props.busy}>
        {props.busy && (
          <p role="status" className="py-4 text-sm text-muted">
            {props.busyMessage}
          </p>
        )}
        {props.candidates.map(candidate => {
          const account = candidate.account
          if (!('address' in account)) return null
          const preview = props.previews[account.derivationPath]
          const address = account.address
          return (
            <button
              key={account.derivationPath}
              type="button"
              disabled={props.busy || candidate.registered}
              aria-pressed={props.selectedPath === account.derivationPath}
              className={cn(
                'w-full rounded-xl border px-3 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50',
                props.selectedPath === account.derivationPath
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card hover:border-muted'
              )}
              onClick={() => props.onSelect(candidate)}
            >
              <span className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium">
                  {preview?.status === 'available' && preview.accountName
                    ? preview.accountName
                    : `Account ${candidate.deviceIndex + 1}`}
                </span>
                <span className="shrink-0 text-muted">
                  {candidate.registered ? 'Added' : ledgerAccountPreviewLabel(preview)}
                </span>
              </span>
              <span className="mt-0.5 block font-mono text-xs text-muted" title={address}>
                {address.slice(0, 12)}…{address.slice(-10)}
              </span>
            </button>
          )
        })}
      </div>
      {props.mode !== 'root' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={props.busy || props.start === 0}
              onClick={() => props.onPage(Math.max(0, props.start - LEDGER_ACCOUNT_PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={props.busy || nextStart > 0x7fffffff}
              onClick={() => props.onPage(nextStart)}
            >
              Next
            </Button>
          </div>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer py-1">Advanced</summary>
            <div className="mt-2 flex items-center gap-2">
              <Input
                aria-label="Start account index"
                type="number"
                min={0}
                max={0x7fffffff}
                className="h-9"
                value={customIndex}
                disabled={props.busy}
                onChange={event => setCustomIndex(event.target.value)}
                aria-invalid={parsedIndex === null}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={props.busy || parsedIndex === null}
                onClick={() => {
                  if (parsedIndex !== null) props.onPage(parsedIndex)
                }}
              >
                Go
              </Button>
            </div>
            {props.selectedPath && <p className="mt-2 break-all font-mono">{props.selectedPath}</p>}
          </details>
        </>
      )}
      {Object.values(props.previews).some(preview => preview.status === 'unavailable') && (
        <InlineError
          message="Some balances are unavailable"
          retrying={props.busy}
          onRetry={props.onRetryPreview}
        />
      )}
      {props.error && (
        <InlineError
          message={props.error}
          retrying={props.busy}
          onRetry={() => props.onPage(props.start)}
        />
      )}
    </div>
  )
}
