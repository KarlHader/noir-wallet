/**
 * The extension demo's flow pages: send, receive, Shield / Unshield, Incognito deposit and
 * withdraw, Swap, plus the review page, transaction result, token details and provider details.
 * Every "transaction" only changes the balances in the demo: nothing is signed, broadcast or
 * sent over the network. Addresses come from the current account (truncated form only).
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode } from 'react'
import {
  type Domain,
  type Place,
  type Pos,
  type Recipient,
  type TokenId,
  CATALOG,
  CHAINS,
  EVM_ICONS,
  PLACES,
  PROVIDER_COPY,
  SHIELDABLE,
  TOKENS,
  addressFor,
  amountText,
  changeText,
  pos,
  priceSeries,
  priceText,
  split,
  usd
} from './data'
import { DOMAIN_LABEL, MASK, activityLine, closeOnEscape, money, toTx } from './format'
import { XIcon, type IconName } from './icons'
import type { Action, MoveKind, Tx, View } from './model'
import {
  AmountField,
  FakeQR,
  IconButton,
  PageHead,
  PartyCard,
  Primary,
  Rows,
  SearchField,
  Sheet,
  TokenIcon,
  TokenSheet
} from './ui'

type Base = { state: View; dispatch: Dispatch<Action> }

/** Demo fee and arrival time for each chain / provider. */
const NET: Record<Place, { fee: string; time: string }> = {
  ethereum: { fee: '$0.42', time: '~15s' },
  base: { fee: '$0.01', time: '~4s' },
  bnb: { fee: '$0.03', time: '~5s' },
  arbitrum: { fee: '$0.02', time: '~2s' },
  zcash: { fee: '0.00015 ZEC', time: '~2 min' },
  near: { fee: '$0.12', time: '~20s' },
  zshield: { fee: '0.00015 ZEC', time: '~2 min' }
}

const shortAddr = (text: string) => {
  const clean = text.trim()
  return clean.length > 14 ? `${clean.slice(0, 6)}…${clean.slice(-4)}` : clean
}

const balanceOf = (state: View, domain: Domain, key: Pos) => state.holdings[domain][key] ?? 0

const funded = (state: View, domain: Domain, keys: Pos[] = CATALOG[domain]) =>
  keys.filter(key => balanceOf(state, domain, key) > 0)

