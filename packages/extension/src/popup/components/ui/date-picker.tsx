import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import dayjs from '@/lib/dayjs'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Button } from './button'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

interface DatePickerProps {
  value: dayjs.Dayjs | null
  onChange: (value: dayjs.Dayjs) => void
  ariaLabel?: string
  maxDate?: dayjs.Dayjs
  minDate?: dayjs.Dayjs
  className?: string
  placeholder?: string
}

export function DatePicker({
  value,
  onChange,
  ariaLabel = 'Date',
  maxDate,
  minDate,
  className,
  placeholder = 'Select date'
}: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(() => (value ?? dayjs()).startOf('month'))
  const effectiveMax = (maxDate ?? dayjs()).endOf('day')
  const effectiveMin = (minDate ?? dayjs('2018-10-01')).startOf('day')

  useEffect(() => {
    if (value) setViewMonth(value.startOf('month'))
  }, [value])

  const days = useMemo(() => {
    const gridStart = viewMonth.startOf('month').startOf('week')
    return Array.from({ length: 42 }, (_, index) => gridStart.add(index, 'day'))
  }, [viewMonth])

  const isDisabled = (date: dayjs.Dayjs) =>
    date.isBefore(effectiveMin, 'day') || date.isAfter(effectiveMax, 'day')
  const previousMonth = viewMonth.subtract(1, 'month')
  const nextMonth = viewMonth.add(1, 'month')
  const canGoPrevious = previousMonth.endOf('month').isSameOrAfter(effectiveMin, 'day')
  const canGoNext = nextMonth.startOf('month').isSameOrBefore(effectiveMax, 'day')

  const handleSelect = (date: dayjs.Dayjs) => {
    if (isDisabled(date)) return
    onChange(date.startOf('day'))
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'flex items-center justify-between w-full h-[46px] px-4 rounded-xl border border-input bg-transparent text-sm transition-colors',
            'hover:border-ring focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none',
            !value && 'text-muted-foreground/50',
            className
          )}
        >
          <span>{value ? value.format('MMM D, YYYY') : placeholder}</span>
          <Icon icon="lucide:calendar" width={16} height={16} className="text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="z-[60] w-[280px] p-3" align="start">
        <div className="mb-2 flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous month"
            title="Previous month"
            onClick={() => canGoPrevious && setViewMonth(previousMonth)}
            disabled={!canGoPrevious}
          >
            <Icon icon="lucide:chevron-left" width={16} height={16} />
          </Button>
          <span className="text-sm font-semibold">{viewMonth.format('MMMM YYYY')}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next month"
            title="Next month"
            onClick={() => canGoNext && setViewMonth(nextMonth)}
            disabled={!canGoNext}
          >
            <Icon icon="lucide:chevron-right" width={16} height={16} />
          </Button>
        </div>
        <div className="mb-1 grid grid-cols-7" aria-hidden="true">
          {WEEKDAYS.map(day => (
            <span key={day} className="flex h-7 items-center justify-center text-[11px] text-muted">
              {day}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5">
          {days.map(date => {
            const disabled = isDisabled(date)
            const selected = value?.isSame(date, 'day') ?? false
            const outsideMonth = !date.isSame(viewMonth, 'month')

            return (
              <button
                type="button"
                key={date.format('YYYY-MM-DD')}
                aria-label={date.format('MMMM D, YYYY')}
                aria-current={date.isSame(dayjs(), 'day') ? 'date' : undefined}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => handleSelect(date)}
                className={cn(
                  'h-8 w-8 rounded-md text-xs transition-colors',
                  disabled && 'cursor-not-allowed opacity-25',
                  outsideMonth && !selected && 'text-muted/40',
                  !disabled && !selected && 'cursor-pointer hover:bg-accent',
                  selected && 'bg-primary font-semibold text-primary-foreground'
                )}
              >
                {date.date()}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
