import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { getNetworkFeeTierLabel, type NetworkFeeTier } from '@/core/transactions/domain'
import {
  formatEvmPriorityFeeGwei,
  parseEvmPriorityFeeGwei,
  type EvmFeeSelection
} from '@/infrastructure/chains/evm'
import { openModal } from '@/popup/provider/ModalManager'
import { Button } from '@/popup/components/ui/button'
import { Input } from '@/popup/components/ui/input'
import { NetworkFeeTierSelector } from './NetworkFeeTierSelector'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { classifyError } from '@/lib/errors'
import { InlineError } from '@/popup/components/common/InlineError'

interface NetworkFeeTierPickerProps {
  readonly chainFamily: 'bitcoin' | 'evm'
  readonly tier: NetworkFeeTier
  readonly selection?: EvmFeeSelection
  readonly amount: string
  readonly symbol: string
  readonly onTierChange: (tier: NetworkFeeTier) => void | Promise<void>
  readonly onSelectionChange?: (selection: EvmFeeSelection) => void | Promise<void>
  readonly disabled?: boolean
}

export function NetworkFeeTierPicker({
  chainFamily,
  tier,
  selection,
  amount,
  symbol,
  onTierChange,
  onSelectionChange,
  disabled = false
}: NetworkFeeTierPickerProps) {
  const handleEdit = () => {
    if (disabled) return
    void openModal({
      title: 'Network Fee',
      showCloseButton: true,
      body: (_resolve, close) => (
        <NetworkFeeTierEditContent
          chainFamily={chainFamily}
          selection={selection ?? { kind: 'tier', tier }}
          allowCustom={chainFamily === 'evm' && onSelectionChange !== undefined}
          onSelect={nextSelection => {
            if (onSelectionChange) return onSelectionChange(nextSelection)
            if (nextSelection.kind === 'tier') return onTierChange(nextSelection.tier)
          }}
          close={close}
        />
      )
    })
  }

  return (
    <div className="flex min-w-0 flex-col items-end gap-0.5 text-right">
      <AmountDisplay value={amount} symbol={symbol} profile="fee" />
      <button
        type="button"
        onClick={handleEdit}
        disabled={disabled}
        className="inline-flex items-center gap-1 text-[10px] text-muted transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label="Edit network fee"
      >
        <span>{selection?.kind === 'custom' ? 'Custom' : getNetworkFeeTierLabel(tier)}</span>
        <Icon
          icon={disabled ? 'lucide:loader-2' : 'lucide:pencil'}
          className={disabled ? 'animate-spin' : ''}
          width={12}
          height={12}
        />
      </button>
    </div>
  )
}

function NetworkFeeTierEditContent({
  chainFamily,
  selection,
  allowCustom,
  onSelect,
  close
}: {
  readonly chainFamily: 'bitcoin' | 'evm'
  readonly selection: EvmFeeSelection
  readonly allowCustom: boolean
  readonly onSelect: (selection: EvmFeeSelection) => void | Promise<void>
  readonly close: () => void
}) {
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrySelection, setRetrySelection] = useState<EvmFeeSelection | null>(null)
  const [selected, setSelected] = useState(selection)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [customPriorityFeeGwei, setCustomPriorityFeeGwei] = useState(
    formatEvmPriorityFeeGwei(selection) ?? ''
  )

  const handleSelect = async (nextSelection: EvmFeeSelection) => {
    if (pending.current) return
    setSelected(nextSelection)
    pending.current = true
    setUpdating(true)
    setError(null)
    setRetrySelection(null)
    try {
      await onSelect(nextSelection)
      if (mounted.current) close()
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'The network fee could not be updated.')
        if (classifyError(cause).retryable) setRetrySelection(nextSelection)
      }
    } finally {
      pending.current = false
      if (mounted.current) setUpdating(false)
    }
  }

  return (
    <div className="space-y-3 pb-4 pt-1">
      <NetworkFeeTierSelector
        chainFamily={chainFamily}
        value={selected.kind === 'tier' ? selected.tier : 'standard'}
        onChange={tier => void handleSelect({ kind: 'tier', tier })}
        hideLabel
        disabled={updating}
      />
      {allowCustom && (
        <div className="space-y-2 rounded-md border border-border/60 bg-card/45 p-3">
          <label htmlFor="custom-priority-fee" className="block text-xs font-medium">
            Custom priority fee
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="custom-priority-fee"
              inputMode="decimal"
              value={customPriorityFeeGwei}
              onChange={event => {
                setCustomPriorityFeeGwei(event.target.value)
                setError(null)
                setRetrySelection(null)
              }}
              placeholder="1.5"
              endContent={<span className="text-xs text-muted">GWEI</span>}
              disabled={updating}
            />
            <Button
              type="button"
              variant="outline"
              className="h-9 shrink-0"
              disabled={updating || customPriorityFeeGwei.trim().length === 0}
              onClick={() => {
                try {
                  void handleSelect(parseEvmPriorityFeeGwei(customPriorityFeeGwei))
                } catch (cause) {
                  setRetrySelection(null)
                  setError(cause instanceof Error ? cause.message : 'Invalid priority fee')
                }
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
      <InlineError
        message={error}
        retrying={updating}
        onRetry={retrySelection ? () => void handleSelect(retrySelection) : undefined}
      />
    </div>
  )
}
