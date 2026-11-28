/**
 * Small widgets reused across the extension demo: page header, token icon, bottom sheet, token
 * picker sheet, buttons and info rows.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  type Domain,
  type Holdings,
  type Place,
  type Pos,
  type TokenId,
  CHAINS,
  PLACES,
  TOKENS,
  amountText,
  avatarUrl,
  split,
  usd
} from './data'
import { MASK, cleanAmount, qrCells, trimNumber } from './format'
import { XIcon, type IconName } from './icons'

/**
 * Account avatar: the pixel avatar set on the official CDN; if it fails to load, falls back to an
 * outlined person icon (the extension does the same).
 */
export function Avatar({
  n,
  size = 32,
  className = ''
}: {
  n: number
  size?: number
  className?: string
}) {
  const src = avatarUrl(n)
  const [failed, setFailed] = useState<string | null>(null)
  if (failed === src) {
    return (
      <span className={`xd-avatar-fallback ${className}`} style={{ width: size, height: size }}>
        <XIcon name="user" />
      </span>
    )
  }
  return (
    <img
      className={`xd-avatar-img ${className}`}
      src={src}
      width={size}
      height={size}
      alt=""
      referrerPolicy="no-referrer"
      decoding="async"
      onError={() => setFailed(src)}
    />
  )
}

