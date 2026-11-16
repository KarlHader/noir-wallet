import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { getNetworkFeeTierLabel, type NetworkFeeTier } from '@/core/transactions/domain'
import {
  formatEvmPriorityFeeGwei,
  formatEvmWeiAsGwei,
  parseEvmPriorityFeeGwei,
  parseEvmFeeSelection,
  type EvmFeeSelection
} from '@/infrastructure/chains/evm'
import { parseDisplayUnitAmount } from '@/lib/number-format'
import { openModal } from '@/popup/provider/ModalManager'
import { Button } from '@/popup/components/ui/button'
import { Input } from '@/popup/components/ui/input'
import { NetworkFeeTierSelector } from './NetworkFeeTierSelector'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { classifyError } from '@/lib/errors'
import { InlineError } from '@/popup/components/common/InlineError'
import { cn } from '@/lib/utils'

interface NetworkFeeTierPickerProps {
  readonly chainFamily: 'bitcoin' | 'evm'
  readonly tier: NetworkFeeTier
  readonly selection?: EvmFeeSelection
  readonly amount: string
  readonly symbol: string
  readonly onTierChange: (tier: NetworkFeeTier) => void | Promise<void>
  readonly onSelectionChange?: (selection: EvmFeeSelection) => void | Promise<void>
  readonly disabled?: boolean
  readonly details?: ReactNode
  readonly layout?: 'stacked' | 'inline'
  readonly showAmountDetails?: boolean
  readonly customDefaults?: Readonly<{
    gasLimit: string
    maxFeePerGasWei: string
    maxPriorityFeePerGasWei: string
    gasPriceWei?: string | null
  }> | null
  readonly feeModel?: 'eip1559' | 'legacy'
}

export function NetworkFeeTierPicker({
  chainFamily,
  tier,
  selection,
  amount,
  symbol,
  onTierChange,
  onSelectionChange,
  disabled = false,
  details,
  layout = 'stacked',
  showAmountDetails = true,
  customDefaults,
  feeModel = 'eip1559'
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
          details={details}
          customDefaults={customDefaults}
          feeModel={feeModel}
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
    <div
      className={cn(
        'flex min-w-0 flex-col items-end gap-0.5 text-right',
        layout === 'inline' && 'flex-row flex-wrap items-center justify-end gap-x-2 gap-y-1'
      )}
    >
      <AmountDisplay value={amount} symbol={symbol} profile="fee" showDetails={showAmountDetails} />
      <button
        type="button"
        onClick={handleEdit}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1 text-[10px] text-muted transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60',
          layout === 'inline' && 'text-xs'
        )}
        aria-label="Edit network fee"
      >
        <span>
          {selection?.kind === 'custom' || selection?.kind === 'legacy'
            ? 'Custom'
            : getNetworkFeeTierLabel(tier)}
        </span>
        <Icon
          icon={
            disabled
              ? 'lucide:loader-2'
              : layout === 'inline'
                ? 'lucide:chevron-down'
                : 'lucide:pencil'
          }
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
  details,
  customDefaults,
  feeModel,
  onSelect,
  close
}: {
  readonly chainFamily: 'bitcoin' | 'evm'
  readonly selection: EvmFeeSelection
  readonly allowCustom: boolean
  readonly details?: ReactNode
  readonly customDefaults?: NetworkFeeTierPickerProps['customDefaults']
  readonly feeModel: 'eip1559' | 'legacy'
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
    formatEvmPriorityFeeGwei(selection) ??
      (customDefaults ? formatEvmWeiAsGwei(customDefaults.maxPriorityFeePerGasWei) : '')
  )
  const [customMaximumFeeGwei, setCustomMaximumFeeGwei] = useState(
    selection.kind === 'custom' && selection.maxFeePerGasWei
      ? formatEvmWeiAsGwei(selection.maxFeePerGasWei)
      : customDefaults
        ? formatEvmWeiAsGwei(customDefaults.maxFeePerGasWei)
        : ''
  )
  const [customGasLimit, setCustomGasLimit] = useState(
    (selection.kind === 'custom' || selection.kind === 'legacy') && selection.gasLimit
      ? selection.gasLimit
      : (customDefaults?.gasLimit ?? '')
  )
  const [customGasPriceGwei, setCustomGasPriceGwei] = useState(
    selection.kind === 'legacy'
      ? formatEvmWeiAsGwei(selection.gasPriceWei)
      : customDefaults?.gasPriceWei
        ? formatEvmWeiAsGwei(customDefaults.gasPriceWei)
        : ''
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
      {details}
      {allowCustom && (
        <div className="space-y-2 rounded-md border border-border/60 bg-card/45 p-3">
          <label htmlFor="custom-gas-limit" className="block text-xs font-medium">
            Gas limit
          </label>
          <Input
            id="custom-gas-limit"
            inputMode="numeric"
            value={customGasLimit}
            onChange={event => {
              setCustomGasLimit(event.target.value)
              setError(null)
            }}
            placeholder="21000"
            disabled={updating}
          />
          {feeModel === 'legacy' ? (
            <>
              <label htmlFor="custom-gas-price" className="block text-xs font-medium">
                Gas price
              </label>
              <Input
                id="custom-gas-price"
                inputMode="decimal"
                value={customGasPriceGwei}
                onChange={event => {
                  setCustomGasPriceGwei(event.target.value)
                  setError(null)
                }}
                placeholder="3"
                endContent={<span className="text-xs text-muted">GWEI</span>}
                disabled={updating}
              />
            </>
          ) : (
            <>
              <label htmlFor="custom-maximum-fee" className="block text-xs font-medium">
                Max fee per gas
              </label>
              <Input
                id="custom-maximum-fee"
                inputMode="decimal"
                value={customMaximumFeeGwei}
                onChange={event => {
                  setCustomMaximumFeeGwei(event.target.value)
                  setError(null)
                }}
                placeholder="3"
                endContent={<span className="text-xs text-muted">GWEI</span>}
                disabled={updating}
              />
              <label htmlFor="custom-priority-fee" className="block text-xs font-medium">
                Priority fee per gas
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
              </div>
            </>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-9 w-full"
            disabled={
              updating ||
              !customGasLimit.trim() ||
              (feeModel === 'legacy'
                ? !customGasPriceGwei.trim()
                : !customPriorityFeeGwei.trim() || !customMaximumFeeGwei.trim())
            }
            onClick={() => {
              try {
                if (feeModel === 'legacy') {
                  void handleSelect(
                    parseEvmFeeSelection({
                      kind: 'legacy',
                      gasPriceWei: parseDisplayUnitAmount(customGasPriceGwei.trim(), 9),
                      gasLimit: customGasLimit.trim()
                    })
                  )
                  return
                }
                const priority = parseEvmPriorityFeeGwei(customPriorityFeeGwei)
                if (priority.kind !== 'custom') return
                void handleSelect(
                  parseEvmFeeSelection({
                    kind: 'custom',
                    maxPriorityFeePerGasWei: priority.maxPriorityFeePerGasWei,
                    maxFeePerGasWei: parseDisplayUnitAmount(customMaximumFeeGwei.trim(), 9),
                    gasLimit: customGasLimit.trim()
                  })
                )
              } catch (cause) {
                setRetrySelection(null)
                setError(cause instanceof Error ? cause.message : 'Invalid network fee')
              }
            }}
          >
            Apply
          </Button>
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
