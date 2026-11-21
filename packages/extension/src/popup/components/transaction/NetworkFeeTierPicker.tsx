import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { getFeeTierLabel, type FeeTier } from '@/config/fee'
import { getNetworkFeeTierLabel, type NetworkFeeTier } from '@/core/transactions/domain'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import { Input } from '@/popup/components/ui/input'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { DetailRow } from '@/popup/components/common/DetailRow'
import { InlineError } from '@/popup/components/common/InlineError'
import { Skeleton } from '@/popup/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/popup/components/ui/dialog'
import { classifyError } from '@/lib/errors'
import { formatSymbol } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  evmFeeDraft,
  networkFeeOptions,
  parseEvmFeeDraft,
  zcashFeeOptions,
  zcashFeePresentation,
  type EvmFeeDefaults,
  type FeeOption,
  type NetworkFeePreview,
  type NetworkFeePreviews
} from '@/popup/services/network-fee-presentation'
import { TransactionActionDetails, TransactionActionReview } from './TransactionActionReview'

interface LiveFeePickerProps {
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
  readonly fixedGasLimit?: boolean
  readonly loadTierPreviews?: () => Promise<NetworkFeePreviews>
}

interface ZcashFeePickerProps {
  readonly chainFamily: 'zcash'
  readonly tier: FeeTier
  readonly onTierChange: (tier: FeeTier) => void
  readonly feeByTier: Record<FeeTier, number | null>
  readonly loading?: boolean
  readonly loadingByTier?: Record<FeeTier, boolean>
  readonly allowFallback?: boolean
  readonly hideLabel?: boolean
}

export function NetworkFeeTierPicker(props: LiveFeePickerProps | ZcashFeePickerProps) {
  if (props.chainFamily === 'zcash') {
    const { amount, fees, approximate } = zcashFeePresentation(props)
    const value = props.loading ? (
      <span role="status" aria-label="Estimating network fee" className="inline-flex items-center">
        <Skeleton className="h-4 w-24" />
      </span>
    ) : amount === null ? (
      <span className="text-sm">Unavailable</span>
    ) : (
      <AmountDisplay value={amount} symbol="ZEC" profile="fee" prefix="≈ " className="text-sm" />
    )
    const picker = (
      <FeePickerDialog value={value} label={`(${getFeeTierLabel(props.tier)})`} layout="inline">
        {close => (
          <ZcashFeeOptions
            tier={props.tier}
            fees={fees}
            approximate={approximate}
            loading={props.loading}
            loadingByTier={props.loadingByTier}
            onTierChange={props.onTierChange}
            close={close}
          />
        )}
      </FeePickerDialog>
    )
    return props.hideLabel ? picker : <DetailRow label="Network Fee">{picker}</DetailRow>
  }

  const {
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
    fixedGasLimit = false,
    loadTierPreviews
  } = props
  return (
    <FeePickerDialog
      value={<AmountDisplay value={amount} symbol={symbol} profile="fee" />}
      label={selection && selection.kind !== 'tier' ? 'Custom' : getNetworkFeeTierLabel(tier)}
      layout={layout}
      disabled={disabled}
    >
      {close => (
        <NetworkFeeTierEditContent
          chainFamily={chainFamily}
          selection={selection ?? { kind: 'tier', tier }}
          currentFee={{ amount, symbol }}
          loadTierPreviews={loadTierPreviews}
          allowCustom={chainFamily === 'evm' && onSelectionChange !== undefined}
          details={details}
          customDefaults={customDefaults}
          feeModel={feeModel}
          fixedGasLimit={fixedGasLimit}
          onSelect={next => {
            if (onSelectionChange) return onSelectionChange(next)
            if (next.kind === 'tier') return onTierChange(next.tier)
          }}
          close={close}
        />
      )}
    </FeePickerDialog>
  )
}