/** Title dropdown for switching the source account (Shield Send ▾ / Public Swap ▾). */
function DomainTitle({
  verb,
  domain,
  options,
  onChange
}: {
  verb: string
  domain: Domain
  options: Domain[]
  onChange: (domain: Domain) => void
}) {
  const [open, setOpen] = useState(false)
  if (options.length < 2) return <>{`${DOMAIN_LABEL[domain]} ${verb}`}</>
  return (
    <span className="xd-titlepick" onKeyDown={closeOnEscape(open, () => setOpen(false))}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {DOMAIN_LABEL[domain]} {verb}
        <XIcon name="down" />
      </button>
      {open && (
        <span className="xd-pop" role="menu">
          {options.map(item => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={item === domain}
              onClick={() => {
                setOpen(false)
                onChange(item)
              }}
            >
              {DOMAIN_LABEL[item]} {verb}
              {item === domain && <XIcon name="check" />}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

function PrivacyNote({
  tone,
  icon,
  children
}: {
  tone: 'green' | 'gold' | 'plain'
  icon: IconName
  children: ReactNode
}) {
  return (
    <p className={`xd-note tone-${tone}`}>
      <XIcon name={icon} />
      <span>{children}</span>
    </p>
  )
}

/* ====================== Send ====================== */

export function SendFlow({ state, dispatch, start, token }: Base & { start: Domain; token?: Pos }) {
  const ACCOUNT = state.account.name
  const [domain, setDomain] = useState<Domain>(start === 'incognito' ? 'public' : start)
  const [key, setKey] = useState<Pos | null>(
    token && balanceOf(state, domain, token) > 0 ? token : null
  )
  const [sheet, setSheet] = useState<'token' | 'recipient' | null>(key ? null : 'token')
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState<Recipient | null>(null)
  const [typed, setTyped] = useState('')

  const choices = funded(state, domain)
  const back = () => dispatch({ type: 'back' })

  if (!key) {
    return (
      <div className="xd-page">
        <PageHead
          title={
            <DomainTitle
              verb="Send"
              domain={domain}
              options={['shield', 'public']}
              onChange={setDomain}
            />
          }
          onBack={back}
        />
        <TokenSheet
          domain={domain}
          holdings={state.holdings}
          choices={choices}
          hidden={state.hidden}
          onPick={picked => {
            setKey(picked)
            setSheet(null)
          }}
          onBack={back}
          empty={<p className="xd-empty">No assets found</p>}
        />
      </div>
    )
  }

  const [sym, place] = split(key)
  const balance = balanceOf(state, domain, key)
  const value = Number(amount) || 0
  const kind: Recipient['kind'] = sym === 'ZEC' ? 'zcash' : 'evm'
  const toAddress = recipient?.addr ?? (typed.trim().length >= 8 ? shortAddr(typed) : '')
  const over = value > balance + 1e-9
  const ready = value > 0 && !over && toAddress !== ''
  const shielded = domain === 'shield'
  const net = NET[place]

  const review = () => {
    const tx: Tx = {
      kind: 'send',
      from: domain,
      to: domain,
      token: sym,
      place,
      amount: value,
      toToken: sym,
      toPlace: place,
      toAmount: value,
      fee: net.fee,
      time: net.time,
      provider: PLACES[place].provider ? PLACES[place].name : '—',
      network: place === 'zshield' ? 'Zcash' : PLACES[place].name,
      fromLabel: `${ACCOUNT} · ${DOMAIN_LABEL[domain]}`,
      toLabel: recipient ? `${recipient.name} · ${recipient.addr}` : toAddress
    }
    dispatch({ type: 'push', screen: { id: 'review', tx } })
  }

  return (
    <div className="xd-page">
      <PageHead
        title={
          <DomainTitle
            verb="Send"
            domain={domain}
            options={['shield', 'public']}
            onChange={next => {
              setDomain(next)
              setKey(null)
              setAmount('')
              setSheet('token')
            }}
          />
        }
        onBack={back}
        right={
          <IconButton
            icon="sliders"
            label="Send settings"
            onClick={() =>
              dispatch({ type: 'toast', text: 'Fee speed is fixed to Standard in this demo.' })
            }
          />
        }
      />
      <div className="xd-page-body">
        <AmountField
          value={amount}
          onChange={setAmount}
          token={sym}
          place={place}
          balance={balance}
          hidden={state.hidden}
          onToken={() => setSheet('token')}
          label={`${sym} amount`}
        />
        <PartyCard
          dir="From"
          account={ACCOUNT}
          tag={DOMAIN_LABEL[domain]}
          tone={shielded ? 'green' : 'plain'}
          img={shielded ? PLACES[place].icon : undefined}
          address={shielded ? PLACES[place].name : addressFor(state.account.id, 'public')}
        />
        <div className="xd-party xd-recipient">
          {recipient ? (
            <button type="button" className="xd-party-row" onClick={() => setSheet('recipient')}>
              <span className="xd-party-icon">
                <XIcon name="book" />
              </span>
              <span className="xd-party-main">
                <span className="xd-party-top">
                  <span>To</span>
                  <span>{recipient.name}</span>
                </span>
                <span className="xd-party-addr">{recipient.addr}</span>
              </span>
              <XIcon name="down" className="xd-party-chev" />
            </button>
          ) : (
            <div className="xd-party-row">
              <span className="xd-party-icon">
                <XIcon name="send" />
              </span>
              <label className="xd-party-main">
                <span className="xd-party-top">
                  <span>To</span>
                </span>
                <input
                  className="xd-addr-input"
                  value={typed}
                  onChange={event => setTyped(event.target.value)}
                  placeholder={
                    kind === 'zcash' ? 'Shielded or unified address' : 'Recipient address'
                  }
                  aria-label="Recipient address"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <IconButton
                icon="book"
                label="Select Recipient"
                onClick={() => setSheet('recipient')}
              />
            </div>
          )}
        </div>
        <Rows
          rows={[
            [shielded ? 'Provider' : 'Network', <ProviderValue key="provider" place={place} />],
            ['Network fee', `≈ ${net.fee}`],
            ['Est. time', net.time]
          ]}
        />
        {shielded ? (
          <PrivacyNote tone="green" icon="shieldCheck">
            Sent from your Shield balance. The amount and recipient stay out of public view.
          </PrivacyNote>
        ) : (
          <PrivacyNote tone="plain" icon="eye">
            Public transfer. It is visible on-chain and links back to your public address.
          </PrivacyNote>
        )}
      </div>
      <div className="xd-page-foot">
        <Primary disabled={!ready} onClick={review}>
          {over ? 'Insufficient balance' : 'Review'}
        </Primary>
      </div>

      {sheet === 'token' && (
        <TokenSheet
          domain={domain}
          holdings={state.holdings}
          choices={choices}
          hidden={state.hidden}
          onPick={picked => {
            setKey(picked)
            setRecipient(null)
            setSheet(null)
          }}
          onBack={() => setSheet(null)}
        />
      )}
      {sheet === 'recipient' && (
        <Sheet title="Select Recipient" onBack={() => setSheet(null)}>
          <div className="xd-sheet-body">
            <p className="xd-sheet-caption">Saved recipients</p>
            <ul className="xd-picklist">
              {state.contacts
                .filter(item => item.kind === kind)
                .map(item => (
                  <li key={item.addr}>
                    <button
                      type="button"
                      onClick={() => {
                        setRecipient(item)
                        setSheet(null)
                      }}
                    >
                      <span className="xd-contact">{item.name[0]}</span>
                      <span className="xd-pick-main">
                        <b>{item.name}</b>
                        <small>{item.addr}</small>
                      </span>
                      {recipient?.addr === item.addr && (
                        <XIcon name="check" className="xd-pick-check" />
                      )}
                    </button>
                  </li>
                ))}
            </ul>
            {recipient && (
              <button
                type="button"
                className="xd-linkbtn"
                onClick={() => {
                  setRecipient(null)
                  setSheet(null)
                }}
              >
                Type an address instead
              </button>
            )}
          </div>
        </Sheet>
      )}
    </div>
  )
}

function ProviderValue({ place }: { place: Place }) {
  return (
    <span className="xd-provider-value">
      <img src={PLACES[place].icon} alt="" />
      {place === 'zshield' ? 'Zcash' : PLACES[place].name}
    </span>
  )
}

/* ====================== Review / Result ====================== */

export function ReviewScreen({ dispatch, tx }: Base & { tx: Tx }) {
  const [busy, setBusy] = useState(false)
  const swap = tx.kind === 'swap'
  const confirm = () => {
    setBusy(true)
    window.setTimeout(() => dispatch({ type: 'commit', tx }), 800)
  }
  const rows: [ReactNode, ReactNode][] = swap
    ? [
        ['You pay', amountText(tx.amount, tx.token)],
        ['Est. receive', amountText(tx.toAmount, tx.toToken)],
        ['Minimum receive', amountText(tx.toAmount * 0.995, tx.toToken)],
        ['Route', tx.provider],
        ['Max network fee', tx.fee],
        ['Est. time', tx.time]
      ]
    : [
        ['From', tx.fromLabel],
        ['Recipient', tx.toLabel],
        ['Est. receive', amountText(tx.toAmount, tx.toToken)],
        ['Max network fee', tx.fee],
        ['Provider', tx.provider],
        ['Est. time', tx.time]
      ]
  return (
    <div className="xd-page">
      <PageHead
        title={swap ? 'Review Swap' : 'Review Send'}
        onBack={() => dispatch({ type: 'back' })}
      />
      <div className="xd-page-body">
        <div className="xd-review-hero">
          {swap ? (
            <span className="xd-review-pair">
              <TokenIcon token={tx.token} place={tx.place} size={44} />
              <XIcon name="next" />
              <TokenIcon token={tx.toToken} place={tx.toPlace} size={44} />
            </span>
          ) : (
            <TokenIcon token={tx.token} place={tx.place} size={48} />
          )}
          <b>
            {swap
              ? `${amountText(tx.amount, tx.token)} → ${amountText(tx.toAmount, tx.toToken)}`
              : `−${amountText(tx.amount, tx.token)}`}
          </b>
          <span>{usd(tx.amount * TOKENS[tx.token].price)}</span>
        </div>
        <Rows rows={rows} />
        {tx.from === 'shield' ? (
          <PrivacyNote tone="green" icon="shieldCheck">
            Private on {tx.provider}. Your balance and the transaction details stay out of public
            view.
          </PrivacyNote>
        ) : (
          <p className="xd-fineprint">
            Review the asset, recipient, and maximum network fee before sending.
          </p>
        )}
      </div>
      <div className="xd-page-foot">
        <Primary busy={busy} onClick={confirm}>
          {busy ? 'Signing…' : swap ? 'Confirm Swap' : 'Confirm Send'}
        </Primary>
      </div>
    </div>
  )
}

const STATUS = [
  { title: 'Transaction Submitted', body: 'Submitted. Waiting for block inclusion.' },
  { title: 'Confirming Transaction', body: 'Your transfer is on-chain and waiting for finality.' },
  { title: 'Transaction Confirmed', body: 'Your transfer is finalized on-chain.' }
]

const RESULT_TITLE: Record<Tx['kind'], string> = {
  send: 'Sent',
  receive: 'Received',
  shield: 'Shielded',
  unshield: 'Unshielded',
  swap: 'Swapped',
  deposit: 'Deposited',
  withdraw: 'Withdrew'
}

export function ResultScreen({ state, dispatch, tx, live }: Base & { tx: Tx; live: boolean }) {
  const steps = tx.route === 'cluster' ? 3 : 1
  const [phase, setPhase] = useState(live ? 0 : 2)
  const [part, setPart] = useState(live ? 0 : steps)
  const footRef = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)

  useEffect(() => {
    if (!live) return
    const timers = [window.setTimeout(() => setPhase(1), 900)]
    for (let index = 1; index <= steps; index += 1) {
      timers.push(window.setTimeout(() => setPart(index), 900 + index * (steps > 1 ? 750 : 1100)))
    }
    const settle = () => {
      // View Activity is removed the moment the transaction is confirmed; if focus is on a bottom
      // button, hand it to Done so it does not fall out of the page.
      refocus.current = Boolean(footRef.current?.contains(document.activeElement))
      setPhase(2)
    }
    timers.push(window.setTimeout(settle, 900 + steps * (steps > 1 ? 750 : 1100) + 300))
    return () => timers.forEach(id => window.clearTimeout(id))
  }, [live, steps])

  const status = STATUS[phase]
  const done = phase === 2

  useEffect(() => {
    if (!done || !refocus.current) return
    refocus.current = false
    footRef.current?.querySelector('button')?.focus()
  }, [done])
  const domainAfter: Domain = tx.kind === 'send' || tx.kind === 'swap' ? tx.from : tx.to
  const finish = () =>
    live ? dispatch({ type: 'home', domain: domainAfter }) : dispatch({ type: 'back' })

  const rows: [ReactNode, ReactNode][] = [
    ['Amount', state.hidden ? MASK : amountText(tx.amount, tx.token)],
    ...(tx.kind === 'swap'
      ? [
          ['Received', state.hidden ? MASK : amountText(tx.toAmount, tx.toToken)] as [
            ReactNode,
            ReactNode
          ]
        ]
      : []),
    ['Network fee', tx.fee],
    ['From', tx.fromLabel],
    [tx.kind === 'send' ? 'Recipient' : 'To', tx.toLabel],
    ['Network', tx.network],
    ...(tx.route
      ? [
          [
            'Route',
            tx.route === 'cluster' ? 'Cluster · 3 transactions' : 'Directly · 1 transaction'
          ] as [ReactNode, ReactNode]
        ]
      : [])
  ]

  return (
    <div className="xd-page">
      <PageHead title={live ? '' : RESULT_TITLE[tx.kind]} onBack={finish} />
      <div className="xd-page-body">
        <div className={`xd-status${done ? ' is-done' : ''}`} aria-live="polite">
          <span className="xd-status-ring">
            {done ? <XIcon name="check" /> : <XIcon name="spinner" className="xd-spin" />}
          </span>
          <b>{status.title}</b>
          <span>{status.body}</span>
          {steps > 1 && (
            <span className="xd-steps" aria-label={`${part} of ${steps} transactions confirmed`}>
              {Array.from({ length: steps }, (_, index) => (
                <i key={index} className={index < part ? 'on' : ''} />
              ))}
              <em>
                {Math.min(part, steps)} of {steps} transactions
              </em>
            </span>
          )}
          {(tx.from === 'shield' || tx.to === 'shield') && done && (
            <span className="xd-tag tone-green">
              <XIcon name="shieldCheck" />
              {tx.kind === 'unshield'
                ? 'Left the Shield balance'
                : 'Private on ' + (tx.kind === 'shield' ? PLACES[tx.toPlace].name : tx.provider)}
            </span>
          )}
        </div>
        <Rows rows={rows} />
      </div>
      {/* As in the v2.0.0 result page: while processing, the green primary button is
          View Activity and Done is a gray outline; once confirmed only Done remains, in green. */}
      <div
        ref={footRef}
        className={`xd-page-foot is-result${done ? '' : ' is-pair'}${live ? ' is-live' : ''}`}
      >
        {!done && (
          <Primary onClick={() => dispatch({ type: 'home', domain: domainAfter, tab: 'activity' })}>
            View Activity
          </Primary>
        )}
        <Primary tone={done ? 'green' : 'outline'} onClick={finish}>
          Done
        </Primary>
      </div>
    </div>
  )
}

/* ====================== Shield / Unshield / Deposit / Withdraw ====================== */

const MOVE: Record<
  MoveKind,
  {
    from: Domain
    to: Domain
    title: string
    button: string
    sources: Pos[]
    target: (key: Pos) => Pos
  }
> = {
  shield: {
    from: 'public',
    to: 'shield',
    title: 'Shield',
    button: 'Shield',
    sources: SHIELDABLE,
    target: key => {
      const [token] = split(key)
      return token === 'ZEC' ? pos('ZEC', 'zshield') : pos(token, 'near')
    }
  },
  unshield: {
    from: 'shield',
    to: 'public',
    title: 'Unshield',
    button: 'Unshield',
    sources: CATALOG.shield,
    target: key => {
      const [token] = split(key)
      const home: Record<TokenId, Place> = {
        ETH: 'ethereum',
        USDC: 'base',
        USDT: 'bnb',
        ZEC: 'zcash',
        BNB: 'bnb'
      }
      return pos(token, home[token])
    }
  },
  deposit: {
    from: 'public',
    to: 'incognito',
    title: 'Deposit to Incognito',
    button: 'Deposit',
    sources: CATALOG.incognito,
    target: key => key
  },
  withdraw: {
    from: 'incognito',
    to: 'public',
    title: 'Withdraw from Incognito',
    button: 'Withdraw',
    sources: CATALOG.incognito,
    target: key => key
  }
}

const ROUTES = {
  cluster: {
    title: 'Cluster',
    body: 'Multiple transactions',
    privacy: 'Strong',
    time: '~3 min',
    fee: '$0.84'
  },
  direct: {
    title: 'Directly',
    body: 'One transaction',
    privacy: 'Standard',
    time: '~20s',
    fee: '$0.27'
  }
}

/** How a holding is labelled in each balance: tag, tone, and its address or Shield provider. */
function side(
  domain: Domain,
  key: Pos,
  id: string
): { tag: string; tone: 'plain' | 'gold' | 'green'; address: string; img?: string } {
  const [, place] = split(key)
  if (domain === 'shield')
    return { tag: 'Shield', tone: 'green', address: PLACES[place].name, img: PLACES[place].icon }
  if (domain === 'incognito')
    return { tag: 'Incognito', tone: 'gold', address: addressFor(id, 'incognito') }
  if (place === 'zcash')
    return { tag: 'Transparent', tone: 'plain', address: addressFor(id, 'transparent') }
  return { tag: 'Public', tone: 'plain', address: addressFor(id, 'public') }
}

export function MoveFlow({
  state,
  dispatch,
  kind,
  token,
  pick = false
}: Base & { kind: MoveKind; token?: Pos; pick?: boolean }) {
  const ACCOUNT = state.account.name
  const config = MOVE[kind]
  const choices = funded(state, config.from, config.sources)
  const initial = token && choices.includes(token) ? token : (choices[0] ?? null)
  const [key, setKey] = useState<Pos | null>(initial)
  const [sheet, setSheet] = useState(initial === null || pick)
  // Entered by picking an asset first: closing the list without choosing cancels the whole flow
  // (same as closing Quick Shield in the real wallet)
  const [chosen, setChosen] = useState(!pick)
  const [amount, setAmount] = useState('')
  const [route, setRoute] = useState<'cluster' | 'direct'>('direct')
  const [busy, setBusy] = useState(false)
  const back = () => dispatch({ type: 'back' })
  const incog = kind === 'deposit' || kind === 'withdraw'

  if (!key) {
    return (
      <div className="xd-page">
        <PageHead title={config.title} onBack={back} />
        <TokenSheet
          domain={config.from}
          holdings={state.holdings}
          choices={choices}
          title="Select asset"
          hidden={state.hidden}
          onPick={picked => {
            setKey(picked)
            setSheet(false)
          }}
          onBack={back}
          empty={
            <div className="xd-empty-block is-tight">
              <p>No assets found</p>
              {kind === 'withdraw' && (
                <Primary
                  onClick={() =>
                    dispatch({ type: 'replace', screen: { id: 'move', kind: 'deposit' } })
                  }
                >
                  Deposit First
                </Primary>
              )}
            </div>
          }
        />
      </div>
    )
  }

  const [sym, place] = split(key)
  const target = config.target(key)
  const [, toPlace] = split(target)
  const balance = balanceOf(state, config.from, key)
  const value = Number(amount) || 0
  const over = value > balance + 1e-9
  const from = side(config.from, key, state.account.id)
  const to = side(config.to, target, state.account.id)
  const providerPlace = kind === 'shield' ? toPlace : kind === 'unshield' ? place : null
  const fee = incog ? ROUTES[route].fee : NET[providerPlace ?? place].fee
  const time = incog ? ROUTES[route].time : NET[providerPlace ?? place].time

  const submit = () => {
    setBusy(true)
    const tx: Tx = {
      kind,
      from: config.from,
      to: config.to,
      token: sym,
      place,
      amount: value,
      toToken: sym,
      toPlace,
      toAmount: value,
      fee,
      time,
      provider: providerPlace
        ? PLACES[providerPlace].name
        : incog
          ? ROUTES[route].title
          : PLACES[place].name,
      network: PLACES[place === 'near' || place === 'zshield' ? toPlace : place].name,
      fromLabel: `${ACCOUNT} · ${from.tag}`,
      toLabel: `${config.to === 'shield' ? 'Shield' : ACCOUNT} · ${config.to === 'shield' ? PLACES[toPlace].name : to.tag}`,
      route: incog ? route : undefined
    }
    window.setTimeout(() => dispatch({ type: 'commit', tx }), 700)
  }

  return (
    <div className="xd-page" data-kind={kind}>
      <PageHead
        title={config.title}
        onBack={back}
        right={
          incog ? (
            <IconButton
              icon="sliders"
              label="Transfer settings"
              onClick={() =>
                dispatch({ type: 'toast', text: 'Fee speed is fixed to Standard in this demo.' })
              }
            />
          ) : undefined
        }
      />
      <div className="xd-page-body">
        <AmountField
          value={amount}
          onChange={setAmount}
          token={sym}
          place={place}
          balance={balance}
          hidden={state.hidden}
          onToken={() => setSheet(true)}
          label={`${sym} amount`}
        />
        <PartyCard
          dir="From"
          account={config.from === 'shield' ? 'Shield' : ACCOUNT}
          tag={config.from === 'shield' ? undefined : from.tag}
          tone={from.tone}
          address={from.address}
          img={from.img}
        />
        <PartyCard
          dir="To"
          account={config.to === 'shield' ? 'Shield' : ACCOUNT}
          tag={config.to === 'shield' ? undefined : to.tag}
          tone={to.tone}
          address={to.address}
          img={to.img}
        >
          {incog && (
            <div className="xd-party-row is-sub">
              <span className="xd-party-icon">
                <XIcon name="globe" />
              </span>
              <span className="xd-party-main">
                <span className="xd-party-top">
                  <span>Network</span>
                </span>
                <span className="xd-party-addr with-icon">
                  <img src={PLACES[place].icon} alt="" />
                  {PLACES[place].name}
                </span>
              </span>
            </div>
          )}
        </PartyCard>

        {incog ? (
          <div className="xd-routes" role="radiogroup" aria-label="Transfer route">
            {(['cluster', 'direct'] as const).map(item => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={route === item}
                className={route === item ? 'on' : ''}
                onClick={() => setRoute(item)}
              >
                <span className="xd-route-head">
                  <b>{ROUTES[item].title}</b>
                  <i>{route === item && <XIcon name="check" />}</i>
                </span>
                <span className="xd-route-sub">{ROUTES[item].body}</span>
                <span className="xd-route-row">
                  <span>Privacy</span>
                  <b className={item === 'cluster' ? 'is-strong' : ''}>{ROUTES[item].privacy}</b>
                </span>
                <span className="xd-route-row">
                  <span>Time</span>
                  <b>{ROUTES[item].time}</b>
                </span>
                <span className="xd-route-row">
                  <span>Fee</span>
                  <b>{ROUTES[item].fee}</b>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Rows
            rows={[
              ['Provider', <ProviderValue key="provider" place={providerPlace ?? place} />],
              [
                'Fee',
                <span key="fee">
                  ≈ {fee} <small>(Standard)</small>
                </span>
              ],
              ['Est. time', time]
            ]}
          />
        )}

        {kind === 'shield' && (
          <PrivacyNote tone="green" icon="shieldCheck">
            {toPlace === 'zshield' ? PROVIDER_COPY.zshield.body : PROVIDER_COPY.near.body}
          </PrivacyNote>
        )}
        {kind === 'unshield' && (
          <PrivacyNote tone="plain" icon="eye">
            Unshielding moves funds back to your public address, where they are visible on-chain.
          </PrivacyNote>
        )}
        {kind === 'deposit' && (
          <PrivacyNote tone="gold" icon="incognito">
            {route === 'cluster'
              ? 'Cluster splits the deposit into several transactions, so it is harder to link Incognito to your public address.'
              : 'One transaction is faster, but it is easier to link to your public address.'}
          </PrivacyNote>
        )}
      </div>
      <div className="xd-page-foot">
        <Primary disabled={value <= 0 || over} busy={busy} onClick={submit}>
          {over ? 'Insufficient balance' : busy ? 'Confirming…' : config.button}
        </Primary>
      </div>

      {sheet && (
        <TokenSheet
          domain={config.from}
          holdings={state.holdings}
          choices={choices}
          title="Select asset"
          hidden={state.hidden}
          onPick={picked => {
            setKey(picked)
            setAmount('')
            setSheet(false)
            setChosen(true)
          }}
          onBack={() => (chosen ? setSheet(false) : back())}
        />
      )}
    </div>
  )
}

/* ====================== Swap ====================== */

export function SwapFlow({ state, dispatch, start, token }: Base & { start: Domain; token?: Pos }) {
  const ACCOUNT = state.account.name
  const [domain, setDomain] = useState<Domain>(start)
  const pick = (dom: Domain, wanted?: Pos) => {
    const owned = funded(state, dom)
    const first = wanted && owned.includes(wanted) ? wanted : (owned[0] ?? CATALOG[dom][0])
    const [sym] = split(first)
    const other =
      CATALOG[dom].find(
        key => split(key)[0] !== sym && split(key)[0] === (sym === 'USDC' ? 'ETH' : 'USDC')
      ) ??
      CATALOG[dom].find(key => split(key)[0] !== sym) ??
      first
    return [first, other] as const
  }
  const [pair, setPair] = useState(() => pick(start, token))
  const [amount, setAmount] = useState('')
  const [sheet, setSheet] = useState<'from' | 'to' | null>(null)
  const [fromKey, toKey] = pair
  const [fromSym, fromPlace] = split(fromKey)
  const [toSym, toPlace] = split(toKey)
  const balance = balanceOf(state, domain, fromKey)
  const value = Number(amount) || 0
  const over = value > balance + 1e-9
  const rate = (TOKENS[fromSym].price / TOKENS[toSym].price) * 0.997
  const out = value * rate
  const fee = NET[fromPlace].fee
  const time = NET[fromPlace].time
  const routeName = domain === 'shield' ? 'NEAR Confidential' : PLACES[fromPlace].name

  const changeDomain = (next: Domain) => {
    setDomain(next)
    setPair(pick(next))
    setAmount('')
  }

  const review = () => {
    const tx: Tx = {
      kind: 'swap',
      from: domain,
      to: domain,
      token: fromSym,
      place: fromPlace,
      amount: value,
      toToken: toSym,
      toPlace,
      toAmount: Math.round(out * 1e6) / 1e6,
      fee,
      time,
      provider: routeName,
      network: domain === 'shield' ? 'NEAR Confidential' : PLACES[fromPlace].name,
      fromLabel: `${ACCOUNT} · ${DOMAIN_LABEL[domain]}`,
      toLabel: `${ACCOUNT} · ${DOMAIN_LABEL[domain]}`
    }
    dispatch({ type: 'push', screen: { id: 'review', tx } })
  }

  const tokenButton = (key: Pos, which: 'from' | 'to') => {
    const [sym, place] = split(key)
    return (
      <button
        type="button"
        className="xd-swap-token"
        onClick={() => setSheet(which)}
        aria-label={`${which === 'from' ? 'From' : 'To'} asset, current: ${sym}`}
      >
        <TokenIcon token={sym} place={place} size={34} />
        <span>
          <b>
            {sym}
            <XIcon name="down" />
          </b>
          <small>{PLACES[place].name}</small>
        </span>
      </button>
    )
  }

  return (
    <div className="xd-page">
      <PageHead
        title={
          <DomainTitle
            verb="Swap"
            domain={domain}
            options={state.incognito ? ['shield', 'public', 'incognito'] : ['shield', 'public']}
            onChange={changeDomain}
          />
        }
        onBack={() => dispatch({ type: 'back' })}
        right={
          <IconButton
            icon="sliders"
            label="Swap settings"
            onClick={() =>
              dispatch({ type: 'toast', text: 'Slippage is fixed at 0.5% in this demo.' })
            }
          />
        }
      />
      <div className="xd-page-body">
        <div className="xd-swap">
          <div className="xd-swap-side">
            <div className="xd-swap-label">
              <span>From</span>
              <span>
                Bal. {state.hidden ? MASK : amountText(balance, fromSym).replace(` ${fromSym}`, '')}
                <button
                  type="button"
                  onClick={() =>
                    setAmount(
                      String(
                        Math.floor(balance * 10 ** TOKENS[fromSym].digits) /
                          10 ** TOKENS[fromSym].digits
                      )
                    )
                  }
                >
                  Max
                </button>
              </span>
            </div>
            <div className="xd-swap-row">
              {tokenButton(fromKey, 'from')}
              <span className="xd-swap-amount">
                <input
                  inputMode="decimal"
                  placeholder="0"
                  value={amount}
                  aria-label="From amount"
                  onChange={event =>
                    setAmount(event.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))
                  }
                />
                <small>{value ? usd(value * TOKENS[fromSym].price) : '—'}</small>
              </span>
            </div>
          </div>
          <div className="xd-swap-mid">
            <button
              type="button"
              aria-label="Switch assets"
              onClick={() => setPair([toKey, fromKey])}
            >
              <XIcon name="flip" />
            </button>
          </div>
          <div className="xd-swap-side">
            <div className="xd-swap-label">
              <span>To</span>
            </div>
            <div className="xd-swap-row">
              {tokenButton(toKey, 'to')}
              <span className="xd-swap-amount">
                <output aria-label="Estimated amount">
                  {value ? amountText(out, toSym).replace(` ${toSym}`, '') : '—'}
                </output>
                <small>{value ? usd(out * TOKENS[toSym].price) : '—'}</small>
              </span>
            </div>
          </div>
        </div>
        {value > 0 && (
          <Rows
            rows={[
              ['Rate', `1 ${fromSym} ≈ ${amountText(rate, toSym)}`],
              ['Minimum receive', amountText(out * 0.995, toSym)],
              ['Route', routeName],
              ['Network fee', `≈ ${fee}`]
            ]}
          />
        )}
        {domain === 'shield' && (
          <PrivacyNote tone="green" icon="shieldCheck">
            Swaps inside NEAR Confidential stay private: the pair and amount are not published.
          </PrivacyNote>
        )}
      </div>
      <div className="xd-page-foot">
        <Primary disabled={value <= 0 || over || fromSym === toSym} onClick={review}>
          {over ? 'Insufficient balance' : 'Swap'}
        </Primary>
      </div>

      {sheet && (
        <TokenSheet
          domain={domain}
          holdings={state.holdings}
          choices={
            sheet === 'from'
              ? funded(state, domain)
              : CATALOG[domain].filter(key => split(key)[0] !== fromSym)
          }
          title={sheet === 'from' ? 'Swap from' : 'Swap to'}
          hidden={state.hidden}
          onPick={picked => {
            if (sheet === 'from') setPair(picked === toKey ? [picked, fromKey] : [picked, toKey])
            else setPair([fromKey, picked])
            setSheet(null)
          }}
          onBack={() => setSheet(null)}
        />
      )}
    </div>
  )
}

/* ====================== Receive ====================== */

export function ReceiveFlow({ state, dispatch, start }: Base & { start: Domain }) {
  const back = () => dispatch({ type: 'back' })
  const [qr, setQr] = useState<{ title: string; address: string; note: string } | null>(null)
  const copy = () => dispatch({ type: 'toast', text: 'Sample address, so nothing was copied.' })

  const simulate = (domain: Domain, token: TokenId, place: Place, amount: number, peer: string) => {
    dispatch({ type: 'receive', domain, token, place, amount, peer })
    dispatch({
      type: 'toast',
      text: `Received ${amountText(amount, token)}${domain === 'shield' ? ' privately' : ''}`
    })
  }

  const qrSheet = qr && (
    <Sheet title={qr.title} onClose={() => setQr(null)}>
      <div className="xd-sheet-body xd-qr-body">
        <FakeQR seed={qr.address} />
        <b className="xd-qr-addr">{qr.address}</b>
        <p className="xd-fineprint">{qr.note}</p>
        <p className="xd-sample-tag">
          <XIcon name="info" />
          Sample address for this demo. Don’t send funds to it.
        </p>
        <Primary tone="ghost" onClick={copy}>
          <XIcon name="copy" />
          Copy address
        </Primary>
      </div>
    </Sheet>
  )

  const simulateOk = !state.settings.testnet
  if (start === 'shield')
    return (
      <ShieldReceive
        id={state.account.id}
        onBack={back}
        onCopy={copy}
        onQr={setQr}
        qrSheet={qrSheet}
        onSimulate={simulateOk ? simulate : undefined}
      />
    )
  return (
    <PublicReceive
      state={state}
      start={start}
      onBack={back}
      onCopy={copy}
      onQr={setQr}
      qrSheet={qrSheet}
      onSimulate={simulateOk ? simulate : undefined}
    />
  )
}

type QrSetter = (value: { title: string; address: string; note: string }) => void
type Simulate = (domain: Domain, token: TokenId, place: Place, amount: number, peer: string) => void

function AddressRow({
  icon,
  title,
  tag,
  tone = 'plain',
  address,
  onCopy,
  onQr,
  label
}: {
  icon: string
  title: string
  tag?: string
  tone?: 'plain' | 'gold' | 'green'
  address: string
  onCopy: () => void
  onQr: () => void
  label: string
}) {
  return (
    <div className="xd-addr-row">
      <img src={icon} alt="" />
      <span className="xd-addr-main">
        <b>
          {title}
          {tag && <span className={`xd-tag tone-${tone}`}>{tag}</span>}
        </b>
        <span>{address}</span>
      </span>
      <IconButton icon="copy" label={`Copy ${label} address`} onClick={onCopy} />
      <IconButton icon="qr" label={`Show ${label} address QR code`} onClick={onQr} />
    </div>
  )
}

function PublicReceive({
  state,
  start,
  onBack,
  onCopy,
  onQr,
  qrSheet,
  onSimulate
}: {
  state: View
  start: Domain
  onBack: () => void
  onCopy: () => void
  onQr: QrSetter
  qrSheet: ReactNode
  onSimulate?: Simulate
}) {
  const [query, setQuery] = useState('')
  const [account, setAccount] = useState<'public' | 'incognito'>(
    start === 'incognito' ? 'incognito' : 'public'
  )
  const [expanded, setExpanded] = useState(false)
  const q = query.trim().toLowerCase()
  const showZcash = account === 'public' && (!q || 'zcash zec'.includes(q))
  const evmMatch =
    !q ||
    'ethereum evm base bnb arbitrum'.includes(q) ||
    CHAINS.some(place => PLACES[place].name.toLowerCase().includes(q))
  const evmAddress = addressFor(state.account.id, account === 'incognito' ? 'incognito' : 'public')
  const transparent = addressFor(state.account.id, 'transparent')

  return (
    <div className="xd-page">
      <PageHead title="Address" onBack={onBack} />
      <div className="xd-page-body">
        <SearchField value={query} onChange={setQuery} placeholder="Search Network" />
        {showZcash && (
          <AddressRow
            icon={PLACES.zcash.icon}
            title="Zcash"
            tag="Transparent"
            address={transparent}
            label="Zcash transparent"
            onCopy={onCopy}
            onQr={() =>
              onQr({
                title: 'Receive ZEC',
                address: transparent,
                note: 'Transparent Zcash address. Shield it after it arrives to make it private.'
              })
            }
          />
        )}
        <div className="xd-addr-head">
          <span>Other chains</span>
          <span className="xd-seg" role="group" aria-label="Account">
            <button
              type="button"
              className={account === 'public' ? 'on' : ''}
              aria-pressed={account === 'public'}
              onClick={() => setAccount('public')}
            >
              Public
            </button>
            <button
              type="button"
              className={account === 'incognito' ? 'on is-gold' : ''}
              aria-pressed={account === 'incognito'}
              disabled={!state.incognito}
              title={state.incognito ? undefined : 'Create an Incognito account first'}
              onClick={() => setAccount('incognito')}
            >
              Incognito
            </button>
          </span>
        </div>
        {evmMatch && (
          <>
            <AddressRow
              icon={EVM_ICONS}
              title="Ethereum & EVM"
              tag={account === 'incognito' ? 'Incognito' : undefined}
              tone="gold"
              address={evmAddress}
              label={`EVM ${account}`}
              onCopy={onCopy}
              onQr={() =>
                onQr({
                  title: account === 'incognito' ? 'Receive to Incognito' : 'Receive on EVM',
                  address: evmAddress,
                  note: 'One address for Ethereum, Base, BNB Chain and Arbitrum.'
                })
              }
            />
            <button
              type="button"
              className="xd-linkbtn is-left"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Hide networks' : 'Show networks'}
              <XIcon name="down" />
            </button>
            {expanded && (
              <ul className="xd-chainlist">
                {CHAINS.filter(place => place !== 'zcash').map(place => (
                  <li key={place}>
                    <img src={PLACES[place].icon} alt="" />
                    {PLACES[place].name}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {onSimulate && (
          <button
            type="button"
            className="xd-simulate"
            onClick={() => onSimulate(account, 'USDC', 'base', 125, '0x2b77…e41C')}
          >
            <XIcon name="receive" />
            Simulate an incoming payment
          </button>
        )}
      </div>
      {qrSheet}
    </div>
  )
}

function ShieldReceive({
  id,
  onBack,
  onCopy,
  onQr,
  qrSheet,
  onSimulate
}: {
  id: string
  onBack: () => void
  onCopy: () => void
  onQr: QrSetter
  qrSheet: ReactNode
  onSimulate?: Simulate
}) {
  const [provider, setProvider] = useState<'zshield' | 'near'>('zshield')
  const [token, setToken] = useState<TokenId>('USDC')
  const [chain, setChain] = useState<Place>('base')
  const zcash = provider === 'zshield'
  const address = addressFor(id, zcash ? 'shielded' : 'near')
  const note = zcash
    ? 'Shielded address. Only send ZEC on Zcash. It lands in your Shield balance.'
    : `Send ${token} on ${PLACES[chain].name}. It lands in your Shield balance through NEAR Confidential.`

  return (
    <div className="xd-page">
      <PageHead title="Receive" onBack={onBack} />
      <div className="xd-page-body">
        <div className="xd-seg is-wide" role="group" aria-label="Shield provider">
          <button
            type="button"
            className={zcash ? 'on' : ''}
            aria-pressed={zcash}
            onClick={() => setProvider('zshield')}
          >
            <img src={PLACES.zshield.icon} alt="" />
            Zcash Shield
          </button>
          <button
            type="button"
            className={zcash ? '' : 'on'}
            aria-pressed={!zcash}
            onClick={() => setProvider('near')}
          >
            <img src={PLACES.near.icon} alt="" />
            NEAR Confidential
          </button>
        </div>
        {!zcash && (
          <div className="xd-receive-picks">
            <label>
              <span>Token</span>
              <select value={token} onChange={event => setToken(event.target.value as TokenId)}>
                {(['USDC', 'USDT', 'ETH'] as TokenId[]).map(item => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Network</span>
              <select value={chain} onChange={event => setChain(event.target.value as Place)}>
                {(['ethereum', 'base', 'bnb', 'arbitrum'] as Place[]).map(item => (
                  <option key={item} value={item}>
                    {PLACES[item].name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="xd-receive-card">
          <FakeQR seed={`${address}${token}${chain}`} size={148} />
          <span className="xd-receive-meta">
            <span className="xd-tag tone-green">
              <XIcon name="shieldCheck" />
              {zcash ? 'Shielded address' : 'Confidential deposit'}
            </span>
            <b>{address}</b>
            <span className="xd-receive-actions">
              <IconButton icon="copy" label="Copy shielded address" onClick={onCopy} />
              <IconButton
                icon="qr"
                label="Show larger QR code"
                onClick={() =>
                  onQr({
                    title: zcash ? 'Receive ZEC privately' : `Receive ${token}`,
                    address,
                    note
                  })
                }
              />
            </span>
          </span>
        </div>
        <p className="xd-fineprint">{note}</p>
        <p className="xd-sample-tag">
          <XIcon name="info" />
          Sample address for this demo. Don’t send funds to it.
        </p>
        {onSimulate && (
          <button
            type="button"
            className="xd-simulate"
            onClick={() =>
              zcash
                ? onSimulate('shield', 'ZEC', 'zshield', 5, 'Shielded sender')
                : onSimulate(
                    'shield',
                    token,
                    'near',
                    token === 'ETH' ? 0.05 : 150,
                    'Confidential sender'
                  )
            }
          >
            <XIcon name="receive" />
            Simulate an incoming payment
          </button>
        )}
      </div>
      {qrSheet}
    </div>
  )
}

/* ====================== Token detail ====================== */

const RANGES = ['1D', '1W', '1M', '3M', '1Y', 'All']

export function TokenDetail({ state, dispatch, token }: Base & { token: TokenId }) {
  const domains: Domain[] = state.incognito
    ? ['shield', 'public', 'incognito']
    : ['shield', 'public']
  const [view, setView] = useState<Domain | 'total'>(state.domain)
  const [range, setRange] = useState('1D')
  const series = useMemo(() => priceSeries(token, range), [token, range])
  const amountIn = (domain: Domain) =>
    (Object.entries(state.holdings[domain]) as [Pos, number][])
      .filter(([key]) => split(key)[0] === token)
      .reduce((sum, [, amount]) => sum + amount, 0)
  const amount =
    view === 'total' ? domains.reduce((sum, domain) => sum + amountIn(domain), 0) : amountIn(view)
  const meta = TOKENS[token]
  const flowDomain: Domain = view === 'total' ? state.domain : view
  const keyIn = (domain: Domain) =>
    (Object.entries(state.holdings[domain]) as [Pos, number][]).find(
      ([key, value]) => split(key)[0] === token && value > 0
    )?.[0]

  const W = 343
  const H = 120
  const min = Math.min(...series)
  const max = Math.max(...series)
  const points = series.map((value, index) => [
    (index / (series.length - 1)) * W,
    H - 8 - ((value - min) / (max - min || 1)) * (H - 16)
  ])
  const line = points
    .map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ')
  const up = series[series.length - 1] >= series[0]
  const recent = state.activity
    .filter(item => item.token === token || item.toToken === token)
    .slice(0, 4)

  const go = (screen: Parameters<typeof dispatch>[0]) => dispatch(screen)

  return (
    <div className="xd-page">
      <PageHead title={token} onBack={() => dispatch({ type: 'back' })} />
      <div className="xd-tabs is-small" role="tablist" aria-label="Balance view">
        {(['total', ...domains] as (Domain | 'total')[]).map(item => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={view === item}
            className={view === item ? 'on' : ''}
            onClick={() => setView(item)}
          >
            {item === 'total' ? 'Total' : DOMAIN_LABEL[item]}
          </button>
        ))}
      </div>
      <div className="xd-page-body is-detail">
        <div className="xd-asset-hero">
          <TokenIcon token={token} size={52} />
          <b>{state.hidden ? MASK : amountText(amount, token)}</b>
          <span>{money(amount * meta.price, state.hidden)}</span>
        </div>
        <div className="xd-actions is-detail" data-domain={flowDomain}>
          {(
            [
              [
                'Send',
                'send',
                () =>
                  go({
                    type: 'push',
                    screen: {
                      id: 'send',
                      domain: flowDomain === 'incognito' ? 'public' : flowDomain,
                      token: keyIn(flowDomain === 'incognito' ? 'public' : flowDomain)
                    }
                  })
              ],
              [
                'Receive',
                'receive',
                () => go({ type: 'push', screen: { id: 'receive', domain: flowDomain } })
              ],
              [
                'Shield',
                'shield',
                () =>
                  go({
                    type: 'push',
                    screen: { id: 'move', kind: 'shield', token: keyIn('public') }
                  })
              ],
              [
                'Swap',
                'swap',
                () =>
                  go({
                    type: 'push',
                    screen: { id: 'swap', domain: flowDomain, token: keyIn(flowDomain) }
                  })
              ]
            ] as [string, IconName, () => void][]
          ).map(([label, icon, run]) => (
            <button key={label} type="button" onClick={run}>
              <span className="xd-action-icon">
                <XIcon name={icon} />
              </span>
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="xd-price">
          <b>{priceText(token)}</b>
          <span className={meta.change < 0 ? 'down' : 'up'}>{changeText(meta.change)}</span>
          <small>24h</small>
        </div>
        <svg
          className={`xd-chart ${up ? 'up' : 'down'}`}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={`fill-${token}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity=".28" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#fill-${token})`} />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="xd-ranges" role="group" aria-label="Chart range">
          {RANGES.map(item => (
            <button
              key={item}
              type="button"
              aria-pressed={range === item}
              className={range === item ? 'on' : ''}
              onClick={() => setRange(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <h5 className="xd-subhead">Recent activity</h5>
        {recent.length === 0 ? (
          <p className="xd-empty is-left">No activity for this asset</p>
        ) : (
          <ul className="xd-activity is-compact">
            {recent.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    dispatch({
                      type: 'push',
                      screen: { id: 'result', tx: toTx(item), live: false }
                    })
                  }
                >
                  <span className={`xd-act-icon kind-${item.kind}`}>
                    <XIcon
                      name={
                        item.kind === 'unshield'
                          ? 'shieldOff'
                          : item.kind === 'deposit'
                            ? 'deposit'
                            : item.kind === 'withdraw'
                              ? 'withdraw'
                              : item.kind
                      }
                    />
                  </span>
                  <span className="xd-act-main">
                    <b>{RESULT_TITLE[item.kind]}</b>
                    <span>{item.when}</span>
                  </span>
                  <span className="xd-act-side">
                    <b>{state.hidden ? MASK : activityLine(item, item.from)}</b>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/* ====================== Provider detail ====================== */

export function ProviderDetail({ state, dispatch, place }: Base & { place: 'near' | 'zshield' }) {
  const [tab, setTab] = useState<'assets' | 'activity'>('assets')
  const rows = (Object.entries(state.holdings.shield) as [Pos, number][])
    .filter(([key, amount]) => split(key)[1] === place && amount > 0)
    .map(([key, amount]) => ({ key, token: split(key)[0], amount }))
  const total = rows.reduce((sum, row) => sum + row.amount * TOKENS[row.token].price, 0)
  const items = state.activity.filter(item => item.place === place || item.toPlace === place)
  const copy = PROVIDER_COPY[place]
  const firstKey = rows[0]?.key

  return (
    <div className="xd-page xd-provider-page" data-place={place}>
      <PageHead title="" onBack={() => dispatch({ type: 'back' })} />
      <div className="xd-page-body is-detail">
        <div className="xd-provider-hero">
          <img src={PLACES[place].icon} alt="" />
          <b>{copy.title}</b>
          <p>{copy.body}</p>
          <span className="xd-provider-total">
            <small>Total balance</small>
            <strong>{money(total, state.hidden)}</strong>
          </span>
        </div>
        <div className="xd-tiles">
          <button
            type="button"
            onClick={() =>
              dispatch({ type: 'push', screen: { id: 'send', domain: 'shield', token: firstKey } })
            }
          >
            <XIcon name="send" />
            Send
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'push', screen: { id: 'receive', domain: 'shield' } })}
          >
            <XIcon name="receive" />
            Receive
          </button>
          {place === 'near' ? (
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: 'push',
                  screen: { id: 'swap', domain: 'shield', token: firstKey }
                })
              }
            >
              <XIcon name="swap" />
              Swap
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: 'push',
                  screen: { id: 'move', kind: 'unshield', token: firstKey }
                })
              }
            >
              <XIcon name="shieldOff" />
              Unshield
            </button>
          )}
        </div>
        <div className="xd-tabs is-small" role="tablist" aria-label={`${copy.title} sections`}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'assets'}
            className={tab === 'assets' ? 'on' : ''}
            onClick={() => setTab('assets')}
          >
            Assets
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'activity'}
            className={tab === 'activity' ? 'on' : ''}
            onClick={() => setTab('activity')}
          >
            Activity
          </button>
        </div>
        {tab === 'assets' &&
          (rows.length ? (
            <ul className="xd-tokens">
              {rows.map(row => (
                <li key={row.key}>
                  <div className="xd-token">
                    <TokenIcon token={row.token} place={place} />
                    <span className="xd-token-main">
                      <b>{row.token}</b>
                      <span>{priceText(row.token)}</span>
                    </span>
                    <span className="xd-token-side">
                      <b>{money(row.amount * TOKENS[row.token].price, state.hidden)}</b>
                      <span>{state.hidden ? MASK : amountText(row.amount, row.token)}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="xd-empty">No shielded assets yet.</p>
          ))}
        {tab === 'activity' &&
          (items.length ? (
            <ul className="xd-activity is-compact">
              {items.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() =>
                      dispatch({
                        type: 'push',
                        screen: { id: 'result', tx: toTx(item), live: false }
                      })
                    }
                  >
                    <span className={`xd-act-icon kind-${item.kind}`}>
                      <XIcon
                        name={
                          item.kind === 'unshield'
                            ? 'shieldOff'
                            : item.kind === 'deposit'
                              ? 'deposit'
                              : item.kind === 'withdraw'
                                ? 'withdraw'
                                : item.kind
                        }
                      />
                    </span>
                    <span className="xd-act-main">
                      <b>{RESULT_TITLE[item.kind]}</b>
                      <span>{item.when}</span>
                    </span>
                    <span className="xd-act-side">
                      <b>{state.hidden ? MASK : activityLine(item, 'shield')}</b>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="xd-empty">No activity yet</p>
          ))}
      </div>
    </div>
  )
}
