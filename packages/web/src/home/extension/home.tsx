/**
 * Extension demo home: three stacked balance cards at the top (Shield / Public / Incognito),
 * with the action buttons and tabs below.
 */
import { useState, type Dispatch } from 'react'
import {
  type Activity,
  type Domain,
  type Place,
  type Pos,
  DAPPS,
  PLACES,
  SHIELDABLE,
  TOKENS,
  amountText,
  changeText,
  priceText,
  split,
  usd,
  valueOf
} from './data'
import { DOMAIN_LABEL, MASK, activityLine, closeOnEscape, money, toTx } from './format'
import { XIcon, type IconName } from './icons'
import type { Action, Screen, Tab, View } from './model'
import { Avatar, Primary, Sheet, TokenIcon } from './ui'

type Props = { state: View; dispatch: Dispatch<Action> }

const ACTIONS: Record<
  Domain,
  { label: string; icon: IconName; screen: (domain: Domain) => Screen }[]
> = {
  shield: [
    { label: 'Send', icon: 'send', screen: domain => ({ id: 'send', domain }) },
    { label: 'Receive', icon: 'receive', screen: domain => ({ id: 'receive', domain }) },
    { label: 'Shield', icon: 'shield', screen: () => ({ id: 'move', kind: 'shield' }) },
    { label: 'Unshield', icon: 'shieldOff', screen: () => ({ id: 'move', kind: 'unshield' }) },
    { label: 'Swap', icon: 'swap', screen: domain => ({ id: 'swap', domain }) }
  ],
  public: [
    { label: 'Send', icon: 'send', screen: domain => ({ id: 'send', domain }) },
    { label: 'Receive', icon: 'receive', screen: domain => ({ id: 'receive', domain }) },
    { label: 'Shield', icon: 'shield', screen: () => ({ id: 'move', kind: 'shield' }) },
    { label: 'Swap', icon: 'swap', screen: domain => ({ id: 'swap', domain }) }
  ],
  incognito: [
    { label: 'Deposit', icon: 'deposit', screen: () => ({ id: 'move', kind: 'deposit' }) },
    { label: 'Withdraw', icon: 'withdraw', screen: () => ({ id: 'move', kind: 'withdraw' }) },
    { label: 'Swap', icon: 'swap', screen: domain => ({ id: 'swap', domain }) }
  ]
}

const TABS: Record<Domain, { id: Tab; label: string }[]> = {
  shield: [
    { id: 'tokens', label: 'Tokens' },
    { id: 'providers', label: 'Providers' },
    { id: 'activity', label: 'Activity' }
  ],
  public: [
    { id: 'tokens', label: 'Tokens' },
    { id: 'dapps', label: 'DApps' },
    { id: 'activity', label: 'Activity' }
  ],
  incognito: [
    { id: 'tokens', label: 'Tokens' },
    { id: 'dapps', label: 'DApps' },
    { id: 'activity', label: 'Activity' }
  ]
}

/**
 * Holdings in Public that can be shielded in one click, and their total value (as in the v2.0.0
 * Quick Shield): the Shield card shows "$X available to shield", and these rows in the Public
 * token list reveal a Shield button on hover.
 */
function shieldOffer(state: View) {
  const keys = SHIELDABLE.filter(key => (state.holdings.public[key] ?? 0) > 0)
  const value = keys.reduce(
    (sum, key) => sum + (state.holdings.public[key] ?? 0) * TOKENS[split(key)[0]].price,
    0
  )
  return { keys, label: keys.length === 0 ? undefined : state.hidden ? MASK : usd(value) }
}

/**
 * The "Shield →" on the Shield card and the button in the empty Shield prompt: pick an asset
 * first, then open the Shield form.
 */
const QUICK_SHIELD: Screen = { id: 'move', kind: 'shield', pick: true }