function FeePickerDialog({
  value,
  label,
  disabled,
  layout,
  children
}: {
  readonly value: ReactNode
  readonly label: string
  readonly disabled?: boolean
  readonly layout: 'stacked' | 'inline'
  readonly children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'flex min-w-0 flex-col items-end gap-0.5 text-right',
          layout === 'inline' && 'flex-row flex-wrap items-center justify-end gap-x-2 gap-y-1'
        )}
      >
        {value}
        <DialogTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="inline-flex min-h-6 items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-60"
            aria-label="Edit network fee"
          >
            {label}
            <Icon icon="lucide:chevron-down" className="size-3.5" aria-hidden="true" />
          </button>
        </DialogTrigger>
      </div>
      <DialogContent position="bottom" className="gap-5 overflow-y-auto">
        {children(() => setOpen(false))}
      </DialogContent>
    </Dialog>
  )
}

function ZcashFeeOptions({
  tier,
  fees,
  approximate,
  loading,
  loadingByTier,
  onTierChange,
  close
}: {
  readonly tier: FeeTier
  readonly fees: ZcashFeePickerProps['feeByTier']
  readonly approximate: boolean
  readonly loading?: boolean
  readonly loadingByTier?: ZcashFeePickerProps['loadingByTier']
  readonly onTierChange: ZcashFeePickerProps['onTierChange']
  readonly close: () => void
}) {
  return (
    <>
      <DialogHeader className="min-h-6 justify-center pr-9 text-left">
        <DialogTitle>Network Fee</DialogTitle>
        <DialogDescription className="sr-only">Select a network fee</DialogDescription>
      </DialogHeader>
      <FeeOptionList
        value={tier}
        onSelect={next => {
          if (next !== tier) onTierChange(next)
          close()
        }}
        options={zcashFeeOptions({ selected: tier, fees, loading, loadingByTier })}
      />
      {approximate && <p className="text-xs text-muted">Approximate fee</p>}
    </>
  )
}

