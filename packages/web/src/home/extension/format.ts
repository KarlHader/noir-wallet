/**
 * Formatting and conversion helpers shared across the extension demo. They live outside the
 * component files so hot reload does not trigger a full page refresh.
 */
import type { KeyboardEvent } from 'react'
import { type Activity, type Domain, PLACES, amountText, usd } from './data'
import type { Tx } from './model'

/** For small in-page dropdowns: Esc closes only the dropdown, not the page or the whole demo. */
export const closeOnEscape = (open: boolean, close: () => void) => (event: KeyboardEvent) => {
  if (!open || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  close()
}

export const MASK = '••••'

export const DOMAIN_LABEL: Record<Domain, string> = {
  shield: 'Shield',
  public: 'Public',
  incognito: 'Incognito'
}

export const money = (value: number, hidden: boolean) => (hidden ? `$${MASK}` : usd(value))

/** Activity amount as displayed: negative if it leaves this account, positive if it comes in. */
export function activityLine(item: Activity, domain: Domain) {
  const outgoing = item.kind === 'send' || (item.from === domain && item.to !== domain)
  if (item.kind === 'swap') return `+${amountText(item.toAmount, item.toToken)}`
  return `${outgoing ? '−' : '+'}${amountText(outgoing ? item.amount : item.toAmount, outgoing ? item.token : item.toToken)}`
}

/** Rebuilds an activity item into the shape the transaction details page needs. */
export function toTx(item: Activity): Tx {
  return {
    kind: item.kind,
    from: item.from,
    to: item.to,
    token: item.token,
    place: item.place,
    amount: item.amount,
    toToken: item.toToken,
    toPlace: item.toPlace,
    toAmount: item.toAmount,
    fee: item.fee,
    time: item.time ?? '—',
    provider:
      item.provider ??
      (PLACES[item.toPlace].provider ? PLACES[item.toPlace].name : PLACES[item.place].name),
    network: item.network ?? PLACES[item.place].name,
    fromLabel:
      item.fromLabel ??
      (item.kind === 'receive' ? item.peer : `Account 1 · ${DOMAIN_LABEL[item.from]}`),
    toLabel:
      item.toLabel ?? (item.kind === 'send' ? item.peer : `Account 1 · ${DOMAIN_LABEL[item.to]}`),
    route: item.route
  }
}

/** Amount input keeps only digits and a single decimal point. */
export function cleanAmount(raw: string) {
  const digits = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '')
  const [whole, ...rest] = digits.split('.')
  const joined = rest.length ? `${whole || '0'}.${rest.join('').slice(0, 8)}` : whole
  return joined.replace(/^0+(?=\d)/, '')
}

export const trimNumber = (value: number, digits: number) =>
  value.toFixed(digits).replace(/\.?0+$/, '') || '0'

/**
 * Dot grid for the decorative QR code: the three finder corners are left empty and the rest is
 * random, so it scans to nothing.
 */
export function qrCells(seed: string, n = 25) {
  let state = [...seed].reduce((acc, char) => (acc * 33 + char.charCodeAt(0)) >>> 0, 5381)
  const out: [number, number][] = []
  const finder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8)
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      state = (state * 1103515245 + 12345) >>> 0
      if (!finder(x, y) && state / 2 ** 32 > 0.52) out.push([x, y])
    }
  }
  return out
}
