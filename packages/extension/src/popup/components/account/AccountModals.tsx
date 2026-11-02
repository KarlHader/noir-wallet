import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { DatePicker } from '../ui/date-picker'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import dayjs from '@/lib/dayjs'
import {
  formatBirthdayResyncHint,
  getBirthdayDateFromBlockTimestamp,
  getUtcDayStartTimestamp,
  type BirthdayHeightSource
} from '@/lib/zcash-birthday'
import { classifyError } from '@/lib/errors'

type ResyncEditMode = 'height' | 'date'

interface ResyncZcashContentProps {
  walletId: string
  accountId: string
  birthdayHeight: number
  onConfirm: (height: number) => Promise<void>
  close: () => void
}

export function ResyncZcashContent({
  walletId,
  accountId,
  birthdayHeight,
  onConfirm,
  close
}: ResyncZcashContentProps) {
  const [editMode, setEditMode] = useState<ResyncEditMode>('height')
  const [resolvedHeight, setResolvedHeight] = useState(birthdayHeight)
  const [editHeight, setEditHeight] = useState(birthdayHeight > 0 ? birthdayHeight.toString() : '')
  const [syncDate, setSyncDate] = useState<dayjs.Dayjs | null>(null)
  const [heightSource, setHeightSource] = useState<BirthdayHeightSource>('none')
  const [blockTimestamp, setBlockTimestamp] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      let height = birthdayHeight
      let source: BirthdayHeightSource = birthdayHeight > 0 ? 'stored' : 'none'

      if (height <= 0) {
        const resolved = await zcashWalletRuntimeClient.resolveBirthdayHeight(walletId, accountId)
        height = resolved.height
        source = resolved.source
      }

      if (cancelled) return

      if (height <= 0) {
        setResolvedHeight(0)
        setEditHeight('')
        setSyncDate(null)
        setHeightSource('none')
        setBlockTimestamp(null)
        return
      }

      setResolvedHeight(height)
      setEditHeight(height.toString())
      setHeightSource(source)

      if (source === 'fallback') {
        setSyncDate(null)
        setBlockTimestamp(null)
        return
      }

      try {
        const timestamp = await zcashWalletRuntimeClient.getBlockTime(height)
        if (cancelled) return
        setBlockTimestamp(timestamp)
        setSyncDate(getBirthdayDateFromBlockTimestamp(timestamp))
      } catch {
        if (!cancelled) {
          setSyncDate(null)
          setBlockTimestamp(null)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [walletId, accountId, birthdayHeight])

  const handleResync = async () => {
    setError(null)
    setIsLoading(true)

    try {
      let height: number

      if (editMode === 'date') {
        if (!syncDate) {
          height = resolvedHeight
        } else {
          const timestamp = getUtcDayStartTimestamp(syncDate)
          height = await zcashWalletRuntimeClient.getBlockByTime(timestamp)
        }
      } else {
        height = parseInt(editHeight, 10)
        if (isNaN(height) || height < 0) return
      }

      await onConfirm(height)
    } catch (e) {
      console.error('Resync failed:', e)
      setError(classifyError(e).userMessage)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
        <p className="text-xs text-yellow-500">
          This rebuilds local Zcash data for every account in this wallet. EVM and Bitcoin data are
          not changed. Use the earliest block/date any Zcash account may have funds; a too-recent
          start point can miss older balances.
        </p>
      </div>

      <div>
        <div className="flex gap-3 mb-3">
          <button
            className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
              editMode === 'height'
                ? 'bg-primary/15 text-primary'
                : 'bg-card text-muted hover:text-text'
            }`}
            onClick={() => {
              setEditMode('height')
              setError(null)
            }}
          >
            Birthday Height
          </button>
          <button
            className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
              editMode === 'date'
                ? 'bg-primary/15 text-primary'
                : 'bg-card text-muted hover:text-text'
            }`}
            onClick={() => {
              setEditMode('date')
              setError(null)
            }}
          >
            By Date
          </button>
        </div>

        {editMode === 'height' ? (
          <>
            <Input
              type="number"
              value={editHeight}
              onChange={e => setEditHeight(e.target.value)}
              placeholder="e.g. 1000000"
              className="h-[46px] rounded-xl"
            />
            <p className="text-xs text-muted mt-1.5">
              {formatBirthdayResyncHint(resolvedHeight, blockTimestamp, heightSource)}
            </p>
          </>
        ) : (
          <>
            <DatePicker
              value={syncDate}
              onChange={setSyncDate}
              ariaLabel="Wallet creation date"
              minDate={dayjs(DEFAULT_NETWORK === 'mainnet' ? '2018-10-01' : '2018-01-01')}
              placeholder="Select wallet creation date"
            />
            <p className="text-xs text-muted mt-1.5">
              Approximate date when this wallet was first created. The block height will be
              calculated automatically.
            </p>
          </>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-3 pt-1">
        <Button variant="outline" onClick={close} disabled={isLoading} className="flex-1 h-[45px]">
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={handleResync}
          isLoading={isLoading}
          disabled={editMode === 'height' && (!editHeight || parseInt(editHeight, 10) < 0)}
          className="flex-1 h-[45px]"
        >
          Resync
        </Button>
      </div>
    </div>
  )
}
