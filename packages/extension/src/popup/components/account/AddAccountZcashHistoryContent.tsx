import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { DialogHeader, DialogTitle } from '../ui/dialog'
import { InlineError } from '../common/InlineError'
import {
  ZcashHistoryFields,
  type ZcashHistoryMode,
  type ZcashRestoreMethod
} from '../common/ZcashHistoryFields'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getFullZcashRecoveryBirthdayHeight } from '@/core/wallet/birthday-height'
import { classifyError } from '@/lib/errors'
import { LatestAttempt } from '@/lib/async-utils'
import dayjs from '@/lib/dayjs'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import {
  parseZcashHistoryRecoveryHeight,
  resolveZcashHistoryRecoveryDate
} from '@/popup/services/import-zcash-history-selection'

export type AddAccountZcashHistorySelection =
  | { readonly mode: 'new' }
  | { readonly mode: 'restore'; readonly birthdayHeight: number }

interface AddAccountZcashHistoryContentProps {
  readonly priorUsageDetected: boolean
  readonly onConfirm: (selection: AddAccountZcashHistorySelection) => void
}

class ZcashAccountHistoryValidationError extends Error {}

export function AddAccountZcashHistoryContent({
  priorUsageDetected,
  onConfirm
}: AddAccountZcashHistoryContentProps) {
  const fullRecoveryHeight = getFullZcashRecoveryBirthdayHeight(DEFAULT_NETWORK)
  const [historyMode, setHistoryMode] = useState<ZcashHistoryMode | null>(
    priorUsageDetected ? 'restore' : null
  )
  const [restoreMethod, setRestoreMethod] = useState<ZcashRestoreMethod>('date')
  const [syncDate, setSyncDate] = useState<dayjs.Dayjs | null>(null)
  const [syncHeight, setSyncHeight] = useState('')
  const [isResolving, setIsResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const continueAttempts = useRef(new LatestAttempt())

  useEffect(() => {
    const attempts = continueAttempts.current
    return () => attempts.invalidate()
  }, [])

  const resetPendingContinue = () => {
    continueAttempts.current.invalidate()
    setIsResolving(false)
    setError(null)
  }

  const resolveBirthdayHeight = async (): Promise<number> => {
    if (restoreMethod === 'height') {
      const parsed = parseZcashHistoryRecoveryHeight(syncHeight, fullRecoveryHeight)
      if (parsed.height === null) {
        throw new ZcashAccountHistoryValidationError(
          parsed.error === 'format'
            ? 'Enter a valid Zcash block height.'
            : `Block height must be ${fullRecoveryHeight.toLocaleString()} or later.`
        )
      }
      return parsed.height
    }

    if (!syncDate) {
      throw new ZcashAccountHistoryValidationError(
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
    if (!priorUsageDetected && historyMode === 'new') {
      onConfirm({ mode: 'new' })
      return
    }
    if (historyMode !== 'restore') {
      setError('Choose whether this Zcash account has received ZEC before.')
      return
    }

    setIsResolving(true)
    try {
      const birthdayHeight = await resolveBirthdayHeight()
      if (continueAttempts.current.isCurrent(attempt)) {
        onConfirm({ mode: 'restore', birthdayHeight })
      }
    } catch (cause) {
      if (continueAttempts.current.isCurrent(attempt)) {
        setError(
          cause instanceof ZcashAccountHistoryValidationError
            ? cause.message
            : classifyError(cause).userMessage
        )
      }
    } finally {
      if (continueAttempts.current.isCurrent(attempt)) setIsResolving(false)
    }
  }

  return (
    <>
      <DialogHeader className="px-5 pb-4 pt-5">
        <DialogTitle className="sr-only">Zcash account history</DialogTitle>
        <p className="pr-8 text-sm text-muted-foreground">
          {priorUsageDetected
            ? 'When should recovery begin for this Zcash account?'
            : 'Has this account received ZEC before?'}
        </p>
      </DialogHeader>

      <fieldset disabled={isResolving} className="min-h-0 min-w-0 overflow-y-auto px-5 pb-4">
        <ZcashHistoryFields
          historyMode={historyMode}
          restoreMethod={restoreMethod}
          syncDate={syncDate}
          syncHeight={syncHeight}
          requireRestore={priorUsageDetected}
          onHistoryModeChange={mode => {
            resetPendingContinue()
            setHistoryMode(mode)
          }}
          onRestoreMethodChange={method => {
            resetPendingContinue()
            setRestoreMethod(method)
          }}
          onSyncDateChange={date => {
            resetPendingContinue()
            setSyncDate(date)
          }}
          onSyncHeightChange={height => {
            resetPendingContinue()
            setSyncHeight(height)
          }}
        />
      </fieldset>

      <div className="px-5 pb-5 pt-2">
        {error && <InlineError message={error} className="mb-3" />}
        <Button
          onClick={() => void handleContinue()}
          disabled={historyMode === null || isResolving}
          isLoading={isResolving}
          className="h-[45px] w-full"
        >
          Continue
        </Button>
      </div>
    </>
  )
}