export function Toggle({
  on,
  onChange,
  label
}: {
  on: boolean
  onChange: (on: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`xd-switch${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  )
}

export function TokenIcon({
  token,
  place,
  size = 32
}: {
  token: TokenId
  place?: Place
  size?: number
}) {
  return (
    <span className="xd-coin" style={{ width: size, height: size }}>
      <img src={TOKENS[token].icon} alt="" />
      {place && <img className="xd-coin-chain" src={PLACES[place].icon} alt="" />}
    </span>
  )
}

export function IconButton({
  icon,
  label,
  onClick,
  className = ''
}: {
  icon: IconName
  label: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      className={`xd-iconbtn ${className}`}
      aria-label={label}
      onClick={onClick}
    >
      <XIcon name={icon} />
    </button>
  )
}

export function PageHead({
  title,
  onBack,
  right,
  backIcon = 'back'
}: {
  title: ReactNode
  onBack: () => void
  right?: ReactNode
  backIcon?: 'back' | 'close'
}) {
  return (
    <header className="xd-pagehead">
      <IconButton
        icon={backIcon}
        label={backIcon === 'close' ? 'Close' : 'Back'}
        onClick={onBack}
      />
      <h3>{title}</h3>
      {right ?? <span className="xd-iconbtn is-empty" />}
    </header>
  )
}

export function Primary({
  children,
  onClick,
  disabled = false,
  busy = false,
  tone = 'green'
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  tone?: 'green' | 'amber' | 'ghost' | 'outline' | 'danger'
}) {
  return (
    <button
      type="button"
      className={`xd-primary tone-${tone}${busy ? ' is-busy' : ''}`}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy && <XIcon name="spinner" className="xd-spin" />}
      {children}
    </button>
  )
}

/**
 * Bottom sheet: covers the current page with a blurred backdrop. Takes focus when opened; Esc
 * closes it first instead of going back a page.
 */
export function Sheet({
  title,
  onBack,
  onClose,
  children,
  className = ''
}: {
  title?: ReactNode
  onBack?: () => void
  onClose?: () => void
  children: ReactNode
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const dismiss = onClose ?? onBack
  useEffect(() => {
    const node = box.current
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true })
  }, [])
  return (
    <div
      className="xd-sheet-layer"
      onKeyDown={event => {
        if (event.key !== 'Escape' || !dismiss) return
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }}
    >
      <button
        type="button"
        className="xd-scrim"
        aria-label="Close"
        onClick={dismiss}
        tabIndex={-1}
      />
      <div
        ref={box}
        tabIndex={-1}
        className={`xd-sheet ${className}`}
        role="dialog"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        {title !== undefined && (
          <div className="xd-sheet-head">
            {onBack ? (
              <IconButton icon="back" label="Back" onClick={onBack} />
            ) : (
              <span className="xd-iconbtn is-empty" />
            )}
            <h4>{title}</h4>
            {onClose ? (
              <IconButton icon="close" label="Close" onClick={onClose} />
            ) : (
              <span className="xd-iconbtn is-empty" />
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export function SearchField({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <label className="xd-search">
      <XIcon name="search" />
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  )
}

/** Token picker sheet. The Public / Incognito lists can be filtered by chain. */
export function TokenSheet({
  domain,
  holdings,
  choices,
  title = 'Select Token',
  hidden,
  onPick,
  onBack,
  empty
}: {
  domain: Domain
  holdings: Holdings
  choices: Pos[]
  title?: string
  hidden: boolean
  onPick: (key: Pos) => void
  onBack: () => void
  empty?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const [chain, setChain] = useState<Place | 'all'>('all')
  const chains =
    domain === 'shield' ? [] : CHAINS.filter(place => choices.some(key => split(key)[1] === place))
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return choices
      .filter(key => {
        const [token, place] = split(key)
        if (chain !== 'all' && place !== chain) return false
        if (!q) return true
        return `${token} ${TOKENS[token].name} ${PLACES[place].name}`.toLowerCase().includes(q)
      })
      .map(key => ({ key, amount: holdings[domain][key] ?? 0 }))
      .sort(
        (a, b) =>
          b.amount * TOKENS[split(b.key)[0]].price - a.amount * TOKENS[split(a.key)[0]].price
      )
  }, [choices, chain, query, holdings, domain])

  return (
    <Sheet title={title} onBack={onBack}>
      <div className="xd-sheet-body">
        <SearchField value={query} onChange={setQuery} placeholder="Search tokens" />
        {chains.length > 1 && (
          <div className="xd-chainchips" role="group" aria-label="Filter by network">
            <button
              type="button"
              className={chain === 'all' ? 'on' : ''}
              onClick={() => setChain('all')}
            >
              All
            </button>
            {chains.map(place => (
              <button
                key={place}
                type="button"
                className={chain === place ? 'on' : ''}
                aria-label={PLACES[place].name}
                onClick={() => setChain(place)}
              >
                <img src={PLACES[place].icon} alt="" />
              </button>
            ))}
          </div>
        )}
        {rows.length === 0 && (empty ?? <p className="xd-empty">No tokens found</p>)}
        <ul className="xd-picklist">
          {rows.map(({ key, amount }) => {
            const [token, place] = split(key)
            return (
              <li key={key}>
                <button type="button" onClick={() => onPick(key)}>
                  <TokenIcon token={token} place={place} />
                  <span className="xd-pick-main">
                    <b>{token}</b>
                    <small>{PLACES[place].name}</small>
                  </span>
                  <span className="xd-pick-side">
                    <b>{hidden ? MASK : amountText(amount, token)}</b>
                    <small>{hidden ? MASK : usd(amount * TOKENS[token].price)}</small>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </Sheet>
  )
}

/** From / To card: icon + direction + account + tag, with the address on a line below. */
export function PartyCard({
  dir,
  account,
  tag,
  tone = 'plain',
  address,
  icon,
  img,
  children,
  onClick
}: {
  dir: 'From' | 'To'
  account: string
  tag?: string
  tone?: 'plain' | 'gold' | 'green'
  address: ReactNode
  icon?: IconName
  img?: string
  children?: ReactNode
  onClick?: () => void
}) {
  const body = (
    <>
      <span className={`xd-party-icon${img ? ' is-img' : ''}`}>
        {img ? <img src={img} alt="" /> : <XIcon name={icon ?? 'wallet'} />}
      </span>
      <span className="xd-party-main">
        <span className="xd-party-top">
          <span>{dir}</span>
          <span>{account}</span>
          {tag && <span className={`xd-tag tone-${tone}`}>{tag}</span>}
        </span>
        <span className="xd-party-addr">{address}</span>
      </span>
      {onClick && <XIcon name="down" className="xd-party-chev" />}
    </>
  )
  return (
    <div className="xd-party">
      {onClick ? (
        <button type="button" className="xd-party-row" onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className="xd-party-row">{body}</div>
      )}
      {children}
    </div>
  )
}

export function Rows({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="xd-rows">
      {rows.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Large amount input, with the token button and balance / Max below it. */
export function AmountField({
  value,
  onChange,
  token,
  place,
  balance,
  hidden,
  onToken,
  label
}: {
  value: string
  onChange: (value: string) => void
  token: TokenId
  place: Place
  balance: number
  hidden: boolean
  onToken: () => void
  label: string
}) {
  const typed = Number(value) || 0
  return (
    <div className="xd-amount">
      <input
        className={value.length > 9 ? 'is-long' : ''}
        inputMode="decimal"
        placeholder="0"
        value={value}
        aria-label={label}
        onChange={event => onChange(cleanAmount(event.target.value))}
      />
      <span className="xd-amount-usd">≈ {usd(typed * TOKENS[token].price)}</span>
      <button
        type="button"
        className="xd-tokpill"
        onClick={onToken}
        aria-label={`Select token, current: ${token}`}
      >
        <TokenIcon token={token} place={place} size={26} />
        <span>{token}</span>
        <XIcon name="down" />
      </button>
      <span className="xd-amount-bal">
        <span>{hidden ? MASK : amountText(balance, token)}</span>
        <button type="button" onClick={() => onChange(trimNumber(balance, TOKENS[token].digits))}>
          Max
        </button>
      </span>
    </div>
  )
}

/**
 * Decorative QR code pattern: it has finder corners, but the dots in the middle are random, so it
 * never scans to an address.
 */
export function FakeQR({ seed, size = 168 }: { seed: string; size?: number }) {
  const cells = useMemo(() => qrCells(seed), [seed])
  const eye = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width="6"
        height="6"
        rx="1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect x={x + 2} y={y + 2} width="3" height="3" rx=".8" fill="currentColor" />
    </g>
  )
  return (
    <svg className="xd-qr" viewBox="-1 -1 27 27" width={size} height={size} aria-hidden="true">
      <rect x="-1" y="-1" width="27" height="27" rx="2" fill="#fff" />
      <g fill="currentColor">
        {cells.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x + 0.08} y={y + 0.08} width=".84" height=".84" rx=".22" />
        ))}
      </g>
      {eye(0, 0)}
      {eye(18, 0)}
      {eye(0, 18)}
    </svg>
  )
}
