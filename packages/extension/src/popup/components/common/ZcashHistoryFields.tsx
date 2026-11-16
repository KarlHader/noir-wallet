import { Icon } from '@iconify/react'
import { DatePicker } from '../ui/date-picker'
import { Input } from '../ui/input'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getFullZcashRecoveryBirthdayHeight } from '@/core/wallet/birthday-height'
import { cn } from '@/lib/utils'
import dayjs from '@/lib/dayjs'

export type ZcashHistoryMode = 'new' | 'restore'
export type ZcashRestoreMethod = 'date' | 'height'

interface ZcashHistoryFieldsProps {
  readonly historyMode: ZcashHistoryMode | null
  readonly restoreMethod: ZcashRestoreMethod
  readonly syncDate: dayjs.Dayjs | null
  readonly syncHeight: string
  readonly requireRestore?: boolean
  readonly onHistoryModeChange: (mode: ZcashHistoryMode) => void
  readonly onRestoreMethodChange: (method: ZcashRestoreMethod) => void
  readonly onSyncDateChange: (date: dayjs.Dayjs | null) => void
  readonly onSyncHeightChange: (height: string) => void
}

export function ZcashHistoryFields({
  historyMode,
  restoreMethod,
  syncDate,
  syncHeight,
  requireRestore = false,
  onHistoryModeChange,
  onRestoreMethodChange,
  onSyncDateChange,
  onSyncHeightChange
}: ZcashHistoryFieldsProps) {
  const fullRecoveryHeight = getFullZcashRecoveryBirthdayHeight(DEFAULT_NETWORK)

  return (
    <>
      {!requireRestore && (
        <div role="radiogroup" aria-label="Zcash account setup" className="space-y-2">
          <HistoryChoice
            title="New Zcash Account"
            selected={historyMode === 'new'}
            onSelect={() => onHistoryModeChange('new')}
          />
          <HistoryChoice
            title="Restore Zcash Account"
            selected={historyMode === 'restore'}
            onSelect={() => onHistoryModeChange('restore')}
          />
        </div>
      )}

      {historyMode === 'restore' && (
        <div className={cn('space-y-3', !requireRestore && 'mt-4 border-t border-white/10 pt-4')}>
          <div
            role="radiogroup"
            aria-label="Zcash history start"
            className="grid grid-cols-2 gap-2"
          >
            <RestoreMethodChoice
              label="Date"
              icon="lucide:calendar-days"
              selected={restoreMethod === 'date'}
              onSelect={() => onRestoreMethodChange('date')}
            />
            <RestoreMethodChoice
              label="Block height"
              icon="lucide:blocks"
              selected={restoreMethod === 'height'}
              onSelect={() => onRestoreMethodChange('height')}
            />
          </div>
          {restoreMethod === 'height' ? (
            <div>
              <label className="mb-2 block text-sm text-muted">Block height</label>
              <Input
                type="text"
                inputMode="numeric"
                value={syncHeight}
                onChange={event => onSyncHeightChange(event.target.value)}
                placeholder={`At least ${fullRecoveryHeight.toLocaleString()}`}
                aria-label="Zcash birthday height"
                className="h-[45px] rounded-xl font-mono"
              />
            </div>
          ) : (
            <div>
              <label className="mb-2 block text-sm text-muted">Recovery start date</label>
              <DatePicker
                value={syncDate}
                onChange={onSyncDateChange}
                ariaLabel="First ZEC transaction date"
                minDate={dayjs(DEFAULT_NETWORK === 'mainnet' ? '2018-10-01' : '2018-01-01')}
                placeholder="Select date"
              />
            </div>
          )}
        </div>
      )}
    </>
  )
}

function RestoreMethodChoice({
  label,
  icon,
  selected,
  onSelect
}: {
  readonly label: string
  readonly icon: string
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={label}
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 py-2 text-center text-[11px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected
          ? 'border-primary/60 bg-primary/5 text-foreground'
          : 'border-white/10 bg-card text-muted hover:border-white/20 hover:text-foreground'
      )}
    >
      <Icon icon={icon} width={16} height={16} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

function HistoryChoice({
  title,
  selected,
  onSelect
}: {
  readonly title: string
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={title}
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-12 w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected
          ? 'border-primary/60 bg-primary/5'
          : 'border-white/10 bg-card hover:border-white/20'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border-2',
          selected ? 'border-primary' : 'border-muted'
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span className="text-sm font-medium text-foreground">{title}</span>
    </button>
  )
}