export function Home({ state, dispatch }: Props) {
  const { domain, holdings, hidden } = state
  const domains: Domain[] = state.incognito
    ? ['shield', 'public', 'incognito']
    : ['shield', 'public']
  const totals = {
    shield: valueOf(holdings.shield),
    public: valueOf(holdings.public),
    incognito: valueOf(holdings.incognito)
  }
  const total = totals.shield + totals.public + (state.incognito ? totals.incognito : 0)
  const tabs = TABS[domain]
  const tab = tabs.some(item => item.id === state.tabs[domain]) ? state.tabs[domain] : 'tokens'
  const offer = shieldOffer(state)
  const shieldEmpty = totals.shield <= 0
  // As in wallet v2.1.0: clicking the expanded card (its header or empty body area) collapses the whole
  // stack into thin strips; clicking any card then expands that one.
  const [folded, setFolded] = useState<Domain | null>(null)
  const expanded = folded === domain ? null : domain

  return (
    <div className="xd-home" data-domain={domain}>
      {/* As in wallet v2.1.0: the avatar / account name / menu bar stays fixed at the top, the balance
          area scrolls with the content below it, and the tabs stick when they reach the top. */}
      <div className="xd-topbar">
        <button
          type="button"
          className="xd-avatar"
          aria-label="Choose wallet"
          onClick={() => dispatch({ type: 'layer', layer: 'accounts' })}
        >
          <Avatar n={state.account.avatar} size={28} />
        </button>
        <button
          type="button"
          className="xd-account"
          aria-label={`Choose account, current: ${state.account.name}`}
          onClick={() => dispatch({ type: 'layer', layer: 'accounts' })}
        >
          {state.account.name}
        </button>
        <button
          type="button"
          className="xd-iconbtn xd-menu-btn"
          aria-label="Open menu"
          aria-expanded={state.layer === 'menu'}
          onClick={() => dispatch({ type: 'layer', layer: state.layer === 'menu' ? null : 'menu' })}
        >
          <XIcon name="menu" />
        </button>
      </div>
      <div className="xd-scroll">
        <div className="xd-head">
          <div className="xd-total">
            <span>Total</span>
            <b>{money(total, hidden)}</b>
            <button
              type="button"
              aria-label={hidden ? 'Show balances' : 'Hide balances'}
              onClick={() => dispatch({ type: 'hide' })}
            >
              <XIcon name={hidden ? 'eyeOff' : 'eye'} />
            </button>
          </div>
          <div className={`xd-stack${state.hint ? ' is-hint' : ''}`} key={state.hint}>
            {domains.map(item => (
              <BalanceCard
                key={item}
                domain={item}
                selected={item === domain}
                open={item === expanded}
                value={totals[item]}
                hidden={hidden}
                canAddIncognito={!state.incognito}
                shieldEmpty={shieldEmpty}
                quickLabel={shieldEmpty ? undefined : offer.label}
                onOpen={() => {
                  setFolded(item === expanded ? item : null)
                  dispatch({ type: 'domain', domain: item })
                }}
                onFold={() => setFolded(item)}
                onIncognito={() => dispatch({ type: 'layer', layer: 'incognito' })}
                onQuickShield={() => dispatch({ type: 'push', screen: QUICK_SHIELD })}
                onExplore={() => dispatch({ type: 'tab', tab: 'providers' })}
              />
            ))}
          </div>
        </div>

        <div className="xd-content">
          <div className="xd-actions" data-domain={domain}>
            {ACTIONS[domain].map(action => (
              <button
                key={action.label}
                type="button"
                onClick={() => dispatch({ type: 'push', screen: action.screen(domain) })}
              >
                <span className="xd-action-icon">
                  <XIcon name={action.icon} />
                </span>
                <span>{action.label}</span>
              </button>
            ))}
          </div>

          <div className="xd-tabbed">
            <div className="xd-tabs" role="tablist" aria-label={`${DOMAIN_LABEL[domain]} sections`}>
              {tabs.map(item => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={tab === item.id ? 'on' : ''}
                  onClick={() => dispatch({ type: 'tab', tab: item.id })}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="xd-panel" role="tabpanel" key={`${domain}-${tab}`}>
              {tab === 'tokens' && <TokensPanel state={state} dispatch={dispatch} />}
              {tab === 'providers' && <ProvidersPanel state={state} dispatch={dispatch} />}
              {tab === 'dapps' && <DappsPanel state={state} dispatch={dispatch} />}
              {tab === 'activity' && <ActivityPanel state={state} dispatch={dispatch} />}
            </div>
          </div>
        </div>
      </div>

      {state.layer === 'menu' && <MenuPopover state={state} dispatch={dispatch} />}
      {state.layer === 'accounts' && <AccountDrawer state={state} dispatch={dispatch} />}
      {state.layer === 'incognito' && <IncognitoSheet dispatch={dispatch} />}
    </div>
  )
}

function BalanceCard({
  domain,
  selected,
  open,
  value,
  hidden,
  canAddIncognito,
  shieldEmpty,
  quickLabel,
  onOpen,
  onFold,
  onIncognito,
  onQuickShield,
  onExplore
}: {
  domain: Domain
  /** The currently selected balance (the actions and lists below follow it). */
  selected: boolean
  /** Expanded as the large card; when the whole stack is collapsed, every card is a thin strip. */
  open: boolean
  value: number
  hidden: boolean
  canAddIncognito: boolean
  /** Shield balance is empty: the card shows a description and "Explore privacy providers". */
  shieldEmpty: boolean
  /** Total value in Public that can be shielded; the line is hidden if nothing is shieldable. */
  quickLabel?: string
  onOpen: () => void
  onFold: () => void
  onIncognito: () => void
  onQuickShield: () => void
  onExplore: () => void
}) {
  const watermark: IconName =
    domain === 'shield' ? 'shieldCheck' : domain === 'public' ? 'eye' : 'incognito'
  return (
    <div className="xd-card" data-domain={domain} data-open={open || undefined}>
      <button
        type="button"
        className="xd-card-head"
        aria-label={`${DOMAIN_LABEL[domain]} balance`}
        aria-pressed={selected}
        aria-expanded={open}
        onClick={onOpen}
      >
        <span className="xd-card-label">
          <i />
          {DOMAIN_LABEL[domain]}
        </span>
        <span className="xd-card-amount">{money(value, hidden)}</span>
      </button>
      <div
        className="xd-card-body"
        aria-hidden={!open}
        onClick={event => {
          // Clicking empty body space collapses the card; buttons and links in it still work
          if (open && event.target instanceof Element && !event.target.closest('button, a'))
            onFold()
        }}
      >
        <XIcon name={watermark} className="xd-card-mark" />
        {domain === 'shield' && (
          <div className="xd-card-copy">
            {shieldEmpty ? (
              <>
                <p>
                  Your combined balance across privacy providers. Shielding keeps this balance
                  hidden from public view onchain.
                </p>
                <button
                  type="button"
                  className="xd-card-link"
                  tabIndex={open ? 0 : -1}
                  onClick={onExplore}
                >
                  Explore privacy providers
                  <XIcon name="arrowRight" />
                </button>
              </>
            ) : (
              <>
                <p>Total across privacy providers</p>
                {quickLabel && (
                  <div className="xd-card-quick">
                    <span>{quickLabel} available to shield</span>
                    <button
                      type="button"
                      className="xd-card-link"
                      tabIndex={open ? 0 : -1}
                      onClick={onQuickShield}
                    >
                      Shield
                      <XIcon name="arrowRight" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {domain === 'public' && canAddIncognito && (
          <button
            type="button"
            className="xd-add-incog"
            tabIndex={open ? 0 : -1}
            onClick={onIncognito}
          >
            + Incognito
          </button>
        )}
      </div>
    </div>
  )
}

/* ---------- Tokens ---------- */

function TokensPanel({ state, dispatch }: Props) {
  const { domain, holdings, hidden } = state
  const offer = shieldOffer(state)
  const [filter, setFilter] = useState<Place | 'all'>('all')
  const [view, setView] = useState<'token' | 'chain'>('token')
  const [picker, setPicker] = useState(false)
  const [lowOpen, setLowOpen] = useState(false)

  const all = (Object.entries(holdings[domain]) as [Pos, number][])
    .filter(([, amount]) => amount > 0)
    .map(([key, amount]) => {
      const [token, place] = split(key)
      return { key, token, place, amount, value: amount * TOKENS[token].price }
    })
    .sort((a, b) => b.value - a.value)
  const places = [...new Set(all.map(row => row.place))]
  const rows = all.filter(row => filter === 'all' || row.place === filter)
  const main = rows.filter(row => row.value >= 1)
  const low = rows.filter(row => row.value < 1)

  if (all.length === 0) {
    // Empty account (newly created, or on testnet): offer a way forward that fits the current card.
    if (domain === 'incognito') {
      return (
        <div className="xd-empty-block">
          <XIcon name="incognito" className="xd-empty-mark" />
          <p>No assets in Incognito yet.</p>
          <Primary
            tone="amber"
            onClick={() => dispatch({ type: 'push', screen: { id: 'move', kind: 'deposit' } })}
          >
            Deposit from Public
          </Primary>
        </div>
      )
    }
    const shield = domain === 'shield'
    if (shield && offer.keys.length > 0) {
      // As in v2.0.0: when Shield is empty and Public has assets that can be shielded, the token
      // list shows this prompt instead.
      return (
        <section className="xd-shield-offer">
          <p>{offer.label ? `${offer.label} available to shield` : 'Assets available to shield'}</p>
          <span>Move eligible tokens from Public to Shield.</span>
          <Primary onClick={() => dispatch({ type: 'push', screen: QUICK_SHIELD })}>
            Shield tokens now
            <XIcon name="arrowRight" />
          </Primary>
        </section>
      )
    }
    return (
      <div className="xd-empty-block">
        <span className="xd-empty-icon">
          <XIcon name={shield ? 'shieldCheck' : 'wallet'} />
        </span>
        <p>{shield ? 'No shielded assets yet.' : 'No assets yet.'}</p>
        <Primary
          tone="ghost"
          onClick={() => dispatch({ type: 'push', screen: { id: 'receive', domain } })}
        >
          <XIcon name="receive" />
          {shield ? 'Receive privately' : 'Receive'}
        </Primary>
      </div>
    )
  }

  // As in v2.0.0: for shieldable token rows in Public, the amount fades out and a Shield button
  // replaces it on mouse hover (or keyboard focus); on touch screens the button is always shown.
  const shieldable = new Set(domain === 'public' ? offer.keys : [])
  const row = (item: (typeof rows)[number]) => (
    <li key={item.key} className={shieldable.has(item.key) ? 'xd-shield-row' : undefined}>
      <button
        type="button"
        className="xd-token"
        aria-label={`View ${item.token} details on ${PLACES[item.place].name}`}
        onClick={() => dispatch({ type: 'push', screen: { id: 'token', token: item.token } })}
      >
        <TokenIcon token={item.token} place={item.place} />
        <span className="xd-token-main">
          <b>{item.token}</b>
          <span>
            {priceText(item.token)}{' '}
            <em className={TOKENS[item.token].change < 0 ? 'down' : 'up'}>
              {changeText(TOKENS[item.token].change)}
            </em>
          </span>
        </span>
        <span className="xd-token-side">
          <b>{money(item.value, hidden)}</b>
          <span>{hidden ? MASK : amountText(item.amount, item.token)}</span>
        </span>
      </button>
      {shieldable.has(item.key) && (
        <button
          type="button"
          className="xd-shield-act"
          aria-label={`Shield ${item.token} on ${PLACES[item.place].name}`}
          onClick={() =>
            dispatch({ type: 'push', screen: { id: 'move', kind: 'shield', token: item.key } })
          }
        >
          <span>
            <XIcon name="shield" />
            Shield
          </span>
        </button>
      )}
    </li>
  )

  const grouped = view === 'chain'

  return (
    <>
      <div className="xd-toolbar">
        <div className="xd-filter" onKeyDown={closeOnEscape(picker, () => setPicker(false))}>
          <button
            type="button"
            className="xd-chip"
            aria-expanded={picker}
            onClick={() => setPicker(!picker)}
          >
            {filter === 'all' ? 'All networks' : PLACES[filter].name}
            <XIcon name="down" />
          </button>
          {picker && (
            <div className="xd-pop" role="menu">
              {(['all', ...places] as (Place | 'all')[]).map(item => (
                <button
                  key={item}
                  type="button"
                  role="menuitemradio"
                  aria-checked={filter === item}
                  onClick={() => {
                    setFilter(item)
                    setPicker(false)
                  }}
                >
                  {item === 'all' ? 'All networks' : PLACES[item].name}
                  {filter === item && <XIcon name="check" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="xd-views" role="group" aria-label="Portfolio view">
          <button
            type="button"
            aria-label="Show token view"
            aria-pressed={!grouped}
            className={grouped ? '' : 'on'}
            onClick={() => setView('token')}
          >
            <XIcon name="coins" />
          </button>
          <button
            type="button"
            aria-label="Show chain view"
            aria-pressed={grouped}
            className={grouped ? 'on' : ''}
            onClick={() => setView('chain')}
          >
            <XIcon name="list" />
          </button>
        </div>
        <button
          type="button"
          className="xd-iconbtn"
          aria-label="Portfolio options"
          onClick={() =>
            dispatch({ type: 'toast', text: 'Token settings aren’t part of this demo.' })
          }
        >
          <XIcon name="more" />
        </button>
      </div>

      {grouped ? (
        places
          .filter(place => filter === 'all' || place === filter)
          .map(place => {
            const inPlace = main.filter(item => item.place === place)
            if (!inPlace.length) return null
            return (
              <section key={place} className="xd-group">
                <h5>
                  <img src={PLACES[place].icon} alt="" />
                  {PLACES[place].name}
                  <span>
                    {money(
                      inPlace.reduce((sum, item) => sum + item.value, 0),
                      hidden
                    )}
                  </span>
                </h5>
                <ul className="xd-tokens">{inPlace.map(row)}</ul>
              </section>
            )
          })
      ) : (
        <ul className="xd-tokens">{main.map(row)}</ul>
      )}

      {low.length > 0 && (
        <div className={`xd-low${lowOpen ? ' is-open' : ''}`}>
          <button type="button" aria-expanded={lowOpen} onClick={() => setLowOpen(!lowOpen)}>
            <XIcon name="archive" />
            <b>Low value</b>
            <span>
              {low.length} {low.length === 1 ? 'Asset' : 'Assets'}
            </span>
            <XIcon name="down" className="xd-low-chev" />
          </button>
          {lowOpen && <ul className="xd-tokens">{low.map(row)}</ul>}
        </div>
      )}
    </>
  )
}

/* ---------- Providers ---------- */

function ProvidersPanel({ state, dispatch }: Props) {
  const providers: ('near' | 'zshield')[] = ['near', 'zshield']
  return (
    <div className="xd-providers">
      {providers.map(place => {
        const value = (Object.entries(state.holdings.shield) as [Pos, number][])
          .filter(([key]) => split(key)[1] === place)
          .reduce((sum, [key, amount]) => sum + amount * TOKENS[split(key)[0]].price, 0)
        return (
          <button
            key={place}
            type="button"
            className="xd-provider"
            data-place={place}
            onClick={() => dispatch({ type: 'push', screen: { id: 'provider', place } })}
          >
            <span className="xd-provider-top">
              <img src={PLACES[place].icon} alt="" />
              <b>{PLACES[place].name}</b>
            </span>
            <span className="xd-provider-foot">
              <span className="xd-pill">{money(value, state.hidden)}</span>
              <XIcon name="next" />
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ---------- DApps ---------- */

function DappsPanel({ state, dispatch }: Props) {
  const incognito = state.domain === 'incognito'
  return (
    <>
      {incognito && (
        <p className="xd-banner tone-gold">
          <XIcon name="incognito" />
          Connected sites will use your Incognito address for this account.
        </p>
      )}
      <ul className="xd-dapps">
        {DAPPS.map(dapp => (
          <li key={dapp.url}>
            <button
              type="button"
              aria-label={`Open ${dapp.name} ${dapp.tag}`}
              onClick={() =>
                dispatch({
                  type: 'toast',
                  text: `In the extension this opens ${dapp.url}, connected as ${incognito ? 'Incognito' : 'Public'}.`
                })
              }
            >
              <span className="xd-dapp-icon">
                <img src={dapp.icon} alt="" />
              </span>
              <span className="xd-dapp-main">
                <b>
                  {dapp.name} <em>{dapp.tag}</em>
                </b>
                <span>https://{dapp.url}</span>
              </span>
              <XIcon name="external" className="xd-dapp-go" />
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

/* ---------- Activity ---------- */

const KIND: Record<Activity['kind'], { title: string; icon: IconName }> = {
  send: { title: 'Sent', icon: 'send' },
  receive: { title: 'Received', icon: 'receive' },
  shield: { title: 'Shielded', icon: 'shield' },
  unshield: { title: 'Unshielded', icon: 'shieldOff' },
  swap: { title: 'Swapped', icon: 'swap' },
  deposit: { title: 'Deposited', icon: 'deposit' },
  withdraw: { title: 'Withdrew', icon: 'withdraw' }
}

function ActivityPanel({ state, dispatch }: Props) {
  const items = state.activity.filter(
    item => item.from === state.domain || item.to === state.domain
  )
  if (!items.length) {
    return <p className="xd-empty">No activity yet</p>
  }
  return (
    <ul className="xd-activity">
      {items.map(item => {
        const line = activityLine(item, state.domain)
        const sub =
          item.kind === 'swap'
            ? `${amountText(item.amount, item.token)} → ${item.toToken}`
            : item.kind === 'send'
              ? `To ${item.peer}`
              : item.kind === 'receive'
                ? `From ${item.peer}`
                : PLACES[item.kind === 'shield' ? item.toPlace : item.place].name
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() =>
                dispatch({ type: 'push', screen: { id: 'result', tx: toTx(item), live: false } })
              }
            >
              <span className={`xd-act-icon kind-${item.kind}`}>
                <XIcon name={KIND[item.kind].icon} />
              </span>
              <span className="xd-act-main">
                <b>{KIND[item.kind].title}</b>
                <span>{sub}</span>
              </span>
              <span className="xd-act-side">
                <b className={line.startsWith('+') ? 'up' : ''}>{state.hidden ? MASK : line}</b>
                <span>{item.when}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/* ---------- Overlays: menu, account drawer, enable Incognito ---------- */

function MenuPopover({ state, dispatch }: Props) {
  const sidebar = state.settings.sidebar
  return (
    <div className="xd-float-layer">
      <button
        type="button"
        className="xd-scrim is-clear"
        aria-label="Close menu"
        tabIndex={-1}
        onClick={() => dispatch({ type: 'layer', layer: null })}
      />
      <div className="xd-menu" role="menu">
        {/* As in wallet v2.1.0: the menu gets an extra Sidebar switch row at the top, the same switch as
            the one in settings. */}
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={sidebar}
          className="xd-menu-switch"
          onClick={() => {
            dispatch({ type: 'setting', patch: { sidebar: !sidebar } })
            dispatch({
              type: 'toast',
              text: sidebar
                ? 'Popup mode: the wallet opens from the toolbar.'
                : 'Side panel mode: the wallet opens beside the page.'
            })
          }}
        >
          <XIcon name="panel" />
          Sidebar
          <span className={`xd-switch is-sm${sidebar ? ' on' : ''}`} aria-hidden="true">
            <i />
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => dispatch({ type: 'push', screen: { id: 'accounts' } })}
        >
          <XIcon name="wallet" />
          Accounts
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => dispatch({ type: 'push', screen: { id: 'set', page: 'connections' } })}
        >
          <XIcon name="plug" />
          DApp connections
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => dispatch({ type: 'push', screen: { id: 'settings' } })}
        >
          <XIcon name="gear" />
          Settings
        </button>
      </div>
    </div>
  )
}

/**
 * Account drawer on the left: avatars grouped by wallet, tap one to switch to it; Accounts and
 * settings are at the bottom.
 */
function AccountDrawer({ state, dispatch }: Props) {
  const close = () => dispatch({ type: 'layer', layer: null })
  return (
    <div className="xd-float-layer">
      <button
        type="button"
        className="xd-scrim"
        aria-label="Close account drawer"
        tabIndex={-1}
        onClick={close}
      />
      <nav className="xd-drawer" aria-label="Accounts">
        <button
          type="button"
          className="xd-iconbtn"
          aria-label="Close account drawer"
          onClick={close}
        >
          <XIcon name="back" />
        </button>
        <div className="xd-drawer-list">
          {state.wallets.map(wallet => (
            <div key={wallet} className="xd-drawer-group">
              <span className="xd-drawer-wallet">{wallet}</span>
              {state.accounts
                .filter(account => account.wallet === wallet && !account.hidden)
                .map(account => {
                  const on = account.id === state.current
                  return (
                    <button
                      key={account.id}
                      type="button"
                      className={`xd-drawer-account${on ? ' on' : ''}`}
                      aria-label={`Switch to ${account.name}`}
                      aria-current={on || undefined}
                      onClick={() => {
                        if (on) close()
                        else {
                          dispatch({ type: 'switch', account: account.id })
                          dispatch({ type: 'toast', text: `Switched to ${account.name}` })
                        }
                      }}
                    >
                      <span className="xd-drawer-ring">
                        <Avatar n={account.avatar} size={40} />
                      </span>
                      {account.name}
                    </button>
                  )
                })}
            </div>
          ))}
        </div>
        <span className="xd-drawer-foot">
          <button
            type="button"
            className="xd-iconbtn"
            aria-label="Accounts"
            onClick={() => dispatch({ type: 'push', screen: { id: 'accounts' } })}
          >
            <XIcon name="wallet" />
          </button>
          <button
            type="button"
            className="xd-iconbtn"
            aria-label="Settings"
            onClick={() => dispatch({ type: 'push', screen: { id: 'settings' } })}
          >
            <XIcon name="gear" />
          </button>
        </span>
      </nav>
    </div>
  )
}

function IncognitoSheet({ dispatch }: { dispatch: Dispatch<Action> }) {
  const [busy, setBusy] = useState(false)
  const create = () => {
    setBusy(true)
    window.setTimeout(() => {
      dispatch({ type: 'incognito' })
      dispatch({ type: 'toast', text: 'Incognito account created' })
    }, 700)
  }
  return (
    <Sheet
      title="+ Incognito"
      onClose={() => dispatch({ type: 'layer', layer: null })}
      className="xd-incog-sheet"
    >
      <div className="xd-sheet-body">
        <div className="xd-card is-preview" data-domain="incognito" data-open>
          <div className="xd-card-head">
            <span className="xd-card-label">Incognito</span>
            <span className="xd-card-amount">${MASK}</span>
          </div>
          <div className="xd-card-body">
            <XIcon name="incognito" className="xd-card-mark" />
          </div>
        </div>
        <p className="xd-sheet-text">
          Use a separate address for DeFi. Your existing recovery phrase backs up this wallet too.
        </p>
        <Primary busy={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create Now'}
        </Primary>
      </div>
    </Sheet>
  )
}
