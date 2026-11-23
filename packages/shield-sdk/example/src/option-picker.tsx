import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface OptionPickerItem<T extends string> {
  readonly value: T
  readonly title: string
  readonly detail?: string
}

export function OptionPicker<T extends string>({
  options,
  value,
  placeholder,
  emptyLabel,
  searchPlaceholder,
  onSelect,
  searchable = false
}: {
  options: readonly OptionPickerItem<T>[]
  value: T
  placeholder: string
  emptyLabel: string
  searchPlaceholder?: string
  onSelect: (value: T) => void
  searchable?: boolean
}) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = options.find(option => option.value === value)
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!searchable || needle.length === 0) return options
    return options.filter(option =>
      [option.title, option.detail, option.value].join(' ').toLowerCase().includes(needle)
    )
  }, [options, query, searchable])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="token-picker" ref={rootRef}>
      <button
        className="input token-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() =>
          setOpen(current => {
            if (!current) setQuery('')
            return !current
          })
        }
      >
        {selected ? (
          <span className="token-selected">
            <strong>{selected.title}</strong>
            {selected.detail ? <span>{selected.detail}</span> : null}
          </span>
        ) : (
          <span className="token-placeholder">{placeholder}</span>
        )}
      </button>
      {open ? (
        <div className="token-panel">
          {searchable ? (
            <input
              ref={searchRef}
              className="input"
              value={query}
              placeholder={searchPlaceholder ?? 'Search'}
              aria-label={searchPlaceholder ?? 'Search options'}
              onChange={event => setQuery(event.target.value)}
            />
          ) : null}
          {visible.length === 0 ? (
            <p className="token-empty">{options.length === 0 ? emptyLabel : 'No matches.'}</p>
          ) : (
            <ul
              className={`token-list${searchable ? '' : ' token-list-plain'}`}
              id={listId}
              role="listbox"
            >
              {visible.map(option => {
                const active = option.value === value
                return (
                  <li key={option.value}>
                    <button
                      className="token-option"
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onSelect(option.value)
                        setOpen(false)
                      }}
                    >
                      <span className="token-symbol">{option.title}</span>
                      {option.detail ? <span className="token-chain">{option.detail}</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
