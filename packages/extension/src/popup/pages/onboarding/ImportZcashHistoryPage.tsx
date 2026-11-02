import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { DatePicker } from '../../components/ui/date-picker'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { getFullZcashRecoveryBirthdayHeight } from '@/core/wallet/birthday-height'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { classifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { getUtcDayStartTimestamp } from '@/lib/zcash-birthday'
import dayjs from '@/lib/dayjs'
import { getImportZcashHistoryDefaults } from '@/popup/services/import-zcash-history-selection'

type HistoryMode = 'new' | 'restore'
type RestoreMethod = 'date' | 'height'

class ZcashHistoryValidationError extends Error {}

export function ImportZcashHistoryPage() {
  const { navigate, replace } = useNavigate()
  const {
    flowMode,
    importedSeedPhrase,
    birthdayHeight,
    importZcashHistorySelection,
    setBirthdayHeight,
    setImportZcashHistorySelection,
    addImportedWallet,
    error: storeError
  } = useOnboardingStore()
  const fullRecoveryHeight = getFullZcashRecoveryBirthdayHeight(DEFAULT_NETWORK)
  const [initialSelection] = useState(() =>
    getImportZcashHistoryDefaults(birthdayHeight, importZcashHistorySelection)
  )
  const [historyMode, setHistoryMode] = useState<HistoryMode>(initialSelection.historyMode)
  const [restoreMethod, setRestoreMethod] = useState<RestoreMethod>(initialSelection.restoreMethod)
  const [syncDate, setSyncDate] = useState<dayjs.Dayjs | null>(
    initialSelection.syncDate ? dayjs(initialSelection.syncDate) : null
  )
  const [syncHeight, setSyncHeight] = useState(initialSelection.syncHeight)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)

  useEffect(() => {
    if (!importedSeedPhrase) replace('/onboarding/import')
  }, [importedSeedPhrase, replace])

  const selectHistoryMode = (mode: HistoryMode) => {
    setHistoryMode(mode)
    setError(null)
  }

  const selectRestoreMethod = (method: RestoreMethod) => {
    setRestoreMethod(method)
    setError(null)
  }

  const resolveBirthdayHeight = async (): Promise<number | undefined> => {
    if (historyMode === 'new') return undefined

    if (restoreMethod === 'height') {
      const normalizedHeight = syncHeight.replace(/,/g, '').trim()
      if (!/^\d+$/.test(normalizedHeight)) {
        throw new ZcashHistoryValidationError('Enter a valid Zcash block height.')
      }
      const height = Number(normalizedHeight)
      if (!Number.isSafeInteger(height) || height < fullRecoveryHeight) {
        throw new ZcashHistoryValidationError(
          `Block height must be ${fullRecoveryHeight.toLocaleString()} or later.`
        )
      }
      return height
    }

    if (!syncDate) {
      throw new ZcashHistoryValidationError(
        'Select the approximate date of the first ZEC transaction.'
      )
    }
    const timestamp = getUtcDayStartTimestamp(syncDate)
    const resolvedHeight = await zcashWalletRuntimeClient.getBlockByTime(timestamp)
    if (!Number.isSafeInteger(resolvedHeight) || resolvedHeight <= 0) {
      throw new Error('The Zcash network returned an invalid block height. Please try again.')
    }
    return Math.max(fullRecoveryHeight, resolvedHeight)
  }

  const handleContinue = async () => {
    setError(null)
    setRetryable(false)
    setIsImporting(true)
    try {
      const height = await resolveBirthdayHeight()
      setBirthdayHeight(height)
      setImportZcashHistorySelection(
        historyMode === 'new'
          ? { mode: 'new' }
          : restoreMethod === 'date'
            ? { mode: 'restore', method: 'date', date: syncDate!.format('YYYY-MM-DD') }
            : { mode: 'restore', method: 'height' }
      )

      if (flowMode === 'addWallet') {
        const success = await addImportedWallet()
        if (success) replace('/onboarding/congratulations')
        return
      }
      navigate('/onboarding/import-password')
    } catch (cause) {
      const classified = classifyError(cause)
      const validationError = cause instanceof ZcashHistoryValidationError
      setError(validationError ? cause.message : classified.userMessage)
      setRetryable(!validationError && classified.retryable)
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Zcash history" showBack backDisabled={isImporting} />

      <div className="page-content py-5">
        <h1 className="text-lg font-semibold">Has this recovery phrase ever received ZEC?</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          This only changes where Zcash begins looking for older transactions. Other networks are
          restored normally.
        </p>

        <div role="radiogroup" aria-label="Zcash history" className="mt-5 space-y-3">
          <HistoryChoice
            title="New to Zcash"
            description="Choose this for a phrase from a wallet that did not support Zcash."
            selected={historyMode === 'new'}
            onSelect={() => selectHistoryMode('new')}
          />
          <HistoryChoice
            title="Restore Zcash history"
            description="Choose this if this phrase previously received ZEC."
            selected={historyMode === 'restore'}
            onSelect={() => selectHistoryMode('restore')}
          />
        </div>

        {historyMode === 'restore' && (
          <div className="mt-5 space-y-3 border-t border-white/10 pt-4">
            <div
              role="radiogroup"
              aria-label="Zcash history start"
              className="grid grid-cols-2 gap-2"
            >
              <RestoreMethodChoice
                label="Date"
                icon="lucide:calendar-days"
                selected={restoreMethod === 'date'}
                onSelect={() => selectRestoreMethod('date')}
              />
              <RestoreMethodChoice
                label="Block height"
                icon="lucide:blocks"
                selected={restoreMethod === 'height'}
                onSelect={() => selectRestoreMethod('height')}
              />
            </div>
            {restoreMethod === 'height' ? (
              <div>
                <label className="mb-2 block text-sm text-muted">Custom Zcash block height</label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={syncHeight}
                  onChange={event => setSyncHeight(event.target.value)}
                  placeholder={`At least ${fullRecoveryHeight.toLocaleString()}`}
                  aria-label="Zcash birthday height"
                  className="h-[45px] rounded-xl font-mono"
                />
              </div>
            ) : (
              <div>
                <label className="mb-2 block text-sm text-muted">
                  Approximate first ZEC transaction
                </label>
                <DatePicker
                  value={syncDate}
                  onChange={value => {
                    setSyncDate(value)
                    selectRestoreMethod('date')
                  }}
                  ariaLabel="First ZEC transaction date"
                  minDate={dayjs(DEFAULT_NETWORK === 'mainnet' ? '2018-10-01' : '2018-01-01')}
                  placeholder="Select date"
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="page-footer">
        {(error || storeError) && (
          <InlineError
            message={error || storeError}
            onRetry={error && retryable ? () => void handleContinue() : undefined}
            retrying={isImporting}
            className="mb-3"
          />
        )}
        <Button
          onClick={handleContinue}
          disabled={isImporting}
          isLoading={isImporting}
          className="h-[45px] w-full"
        >
          Continue
        </Button>
      </div>
    </div>
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
  description,
  selected,
  onSelect
}: {
  readonly title: string
  readonly description: string
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
        'flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected
          ? 'border-primary/60 bg-primary/5'
          : 'border-white/10 bg-card hover:border-white/20'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2',
          selected ? 'border-primary' : 'border-muted'
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span>
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted">{description}</span>
      </span>
    </button>
  )
}
