import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { getNetworkFeeTierLabel, type NetworkFeeTier } from '@/core/transactions/domain'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import { openModal } from '@/popup/provider/ModalManager'
import { Input } from '@/popup/components/ui/input'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { InlineError } from '@/popup/components/common/InlineError'
import { classifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  evmFeeDraft,
  parseEvmFeeDraft,
  type EvmFeeDefaults,
  type NetworkFeePreview,
  type NetworkFeePreviews
} from '@/popup/services/network-fee-presentation'
import { NetworkFeeTierSelector } from './NetworkFeeTierSelector'
import { TransactionActionDetails, TransactionActionReview } from './TransactionActionReview'

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
  readonly customDefaults?: EvmFeeDefaults | null
  readonly feeModel?: 'eip1559' | 'legacy'
  readonly loadTierPreviews?: () => Promise<NetworkFeePreviews>
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
  customDefaults,
  feeModel = 'eip1559',
  loadTierPreviews
}: NetworkFeeTierPickerProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const handleEdit = async () => {
    await openModal({
      title: 'Network Fee',
      className: 'max-h-[calc(100dvh-1rem)] overflow-y-auto',
      body: (_resolve, close) => (
        <NetworkFeeTierEditContent
          chainFamily={chainFamily}
          selection={selection ?? { kind: 'tier', tier }}
          currentFee={{ amount, symbol }}
          loadTierPreviews={loadTierPreviews}
          allowCustom={chainFamily === 'evm' && onSelectionChange !== undefined}
          details={details}
          customDefaults={customDefaults}
          feeModel={feeModel}
          onSelect={next => {
            if (onSelectionChange) return onSelectionChange(next)
            if (next.kind === 'tier') return onTierChange(next.tier)
          }}
          close={close}
        />
      )
    })
    requestAnimationFrame(() => trigger.current?.focus())
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col items-end gap-0.5 text-right',
        layout === 'inline' && 'flex-row flex-wrap items-center justify-end gap-x-2 gap-y-1'
      )}
    >
      <AmountDisplay value={amount} symbol={symbol} profile="fee" />
      <button
        ref={trigger}
        type="button"
        onClick={() => void handleEdit()}
        disabled={disabled}
        className="inline-flex min-h-6 items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-60"
        aria-label="Edit network fee"
      >
        {selection && selection.kind !== 'tier' ? 'Custom' : getNetworkFeeTierLabel(tier)}
        <Icon icon="lucide:chevron-down" className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

const legacyGasFields = [
  ['gasLimit', 'Gas limit'],
  ['gasPrice', 'Gas price']
] as const
const eip1559GasFields = [
  ['gasLimit', 'Gas limit'],
  ['maxFee', 'Max fee per gas'],
  ['priorityFee', 'Priority fee per gas']
] as const

function NetworkFeeTierEditContent({
  chainFamily,
  selection,
  currentFee,
  loadTierPreviews,
  allowCustom,
  details,
  customDefaults,
  feeModel,
  onSelect,
  close
}: {
  readonly chainFamily: NetworkFeeTierPickerProps['chainFamily']
  readonly selection: EvmFeeSelection
  readonly currentFee: NetworkFeePreview
  readonly loadTierPreviews?: NetworkFeeTierPickerProps['loadTierPreviews']
  readonly allowCustom: boolean
  readonly details?: ReactNode
  readonly customDefaults?: EvmFeeDefaults | null
  readonly feeModel: NonNullable<NetworkFeeTierPickerProps['feeModel']>
  readonly onSelect: (selection: EvmFeeSelection) => void | Promise<void>
  readonly close: () => void
}) {
  const [updating, setUpdating] = useState(false)
  const [failure, setFailure] = useState<{ message: string; retry?: EvmFeeSelection } | null>(null)
  const [tier, setTier] = useState(selection.kind === 'tier' ? selection.tier : null)
  const [advanced, setAdvanced] = useState(selection.kind !== 'tier')
  const [draft, setDraft] = useState(() => evmFeeDraft(selection, customDefaults))
  const [previews, setPreviews] = useState<NetworkFeePreviews | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  const advancedId = useId()
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!loadTierPreviews) return
    let active = true
    void Promise.resolve()
      .then(loadTierPreviews)
      .then(
        result => {
          if (active) setPreviews(result)
        },
        () => {
          if (active) setPreviews({})
        }
      )
    return () => {
      active = false
    }
  }, [loadTierPreviews])

  const canEditCustom = allowCustom && (customDefaults != null || selection.kind !== 'tier')
  const custom = canEditCustom && advanced
  const shownPreviews =
    selection.kind === 'tier' ? { ...previews, [selection.tier]: currentFee } : (previews ?? {})
  const fields = feeModel === 'legacy' ? legacyGasFields : eip1559GasFields

  const applySelection = async (next: EvmFeeSelection) => {
    if (pending.current) return
    pending.current = true
    setUpdating(true)
    setFailure(null)
    try {
      await onSelect(next)
      if (mounted.current) close()
    } catch (cause) {
      if (mounted.current) {
        setFailure({
          message: cause instanceof Error ? cause.message : 'The network fee could not be updated.',
          retry: classifyError(cause).retryable ? next : undefined
        })
      }
    } finally {
      pending.current = false
      if (mounted.current) setUpdating(false)
    }
  }

  const apply = () => {
    if (!custom) {
      if (tier) void applySelection({ kind: 'tier', tier })
      return
    }
    try {
      void applySelection(parseEvmFeeDraft(draft, feeModel))
    } catch (cause) {
      setFailure({ message: cause instanceof Error ? cause.message : 'Invalid network fee' })
    }
  }

  return (
    <TransactionActionReview
      backLabel="Cancel"
      onBack={close}
      backDisabled={updating}
      confirmLabel="Apply"
      onConfirm={apply}
      loading={updating}
      disabled={custom ? fields.some(([field]) => !draft[field].trim()) : tier === null}
    >
      <NetworkFeeTierSelector
        chainFamily={chainFamily}
        value={custom ? null : tier}
        onChange={next => {
          setAdvanced(false)
          setTier(next)
          setFailure(null)
        }}
        disabled={updating}
        previews={shownPreviews}
        loading={Boolean(loadTierPreviews) && previews === null}
      />
      {canEditCustom ? (
        <>
          <button
            type="button"
            aria-expanded={custom}
            aria-controls={advancedId}
            disabled={updating}
            className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md text-xs font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => {
              setAdvanced(!advanced)
              setFailure(null)
            }}
          >
            Advanced
            <Icon
              icon="lucide:chevron-down"
              className={cn('size-4 transition-transform', custom && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
          <div id={advancedId} hidden={!custom} className={cn(custom && 'grid gap-2.5')}>
            {fields.map(([field, label]) => (
              <label key={field} className="grid min-w-0 gap-1 text-xs font-medium">
                {label}
                <Input
                  inputMode={field === 'gasLimit' ? 'numeric' : 'decimal'}
                  value={draft[field]}
                  onChange={event => {
                    const value = event.target.value
                    setDraft(previous => ({ ...previous, [field]: value }))
                    setFailure(null)
                  }}
                  disabled={updating}
                  endContent={
                    field !== 'gasLimit' ? (
                      <span className="text-xs text-muted">GWEI</span>
                    ) : undefined
                  }
                />
              </label>
            ))}
          </div>
        </>
      ) : (
        details && <TransactionActionDetails>{details}</TransactionActionDetails>
      )}
      <InlineError
        message={failure?.message}
        retrying={updating}
        onRetry={failure?.retry ? () => void applySelection(failure.retry!) : undefined}
      />
    </TransactionActionReview>
  )
}
