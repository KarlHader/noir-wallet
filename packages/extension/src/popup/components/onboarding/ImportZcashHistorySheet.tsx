import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { InlineError } from '../common/InlineError'
import {
  ZcashHistoryFields,
  type ZcashHistoryMode,
  type ZcashRestoreMethod
} from '../zcash/ZcashHistoryFields'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { getFullZcashRecoveryBirthdayHeight } from '@/core/wallet/birthday-height'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { classifyError } from '@/lib/errors'
import { LatestAttempt } from '@/lib/async-utils'
import dayjs from '@/lib/dayjs'
import {
  getImportZcashHistoryDefaults,
  parseZcashHistoryRecoveryHeight,
  resolveZcashHistoryRecoveryDate
} from '@/popup/services/import-zcash-history-selection'

class ZcashHistoryValidationError extends Error {}

export function ImportZcashHistorySheet({ onClose }: { readonly onClose: () => void }) {
  const { navigate, replace } = useNavigate()
  const {
    flowMode,
    importedSeedPhrase,
    birthdayHeight,
    importZcashHistorySelection,
    setBirthdayHeight,
    setImportZcashHistorySelection,
    addImportedWallet
  } = useOnboardingStore()
  const fullRecoveryHeight = getFullZcashRecoveryBirthdayHeight(DEFAULT_NETWORK)
  const [initialSelection] = useState(() =>
    getImportZcashHistoryDefaults(birthdayHeight, importZcashHistorySelection)
  )
  const [historyMode, setHistoryMode] = useState<ZcashHistoryMode>(initialSelection.historyMode)
  const [restoreMethod, setRestoreMethod] = useState<ZcashRestoreMethod>(
    initialSelection.restoreMethod
  )
  const [syncDate, setSyncDate] = useState<dayjs.Dayjs | null>(
    initialSelection.syncDate ? dayjs(initialSelection.syncDate) : null
  )
  const [syncHeight, setSyncHeight] = useState(initialSelection.syncHeight)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const continueAttempts = useRef(new LatestAttempt())

  useEffect(() => {
    const attempts = continueAttempts.current
    return () => attempts.invalidate()
  }, [])

  useEffect(() => {
    if (!importedSeedPhrase) replace('/onboarding/import')
  }, [importedSeedPhrase, replace])

  const resetPendingContinue = () => {
    continueAttempts.current.invalidate()
    setIsImporting(false)
    setError(null)
    setRetryable(false)
  }

  const selectHistoryMode = (mode: ZcashHistoryMode) => {
    resetPendingContinue()
    setHistoryMode(mode)
  }

  const selectRestoreMethod = (method: ZcashRestoreMethod) => {
    resetPendingContinue()
    setRestoreMethod(method)
  }

  const resolveBirthdayHeight = async (): Promise<number | undefined> => {
    if (historyMode === 'new') return undefined

    if (restoreMethod === 'height') {
      const parsed = parseZcashHistoryRecoveryHeight(syncHeight, fullRecoveryHeight)
      if (parsed.height === null) {
        throw new ZcashHistoryValidationError(
          parsed.error === 'format'
            ? 'Enter a valid Zcash block height.'
            : `Block height must be ${fullRecoveryHeight.toLocaleString()} or later.`
        )
      }
      return parsed.height
    }

    if (!syncDate) {
      throw new ZcashHistoryValidationError(
        'Select a date before your account’s first transaction.'
      )
    }
    return resolveZcashHistoryRecoveryDate(syncDate, fullRecoveryHeight, timestamp =>
      zcashWalletRuntimeClient.getBlockByTime(timestamp)
    )
  }

  const handleContinue = async () => {
    const attempt = continueAttempts.current.begin()
    setError(null)
    setRetryable(false)
    setIsImporting(true)
    try {
      const height = await resolveBirthdayHeight()
      if (!continueAttempts.current.isCurrent(attempt)) return
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
        if (!continueAttempts.current.isCurrent(attempt)) return
        if (success) replace('/onboarding/congratulations')
        else setError(useOnboardingStore.getState().error)
        return
      }
      navigate('/onboarding/import-password')
    } catch (cause) {
      if (!continueAttempts.current.isCurrent(attempt)) return
      const classified = classifyError(cause)
      const validationError = cause instanceof ZcashHistoryValidationError
      setError(validationError ? cause.message : classified.userMessage)
      setRetryable(!validationError && classified.retryable)
    } finally {
      if (continueAttempts.current.isCurrent(attempt)) setIsImporting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !(flowMode === 'addWallet' && isImporting)) onClose()
      }}
    >
      <DialogContent position="bottom" scroll="body" className="gap-0 p-0">
        <DialogHeader className="shrink-0 px-5 pb-4 pt-5">
          <DialogTitle className="sr-only">Zcash account setup</DialogTitle>
          <DialogDescription className="pr-8">
            Has this phrase received ZEC before?
          </DialogDescription>
        </DialogHeader>

        <fieldset
          disabled={flowMode === 'addWallet' && isImporting}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4"
        >
          <ZcashHistoryFields
            historyMode={historyMode}
            restoreMethod={restoreMethod}
            syncDate={syncDate}
            syncHeight={syncHeight}
            onHistoryModeChange={selectHistoryMode}
            onRestoreMethodChange={selectRestoreMethod}
            onSyncDateChange={value => {
              setSyncDate(value)
              selectRestoreMethod('date')
            }}
            onSyncHeightChange={value => {
              resetPendingContinue()
              setSyncHeight(value)
            }}
          />
        </fieldset>

        <DialogFooter className="grid-flow-row px-5 pb-5 pt-2">
          {error && (
            <InlineError
              message={error}
              onRetry={error && retryable ? () => void handleContinue() : undefined}
              retrying={isImporting}
              className="mb-3"
            />
          )}
          <Button onClick={handleContinue} disabled={isImporting} isLoading={isImporting}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
