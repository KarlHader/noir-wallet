import { useEffect, useRef, useState } from 'react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { DatePicker } from '../ui/date-picker'
import { lookupBlockHeightByTime } from '@/core/zcash/date-block-lookup'
import { getUtcDayStartTimestamp } from '@/lib/zcash-birthday'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import dayjs from '@/lib/dayjs'

type SyncType = 'height' | 'date'

interface SyncOptionsModalProps {
  onConfirm: (height?: number) => void
  initialHeight?: number
}

export function SyncOptionsModal({ onConfirm, initialHeight }: SyncOptionsModalProps) {
  const [syncType, setSyncType] = useState<SyncType>('date')
  const [syncDate, setSyncDate] = useState<dayjs.Dayjs | null>(dayjs().startOf('day'))
  const [syncHeight, setSyncHeight] = useState(initialHeight ? initialHeight.toString() : '')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeRequest = useRef<AbortController | null>(null)

  useEffect(() => () => activeRequest.current?.abort(), [])

  const cancelLookup = () => {
    activeRequest.current?.abort()
    activeRequest.current = null
    setIsLoading(false)
  }

  const handleConfirm = async () => {
    cancelLookup()
    setError(null)
    setIsLoading(true)
    const controller = new AbortController()
    activeRequest.current = controller
    try {
      let height: number | undefined

      if (syncType === 'height') {
        const parsed = parseInt(syncHeight.replace(/,/g, ''), 10)
        height = isNaN(parsed) || parsed < 0 ? undefined : parsed
      } else {
        if (!syncDate) {
          height = undefined
        } else {
          const timestamp = getUtcDayStartTimestamp(syncDate)
          height = await lookupBlockHeightByTime(timestamp, DEFAULT_NETWORK, {
            signal: controller.signal
          })
        }
      }

      if (activeRequest.current === controller && !controller.signal.aborted) onConfirm(height)
    } catch (err) {
      if (activeRequest.current === controller && !controller.signal.aborted) {
        console.error('Failed to get block height:', err)
        setError('Failed to fetch block height for this date. Please check your connection.')
      }
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null
        setIsLoading(false)
      }
    }
  }

  return (
    <div className="space-y-6 pt-4">
      <div className="flex gap-4 border-b border-border/50 pb-2">
        <button
          className={`text-sm font-medium pb-2 -mb-2.5 transition-colors ${
            syncType === 'date'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted hover:text-text'
          }`}
          onClick={() => {
            cancelLookup()
            setSyncType('date')
            setError(null)
          }}
        >
          Registration Date
        </button>
        <button
          className={`text-sm font-medium pb-2 -mb-2.5 transition-colors ${
            syncType === 'height'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted hover:text-text'
          }`}
          onClick={() => {
            cancelLookup()
            setSyncType('height')
            setError(null)
          }}
        >
          Birthday Height
        </button>
      </div>

      {syncType === 'date' ? (
        <div className="space-y-2">
          <DatePicker
            value={syncDate}
            onChange={value => {
              cancelLookup()
              setSyncDate(value)
            }}
            ariaLabel="Wallet creation date"
            minDate={dayjs(DEFAULT_NETWORK === 'mainnet' ? '2018-10-01' : '2018-01-01')}
            placeholder="Select wallet creation date"
          />
          <p className="text-xs text-muted">
            Approximate date when this wallet was first created. Defaults to today; choose an
            earlier date if the wallet is older.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            type="number"
            value={syncHeight}
            onChange={e => {
              cancelLookup()
              setSyncHeight(e.target.value)
            }}
            placeholder="e.g. 1000000"
            className="w-full h-[45px]"
          />
          <p className="text-xs text-muted">The block height when this wallet was created.</p>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end gap-3 pt-2">
        <Button className="w-full" onClick={handleConfirm} isLoading={isLoading} size="lg">
          Confirm
        </Button>
      </div>
    </div>
  )
}
