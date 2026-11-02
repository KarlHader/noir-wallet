import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { toast } from '@/store/toast-store'
import { Input } from '../ui/input'

export function InlineEditableName({
  value,
  kind,
  onSave,
  onEditingChange,
  className,
  disabled = false
}: {
  value: string
  kind: 'wallet' | 'account'
  onSave: (name: string) => Promise<void>
  onEditingChange?: (editing: boolean) => void
  className?: string
  disabled?: boolean
}) {
  const [displayName, setDisplayName] = useState(value)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editingRef = useRef(false)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const errorId = useId()
  const label = kind === 'wallet' ? 'Wallet name' : 'Account name'

  useEffect(() => setDisplayName(value), [value])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const finishEditing = () => {
    editingRef.current = false
    setEditing(false)
    onEditingChange?.(false)
    setError(null)
  }

  const save = async () => {
    if (!editingRef.current || savingRef.current) return
    const name = draft.trim()
    if (!name) {
      setError(`Enter ${kind === 'wallet' ? 'a wallet' : 'an account'} name`)
      return
    }
    if (name === displayName) {
      finishEditing()
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave(name)
      setDisplayName(name)
      finishEditing()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : `Unable to rename ${kind}`
      if (mountedRef.current) setError(message)
      else toast.error(message)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div
      className={cn('group/name pointer-events-auto min-w-0 max-w-full', className)}
      onClick={event => event.stopPropagation()}
    >
      {editing ? (
        <div className="relative min-w-0">
          <Input
            ref={inputRef}
            aria-label={label}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            value={draft}
            maxLength={128}
            disabled={saving}
            className="h-7 min-w-0 rounded px-1 py-0 text-sm font-medium pr-6"
            onChange={event => {
              setDraft(event.target.value)
              setError(null)
            }}
            onBlur={() => void save()}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                void save()
              } else if (event.key === 'Escape' && !savingRef.current) {
                event.preventDefault()
                finishEditing()
              }
            }}
          />
          {saving && (
            <Icon
              icon="lucide:loader-2"
              aria-label="Saving name"
              className="absolute right-1 top-1.5 animate-spin text-muted"
              width={16}
              height={16}
            />
          )}
          {error && (
            <p id={errorId} role="alert" className="mt-1 text-xs font-normal text-danger">
              {error}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Rename ${kind} ${displayName}`}
          disabled={disabled}
          onClick={() => {
            setDraft(displayName)
            setError(null)
            editingRef.current = true
            setEditing(true)
            onEditingChange?.(true)
          }}
          className="flex max-w-full min-w-0 items-center gap-1.5 rounded text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed"
        >
          <span className="truncate">{displayName}</span>
          <Icon
            icon="lucide:pencil"
            width={12}
            height={12}
            className="shrink-0 opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-within/name:opacity-100"
          />
        </button>
      )}
    </div>
  )
}
