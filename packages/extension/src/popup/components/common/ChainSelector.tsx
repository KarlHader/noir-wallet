import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { TokenSelectionSearch } from '../tokens/TokenSelectionList'
import { ChainIcon } from './ChainIcon'
import { PageHeader } from './PageHeader'

export interface ChainSelectorOption {
  readonly id: string
  readonly name: string
  readonly icon?: string
  readonly disabled?: boolean
  readonly note?: string
}

interface ChainSelectorProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly options: readonly ChainSelectorOption[]
  readonly selectedId?: string | null
  readonly onSelect: (id: string) => void | Promise<void>
  readonly title?: string
  readonly label?: string
  readonly loading?: boolean
  readonly error?: string
  readonly onRetry?: () => void
}

export function ChainSelector({
  open,
  onOpenChange,
  options,
  selectedId,
  onSelect,
  title = 'Select Network',
  label,
  loading = false,
  error,
  onRetry
}: ChainSelectorProps) {
  const [search, setSearch] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [selectionError, setSelectionError] = useState('')
  useEffect(() => {
    if (!open) {
      setSearch('')
      setSelectionError('')
    }
  }, [open])
  const filtered = options.filter(option =>
    option.name.toLowerCase().includes(search.trim().toLowerCase())
  )
  const busy = loading || pendingId !== null
  const select = async (id: string) => {
    if (busy) return
    setPendingId(id)
    setSelectionError('')
    try {
      await onSelect(id)
      onOpenChange(false)
    } catch {
      setSelectionError('Unable to switch network. Try again.')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => pendingId === null && onOpenChange(next)}>
      <DialogContent
        position="bottom"
        showCloseButton={false}
        className="inset-0 flex h-full max-h-none max-w-none flex-col gap-0 rounded-none border-0 bg-background p-0 shadow-none"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">Choose a network</DialogDescription>
        <PageHeader
          title={title}
          showBack
          backDisabled={pendingId !== null}
          onBack={() => onOpenChange(false)}
        />
        <div className="shrink-0 px-4 pt-1 pb-2">
          <TokenSelectionSearch
            value={search}
            onChange={setSearch}
            placeholder="Search network"
            ariaLabel="Search networks"
            className="h-[45px] rounded-xl border-white/5 bg-card"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
          {label && <p className="px-4 pt-2 pb-1 text-xs text-muted">{label}</p>}
          <div role="radiogroup" aria-label={title}>
            {filtered.map(option => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selectedId === option.id}
                disabled={busy || option.disabled}
                onClick={() => void select(option.id)}
                className={cn(
                  'wallet-interactive flex min-h-[72px] w-full items-center gap-3 px-4 py-4 text-left text-sm hover:bg-wallet-selected active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45',
                  selectedId === option.id && 'bg-wallet-selected'
                )}
              >
                {option.icon ? (
                  <ChainIcon
                    chain={option.icon}
                    width={32}
                    height={32}
                    showTooltip={false}
                    aria-hidden="true"
                    className="shrink-0"
                  />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-card text-muted">
                    <Icon icon="lucide:network" width={22} height={22} aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {option.note && <span className="text-xs text-muted">{option.note}</span>}
                {pendingId === option.id && (
                  <Icon
                    icon="lucide:loader-circle"
                    className="size-4 animate-spin"
                    aria-label="Switching network"
                  />
                )}
              </button>
            ))}
          </div>
          {loading && (
            <p role="status" className="px-4 py-6 text-sm text-muted">
              Loading networks…
            </p>
          )}
          {!loading && filtered.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted">No networks found</p>
          )}
          {(error || selectionError) && (
            <div className="px-4 py-3 text-sm">
              <p role="alert" className="text-destructive">
                {error || selectionError}
              </p>
              {onRetry && (
                <button type="button" onClick={onRetry} className="mt-2 text-primary">
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