function FeeOptionList<T extends string>({
  options,
  value,
  onSelect,
  disabled
}: {
  readonly options: readonly FeeOption<T>[]
  readonly value: T | null
  readonly onSelect: (value: T) => void
  readonly disabled?: boolean
}) {
  const name = useId()
  return (
    <div className="@container min-w-0">
      <div
        role="group"
        aria-label="Network fee speed"
        aria-busy={disabled}
        className={cn(
          'grid grid-cols-1 gap-1.5 @min-[300px]:gap-2',
          options.length === 2 ? '@min-[252px]:grid-cols-2' : '@min-[252px]:grid-cols-3'
        )}
      >
        {options.map(option => {
          const selected = option.id === value
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                if (!disabled) onSelect(option.id)
              }}
              aria-label={option.label}
              aria-pressed={selected}
              aria-disabled={disabled}
              aria-describedby={`${name}-${option.id}-amount${option.caption ? ` ${name}-${option.id}-caption` : ''}`}
              className={cn(
                'flex min-h-11 min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left',
                '@min-[252px]:min-h-[72px] @min-[252px]:flex-col @min-[252px]:justify-center @min-[252px]:gap-1 @min-[252px]:px-1 @min-[252px]:py-2.5',
                'transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary',
                disabled ? 'cursor-wait opacity-70' : 'cursor-pointer',
                selected
                  ? 'border-primary/75 bg-primary/10'
                  : 'border-border/70 bg-card/35 hover:bg-card/60'
              )}
            >
              <span className="min-w-0 flex-1 @min-[252px]:w-full @min-[252px]:flex-none @min-[252px]:text-center">
                <span
                  className={cn(
                    'block text-sm font-medium leading-4.5',
                    selected && 'text-primary'
                  )}
                >
                  {option.label}
                </span>
                {option.caption && (
                  <span
                    id={`${name}-${option.id}-caption`}
                    className="mt-0.5 block text-[11px] leading-3.5 text-muted"
                  >
                    {option.caption}
                  </span>
                )}
              </span>
              <span
                id={`${name}-${option.id}-amount`}
                className="min-w-0 max-w-[63%] [overflow-wrap:anywhere] text-right text-xs leading-4 text-muted tabular-nums @min-[252px]:max-w-full @min-[252px]:text-center @min-[252px]:text-[11px] @min-[300px]:text-xs"
              >
                {option.loading ? (
                  <span role="status" aria-label={`Estimating ${option.label} network fee`}>
                    <span className="ml-auto block h-4 w-14 max-w-full animate-pulse rounded-md bg-white/[0.08] motion-reduce:animate-none @min-[252px]:mx-auto" />
                  </span>
                ) : option.preview ? (
                  <>
                    <AmountDisplay
                      value={option.preview.amount}
                      prefix={option.preview.approximate ? '≈\u00a0' : undefined}
                      profile="fee"
                      className="break-normal"
                    />{' '}
                    <span className="text-[11px] @min-[252px]:block">
                      {formatSymbol(option.preview.symbol)}
                    </span>
                  </>
                ) : (
                  <span aria-label="Fee unavailable">&ndash;</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FeeAmountSummary({
  label,
  fee
}: {
  readonly label: string
  readonly fee: NetworkFeePreview | undefined
}) {
  return (
    <dl className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-card/45 px-3.5 py-3">
      <dt className="min-w-0 text-xs text-muted">{label}</dt>
      <dd aria-live="polite" className="min-w-0 text-right text-base font-semibold leading-5">
        <AmountDisplay
          value={fee?.amount}
          symbol={fee?.symbol}
          prefix={fee?.approximate ? '≈ ' : undefined}
          profile="fee"
          className="[overflow-wrap:anywhere] break-normal"
        />
      </dd>
    </dl>
  )
}

const legacyGasFields = [
  ['gasPrice', 'Gas price'],
  ['gasLimit', 'Gas limit']
] as const
const eip1559GasFields = [
  ['maxFee', 'Max fee per gas'],
  ['priorityFee', 'Max priority fee'],
  ['gasLimit', 'Gas limit']
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
  fixedGasLimit,
  onSelect,
  close
}: {
  readonly chainFamily: LiveFeePickerProps['chainFamily']
  readonly selection: EvmFeeSelection
  readonly currentFee: NetworkFeePreview
  readonly loadTierPreviews?: LiveFeePickerProps['loadTierPreviews']
  readonly allowCustom: boolean
  readonly details?: ReactNode
  readonly customDefaults?: EvmFeeDefaults | null
  readonly feeModel: NonNullable<LiveFeePickerProps['feeModel']>
  readonly fixedGasLimit: boolean
  readonly onSelect: (selection: EvmFeeSelection) => void | Promise<void>
  readonly close: () => void
}) {
  const [updating, setUpdating] = useState(false)
  const [failure, setFailure] = useState<{ message: string; retry?: EvmFeeSelection } | null>(null)
  const tier = selection.kind === 'tier' ? selection.tier : null
  const [draft, setDraft] = useState<ReturnType<typeof evmFeeDraft> | null>(null)
  const [previews, setPreviews] = useState<NetworkFeePreviews | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  const customEntry = useRef<HTMLButtonElement>(null)
  const customHeading = useRef<HTMLHeadingElement>(null)
  const customApplied = selection.kind !== 'tier'
  const editingCustom = draft !== null
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
  useEffect(() => {
    if (editingCustom) customHeading.current?.focus()
  }, [editingCustom])

  const canEditCustom = allowCustom && (customDefaults != null || customApplied)
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
    if (!draft) return
    try {
      void applySelection(parseEvmFeeDraft(draft, feeModel, fixedGasLimit))
    } catch (cause) {
      setFailure({ message: cause instanceof Error ? cause.message : 'Invalid network fee' })
    }
  }

  const backToOptions = () => {
    setDraft(null)
    setFailure(null)
    requestAnimationFrame(() => customEntry.current?.focus())
  }

  const error = (
    <InlineError
      message={failure?.message}
      retrying={updating}
      onRetry={failure?.retry ? () => void applySelection(failure.retry!) : undefined}
    />
  )

  return (
    <>
      <DialogHeader className="min-h-6 flex-row items-center justify-between pr-9 text-left">
        <DialogTitle ref={customHeading} tabIndex={-1} className="outline-none">
          {draft ? 'Custom gas' : 'Network Fee'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {draft ? 'Edit gas parameters for this transaction' : 'Select a network fee'}
        </DialogDescription>
        {!draft && allowCustom && (
          <button
            ref={customEntry}
            type="button"
            aria-label="Custom gas"
            title={!canEditCustom ? 'Gas estimate required' : undefined}
            disabled={!canEditCustom || updating}
            className={cn(
              '-my-1 inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors enabled:hover:bg-card enabled:hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-55',
              customApplied ? 'text-primary' : 'text-muted'
            )}
            onClick={() => {
              setDraft(
                evmFeeDraft(
                  fixedGasLimit ? { kind: 'tier', tier: 'standard' } : selection,
                  customDefaults
                )
              )
              setFailure(null)
            }}
          >
            <Icon icon="lucide:pencil" className="size-3.5" aria-hidden="true" />
            Custom
          </button>
        )}
      </DialogHeader>
      {draft ? (
        <TransactionActionReview
          onBack={backToOptions}
          backDisabled={updating}
          confirmLabel="Apply"
          onConfirm={apply}
          loading={updating}
          disabled={fields.some(
            ([field]) => !(fixedGasLimit && field === 'gasLimit') && !draft[field].trim()
          )}
        >
          <FeeAmountSummary label="Current maximum fee" fee={currentFee} />
          <div className="divide-y divide-border/60 rounded-lg border border-border/65 bg-card/25">
            {fields.map(([field, label]) => {
              const isLimit = field === 'gasLimit'
              const readOnly = isLimit && fixedGasLimit
              return (
                <label
                  key={field}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,138px)] items-center gap-2 px-3 py-2 text-xs font-medium"
                >
                  <span>{label}</span>
                  <Input
                    inputMode={isLimit ? 'numeric' : 'decimal'}
                    aria-label={isLimit ? label : `${label} (Gwei)`}
                    value={draft[field]}
                    readOnly={readOnly}
                    onChange={event => {
                      setDraft({ ...draft, [field]: event.target.value })
                      setFailure(null)
                    }}
                    disabled={updating}
                    className={cn(
                      'border-border/65 bg-background text-right text-sm tabular-nums shadow-none read-only:border-transparent read-only:bg-transparent read-only:text-muted',
                      (!isLimit || readOnly) && 'pr-11'
                    )}
                    endContent={
                      !isLimit || readOnly ? (
                        <span aria-hidden="true" className="text-xs text-muted">
                          {readOnly ? <Icon icon="lucide:lock" className="size-3.5" /> : 'Gwei'}
                        </span>
                      ) : undefined
                    }
                  />
                </label>
              )
            })}
          </div>
          {error}
        </TransactionActionReview>
      ) : (
        <div className="space-y-3">
          <FeeAmountSummary
            label={chainFamily === 'evm' ? 'Maximum fee' : 'Estimated fee'}
            fee={currentFee}
          />
          <FeeOptionList
            value={tier}
            onSelect={next => {
              if (pending.current) return
              if (tier === next) close()
              else void applySelection({ kind: 'tier', tier: next })
            }}
            disabled={updating}
            options={networkFeeOptions(
              chainFamily,
              shownPreviews,
              Boolean(loadTierPreviews) && previews === null
            )}
          />
          {!allowCustom && details && (
            <TransactionActionDetails>{details}</TransactionActionDetails>
          )}
          {updating && (
            <p role="status" className="text-xs text-muted">
              Updating fee…
            </p>
          )}
          {error}
        </div>
      )}
    </>
  )
}
