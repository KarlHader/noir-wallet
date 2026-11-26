/**
 * Settings: the main list and its sub-pages (modeled on the v2.0.0 settings page), plus the lock
 * screen. Changes live only in the demo state; the password field stores and sends nothing, and
 * the UI says so.
 */
import { useState, type Dispatch, type ReactNode } from 'react'
import { walletLinkProps } from '../walletStore'
import { IMG } from '../content'
import { type Recipient, SOCIAL } from './data'
import { XIcon, type IconName } from './icons'
import type { Action, SetPage, Settings, View } from './model'
import { IconButton, PageHead, Primary, Sheet, Toggle } from './ui'

type Base = { state: View; dispatch: Dispatch<Action> }

const go = (dispatch: Dispatch<Action>, page: SetPage, arg?: string) =>
  dispatch({ type: 'push', screen: { id: 'set', page, arg } })
const back = (dispatch: Dispatch<Action>) => dispatch({ type: 'back' })
const toast = (dispatch: Dispatch<Action>, text: string) => dispatch({ type: 'toast', text })
const shorten = (text: string) =>
  text.length > 14 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text

/* ====================== Main list ====================== */

export function SettingsPage({ state, dispatch }: Base) {
  const rows: [IconName, string, SetPage][] = [
    ['book', 'Address Book', 'addressBook'],
    ['link', 'DApps Connection', 'connections'],
    ['heart', 'General', 'general'],
    ['shield', 'Security & Privacy', 'security'],
    ['radio', 'Networks', 'networks'],
    ['wallet', 'Default EVM Wallet', 'defaultEvm'],
    ['code', 'Developer Settings', 'developer'],
    ['vote', 'Zcash voting', 'voting'],
    ['buoy', 'Help', 'help'],
    ['info', 'About', 'about']
  ]
  const sidebar = state.settings.sidebar
  return (
    <div className="xd-page">
      <PageHead title="Settings" onBack={() => back(dispatch)} />
      <div className="xd-page-body is-flush">
        <ul className="xd-settings is-big">
          <li>
            <div className="xd-settings-row">
              <XIcon name="panel" />
              Sidebar
              <Toggle
                on={sidebar}
                label="Side panel mode"
                onChange={on => {
                  dispatch({ type: 'setting', patch: { sidebar: on } })
                  toast(
                    dispatch,
                    on
                      ? 'Side panel mode: the wallet opens beside the page.'
                      : 'Popup mode: the wallet opens from the toolbar.'
                  )
                }}
              />
            </div>
          </li>
          {rows.map(([icon, label, page]) => (
            <li key={page}>
              <button type="button" onClick={() => go(dispatch, page)}>
                <XIcon name={icon} />
                {label}
                <XIcon name="next" className="xd-settings-go" />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="xd-page-foot">
        <button type="button" className="xd-lock-btn" onClick={() => dispatch({ type: 'lock' })}>
          <XIcon name="lock" />
          Lock Wallet
        </button>
      </div>
    </div>
  )
}

export function SettingScreen({
  state,
  dispatch,
  page,
  arg
}: Base & { page: SetPage; arg?: string }) {
  switch (page) {
    case 'general':
      return <General state={state} dispatch={dispatch} />
    case 'security':
      return <Security state={state} dispatch={dispatch} />
    case 'password':
      return <ChangePassword dispatch={dispatch} />
    case 'indexer':
      return <Indexer state={state} dispatch={dispatch} />
    case 'networks':
      return <Networks state={state} dispatch={dispatch} />
    case 'network':
      return <NetworkDetails state={state} dispatch={dispatch} id={arg ?? 'ethereum'} />
    case 'addNetwork':
      return <AddNetwork dispatch={dispatch} />
    case 'addressBook':
      return <AddressBook state={state} dispatch={dispatch} />
    case 'connections':
      return <Connections state={state} dispatch={dispatch} />
    case 'defaultEvm':
      return <DefaultEvm state={state} dispatch={dispatch} />
    case 'developer':
      return <Developer state={state} dispatch={dispatch} />
    case 'voting':
      return <Voting dispatch={dispatch} />
    case 'help':
      return <Help dispatch={dispatch} />
    case 'about':
      return <About dispatch={dispatch} />
  }
}

/* ====================== General ====================== */

const LOCK_TIMES = ['1 minute', '5 minutes', '15 minutes', '30 minutes', '1 hour', '4 hours']

function General({ state, dispatch }: Base) {
  return (
    <div className="xd-page">
      <PageHead title="General" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <h5 className="xd-label">Auto-lock Timer</h5>
        <div className="xd-choice-grid" role="radiogroup" aria-label="Auto-lock Timer">
          {LOCK_TIMES.map(time => (
            <button
              key={time}
              type="button"
              role="radio"
              aria-checked={state.settings.autoLock === time}
              className={state.settings.autoLock === time ? 'on' : ''}
              onClick={() => dispatch({ type: 'setting', patch: { autoLock: time } })}
            >
              {time}
            </button>
          ))}
        </div>
        <p className="xd-fineprint">
          Wallet will automatically lock after this period of inactivity
        </p>

        <h5 className="xd-label">Theme (Coming soon)</h5>
        <div className="xd-choice-grid is-disabled">
          {['Light', 'Dark', 'System'].map(theme => (
            <button key={theme} type="button" disabled className={theme === 'Dark' ? 'on' : ''}>
              {theme}
            </button>
          ))}
        </div>

        <h5 className="xd-label">Language (Coming soon)</h5>
        <div className="xd-fake-select is-disabled">
          English
          <XIcon name="down" />
        </div>
      </div>
    </div>
  )
}

/* ====================== Security & Privacy ====================== */

function Security({ state, dispatch }: Base) {
  const [info, setInfo] = useState(false)
  const set = (patch: Partial<Settings>) => dispatch({ type: 'setting', patch })
  return (
    <div className="xd-page">
      <PageHead title="Security & Privacy" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <h5 className="xd-label">Security</h5>
        <div className="xd-card-list">
          <button type="button" className="xd-card-row" onClick={() => go(dispatch, 'password')}>
            <b>Change Password</b>
            <XIcon name="next" />
          </button>
        </div>

        <h5 className="xd-label">Privacy</h5>
        <div className="xd-card-list">
          <div className="xd-card-row">
            <b>
              Zcash Private Broadcast
              <IconButton
                icon="question"
                label="About Zcash private broadcast"
                className="is-inline"
                onClick={() => setInfo(true)}
              />
            </b>
            <Toggle
              on={state.settings.broadcast}
              label="Zcash Private Broadcast"
              onChange={on => set({ broadcast: on })}
            />
          </div>
          <button type="button" className="xd-card-row" onClick={() => go(dispatch, 'indexer')}>
            <b>ZeroIndexer nodes</b>
            <small>{state.settings.indexer === 'auto' ? 'Auto' : 'Custom'}</small>
            <XIcon name="next" />
          </button>
        </div>
        <div className="xd-card-list">
          <div className="xd-card-row is-tall">
            <span>
              <b>Share Google Analytics</b>
              <small>Wallet addresses are never included in analytics.</small>
            </span>
            <Toggle
              on={state.settings.analytics}
              label="Share Google Analytics"
              onChange={on => set({ analytics: on })}
            />
          </div>
        </div>
      </div>
      {info && (
        <Sheet title="Zcash private broadcast" onClose={() => setInfo(false)} className="is-left">
          <div className="xd-sheet-body">
            <p className="xd-sheet-text is-left">
              Your Zcash transactions are broadcast privately instead of straight from your own
              connection, so a transaction is harder to tie to your network.
            </p>
            <Primary tone="ghost" onClick={() => setInfo(false)}>
              Got it
            </Primary>
          </div>
        </Sheet>
      )}
    </div>
  )
}

function PasswordField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const [shown, setShown] = useState(false)
  return (
    <label className="xd-pw">
      <input
        type={shown ? 'text' : 'password'}
        value={value}
        placeholder={label}
        aria-label={label}
        autoComplete="off"
        onChange={event => onChange(event.target.value)}
      />
      <button
        type="button"
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown(!shown)}
      >
        <XIcon name={shown ? 'eyeOff' : 'eye'} />
      </button>
    </label>
  )
}

function ChangePassword({ dispatch }: { dispatch: Dispatch<Action> }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const problem = !current
    ? ''
    : next.length > 0 && next.length < 8
      ? 'Use 8–64 characters.'
      : confirm && confirm !== next
        ? 'Passwords don’t match.'
        : ''
  const ready = current && next.length >= 8 && confirm === next
  return (
    <div className="xd-page">
      <PageHead title="Change Password" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <PasswordField label="Current Password" value={current} onChange={setCurrent} />
        <PasswordField label="New Password" value={next} onChange={setNext} />
        <PasswordField label="Confirm New Password" value={confirm} onChange={setConfirm} />
        {problem && <p className="xd-error">{problem}</p>}
        <p className="xd-fineprint">Demo only: nothing you type here is saved or sent.</p>
      </div>
      <div className="xd-page-foot">
        <Primary
          disabled={!ready}
          onClick={() => {
            toast(dispatch, 'Password changed')
            back(dispatch)
          }}
        >
          Change Password
        </Primary>
      </div>
    </div>
  )
}

function Indexer({ state, dispatch }: Base) {
  const [url, setUrl] = useState('')
  const mode = state.settings.indexer
  const options: ['auto' | 'custom', string, string][] = [
    ['auto', 'Auto', 'Noir picks a healthy node for you.'],
    ['custom', 'Custom', 'Use a node you run yourself.']
  ]
  return (
    <div className="xd-page">
      <PageHead title="ZeroIndexer nodes" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <div className="xd-radio-cards" role="radiogroup" aria-label="ZeroIndexer nodes">
          {options.map(([id, title, sub]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={mode === id ? 'on' : ''}
              onClick={() => dispatch({ type: 'setting', patch: { indexer: id } })}
            >
              <span>
                <b>{title}</b>
                <small>{sub}</small>
              </span>
              <i>{mode === id && <XIcon name="check" />}</i>
            </button>
          ))}
        </div>
        {mode === 'custom' && (
          <form
            className="xd-form"
            onSubmit={event => {
              event.preventDefault()
              if (url.trim()) toast(dispatch, 'Node saved')
            }}
          >
            <label>
              <span>Node URL</span>
              <input
                value={url}
                placeholder="https://indexer.example"
                onChange={event => setUrl(event.target.value)}
                spellCheck={false}
              />
            </label>
            <Primary disabled={!url.trim()} onClick={() => toast(dispatch, 'Node saved')}>
              Save node
            </Primary>
          </form>
        )}
      </div>
    </div>
  )
}

/* ====================== Networks ====================== */

function Networks({ state, dispatch }: Base) {
  return (
    <div className="xd-page">
      <PageHead title="Networks" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <div className="xd-net-list">
          {state.networks.map(network => (
            <button
              key={network.id}
              type="button"
              aria-label={`Configure ${network.name} network`}
              onClick={() => go(dispatch, 'network', network.id)}
            >
              {network.icon ? (
                <img src={network.icon} alt="" />
              ) : (
                <span className="xd-net-blank">
                  <XIcon name="globe" />
                </span>
              )}
              <b>{network.name}</b>
              {network.custom && <span className="xd-tag">Custom</span>}
              <XIcon name="next" />
            </button>
          ))}
        </div>
      </div>
      <div className="xd-page-foot">
        <Primary onClick={() => go(dispatch, 'addNetwork')}>
          <XIcon name="plus" />
          Add Network
        </Primary>
      </div>
    </div>
  )
}

function NetworkDetails({ state, dispatch, id }: Base & { id: string }) {
  const network = state.networks.find(item => item.id === id) ?? state.networks[0]
  const config = () => toast(dispatch, 'Custom RPCs and explorers are set in the extension itself.')
  return (
    <div className="xd-page">
      <PageHead title="Network Details" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <div className="xd-net-head">
          {network.icon ? (
            <img src={network.icon} alt="" />
          ) : (
            <span className="xd-net-blank">
              <XIcon name="globe" />
            </span>
          )}
          <b>{network.name}</b>
        </div>
        <dl className="xd-kv">
          <div>
            <dt>{network.id === 'zcash' ? 'Network' : 'Chain ID'}</dt>
            <dd>{network.chainId}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>{network.currency}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="xd-card-row is-stack"
          aria-label="RPC Endpoint"
          onClick={config}
        >
          <span>
            <b>RPC Endpoint</b>
            <small>{network.rpc}</small>
          </span>
          <XIcon name="next" />
        </button>
        <button
          type="button"
          className="xd-card-row is-stack"
          aria-label="Block Explorer"
          onClick={config}
        >
          <span>
            <b>Block Explorer</b>
            <small>{network.explorer}</small>
          </span>
          <XIcon name="next" />
        </button>
      </div>
    </div>
  )
}

function AddNetwork({ dispatch }: { dispatch: Dispatch<Action> }) {
  const [form, setForm] = useState({
    name: '',
    chainId: '',
    currency: '',
    symbol: '',
    decimals: '18',
    rpc: '',
    explorer: ''
  })
  const field = (
    key: keyof typeof form,
    label: string,
    placeholder = '',
    inputMode?: 'numeric'
  ) => (
    <label key={key}>
      <span>{label}</span>
      <input
        value={form[key]}
        placeholder={placeholder}
        inputMode={inputMode}
        spellCheck={false}
        onChange={event => setForm({ ...form, [key]: event.target.value })}
      />
    </label>
  )
  const ready =
    form.name.trim() && /^\d+$/.test(form.chainId.trim()) && form.symbol.trim() && form.rpc.trim()
  const save = () => {
    dispatch({
      type: 'addNetwork',
      network: {
        id: `custom-${form.chainId.trim()}-${form.name.trim().toLowerCase()}`,
        name: form.name.trim(),
        icon: '',
        chainId: form.chainId.trim(),
        currency: form.symbol.trim().toUpperCase(),
        rpc: form.rpc.trim(),
        explorer: form.explorer.trim() || '—',
        custom: true
      }
    })
    toast(dispatch, `${form.name.trim()} added`)
    back(dispatch)
  }
  return (
    <div className="xd-page">
      <PageHead title="Add Network" onBack={() => back(dispatch)} />
      <form
        className="xd-page-body xd-form"
        onSubmit={event => {
          event.preventDefault()
          if (ready) save()
        }}
      >
        {field('name', 'Network name')}
        {field('chainId', 'Chain ID', '', 'numeric')}
        {field('currency', 'Native currency name')}
        {field('symbol', 'Symbol')}
        {field('decimals', 'Decimals', '18', 'numeric')}
        {field('rpc', 'Default RPC URL', 'https://rpc.example')}
        {field('explorer', 'Explorer URL', 'Optional')}
      </form>
      <div className="xd-page-foot">
        <Primary disabled={!ready} onClick={save}>
          Save Network
        </Primary>
      </div>
    </div>
  )
}

/* ====================== Address Book ====================== */

function AddressBook({ state, dispatch }: Base) {
  const [sheet, setSheet] = useState<'add' | Recipient | null>(null)
  return (
    <div className="xd-page">
      <PageHead title="Address Book" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        {state.contacts.length === 0 ? (
          <div className="xd-empty-block">
            <span className="xd-empty-icon">
              <XIcon name="book" />
            </span>
            <p>No saved recipients</p>
          </div>
        ) : (
          <ul className="xd-picklist is-flush">
            {state.contacts.map(contact => (
              <li key={contact.addr}>
                <button type="button" onClick={() => setSheet(contact)}>
                  <span className="xd-contact">{contact.name[0]}</span>
                  <span className="xd-pick-main">
                    <b>{contact.name}</b>
                    <small>{contact.addr}</small>
                  </span>
                  <span className="xd-tag">{contact.kind === 'zcash' ? 'Zcash' : 'EVM'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="xd-fineprint">Saved recipients also show up when you send.</p>
      </div>
      <div className="xd-page-foot">
        <Primary tone="ghost" onClick={() => setSheet('add')}>
          Add address
        </Primary>
      </div>
      {sheet === 'add' && (
        <AddContactSheet
          onClose={() => setSheet(null)}
          onSave={contact => {
            if (state.contacts.some(item => item.addr === contact.addr)) {
              toast(dispatch, 'That address is already saved.')
              return
            }
            dispatch({ type: 'addContact', contact })
            toast(dispatch, `${contact.name} saved`)
            setSheet(null)
          }}
        />
      )}
      {sheet && sheet !== 'add' && (
        <Sheet title={sheet.name} onClose={() => setSheet(null)} className="is-left">
          <div className="xd-sheet-body">
            <dl className="xd-kv">
              <div>
                <dt>Address</dt>
                <dd>{sheet.addr}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{sheet.kind === 'zcash' ? 'Zcash' : 'Ethereum & EVM'}</dd>
              </div>
            </dl>
            <div className="xd-pair">
              <Primary tone="ghost" onClick={() => setSheet(null)}>
                Close
              </Primary>
              <Primary
                tone="danger"
                onClick={() => {
                  dispatch({ type: 'removeContact', addr: sheet.addr })
                  toast(dispatch, `${sheet.name} removed`)
                  setSheet(null)
                }}
              >
                Delete
              </Primary>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  )
}

function AddContactSheet({
  onClose,
  onSave
}: {
  onClose: () => void
  onSave: (contact: Recipient) => void
}) {
  const [name, setName] = useState('')
  const [addr, setAddr] = useState('')
  const [kind, setKind] = useState<Recipient['kind'] | ''>('')
  const ready = name.trim() && addr.trim().length >= 8 && kind
  const save = () => {
    if (ready) onSave({ name: name.trim(), addr: shorten(addr.trim()), kind })
  }
  return (
    <Sheet title="Add address" onClose={onClose} className="is-left">
      <form
        className="xd-sheet-body xd-form"
        onSubmit={event => {
          event.preventDefault()
          save()
        }}
      >
        <label>
          <span>Name</span>
          <input
            value={name}
            placeholder="Name"
            aria-label="Contact name"
            maxLength={24}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label>
          <span>Address</span>
          <textarea
            value={addr}
            placeholder="Address"
            rows={2}
            spellCheck={false}
            onChange={event => setAddr(event.target.value)}
          />
        </label>
        <label>
          <span>Network</span>
          <select
            value={kind}
            onChange={event => setKind(event.target.value as Recipient['kind'] | '')}
          >
            <option value="">—</option>
            <option value="zcash">Zcash</option>
            <option value="evm">Ethereum &amp; EVM</option>
          </select>
        </label>
        <Primary disabled={!ready} onClick={save}>
          Save address
        </Primary>
      </form>
    </Sheet>
  )
}

/* ====================== DApps Connection ====================== */

function Connections({ state, dispatch }: Base) {
  return (
    <div className="xd-page">
      <PageHead title="DApps Connection" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        {state.connections.length === 0 ? (
          <p className="xd-empty">No connected dApps</p>
        ) : (
          <ul className="xd-dapps is-connections">
            {state.connections.map(site => (
              <li key={site.url}>
                <div className="xd-dapp-row">
                  <span className="xd-dapp-icon">
                    <XIcon name="globe" />
                  </span>
                  <span className="xd-dapp-main">
                    <b>{site.url}</b>
                    <span className={site.as === 'Incognito' ? 'is-gold' : ''}>
                      Connected as {site.as}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="xd-mini"
                    onClick={() => {
                      dispatch({ type: 'disconnect', url: site.url })
                      toast(dispatch, `Disconnected ${site.url}`)
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="xd-page-foot">
        <Primary
          tone="ghost"
          disabled={state.connections.length === 0}
          onClick={() => {
            dispatch({ type: 'disconnectAll' })
            toast(dispatch, 'All dApps disconnected')
          }}
        >
          Disconnect all
        </Primary>
      </div>
    </div>
  )
}

/* ====================== Default EVM Wallet ====================== */

function DefaultEvm({ state, dispatch }: Base) {
  const options: [Settings['defaultEvm'], ReactNode, string][] = [
    ['ask', <XIcon key="i" name="question" />, 'Ask every time'],
    ['noir', <img key="i" src={IMG.logo} alt="" />, 'Use Noir Wallet'],
    ['other', <XIcon key="i" name="wallet" />, 'Use another wallet']
  ]
  return (
    <div className="xd-page">
      <PageHead title="Default EVM Wallet" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <div className="xd-radio-cards" role="radiogroup" aria-label="Default EVM Wallet">
          {options.map(([id, icon, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={state.settings.defaultEvm === id}
              className={state.settings.defaultEvm === id ? 'on' : ''}
              onClick={() => dispatch({ type: 'setting', patch: { defaultEvm: id } })}
            >
              <span className="xd-radio-icon">{icon}</span>
              <span>
                <b>{label}</b>
              </span>
              <i>{state.settings.defaultEvm === id && <XIcon name="check" />}</i>
            </button>
          ))}
        </div>
        <p className="xd-fineprint">
          Which wallet answers when a dApp asks for an Ethereum wallet.
        </p>
      </div>
    </div>
  )
}

/* ====================== Developer Settings ====================== */

const TESTNET_WARNING =
  'Switching networks cancels unsigned approvals, disconnects dApps, locks the wallet, and restarts the extension. Mainnet and testnet balances and activity remain isolated.'

function Developer({ state, dispatch }: Base) {
  const [confirm, setConfirm] = useState(false)
  const testnet = state.settings.testnet
  return (
    <div className="xd-page">
      <PageHead title="Developer Settings" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <div className="xd-card-list">
          <div className="xd-card-row is-tall">
            <span>
              <b>Testnet Mode</b>
              <small className="is-warn">
                Show only test networks across Zcash, EVM, Bitcoin, and supported chains.
              </small>
            </span>
            <Toggle on={testnet} label="Testnet Mode" onChange={() => setConfirm(true)} />
          </div>
        </div>
        <p className="xd-note tone-warn">
          <XIcon name="warn" />
          <span>{TESTNET_WARNING}</span>
        </p>
      </div>
      {confirm && (
        <Sheet
          title={testnet ? 'Switch back to Mainnet?' : 'Enable Testnet Mode?'}
          onClose={() => setConfirm(false)}
          className="is-left"
        >
          <div className="xd-sheet-body">
            <p className="xd-sheet-text is-left">{TESTNET_WARNING}</p>
            <div className="xd-pair">
              <Primary tone="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Primary>
              <Primary
                onClick={() => {
                  dispatch({ type: 'setting', patch: { testnet: !testnet } })
                  dispatch({ type: 'disconnectAll' })
                  dispatch({ type: 'lock' })
                }}
              >
                {testnet ? 'Use Mainnet' : 'Use Testnet'}
              </Primary>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  )
}

/* ====================== Zcash voting / Help / About ====================== */

function Voting({ dispatch }: { dispatch: Dispatch<Action> }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="xd-page">
      <PageHead
        title="Zcash voting"
        onBack={() => back(dispatch)}
        right={
          <IconButton
            icon="restart"
            label="Refresh voting rounds"
            className={busy ? 'is-spinning' : ''}
            onClick={() => {
              setBusy(true)
              window.setTimeout(() => {
                setBusy(false)
                toast(dispatch, 'No new voting rounds')
              }, 900)
            }}
          />
        }
      />
      <div className="xd-page-body">
        <div className="xd-empty-block">
          <span className="xd-empty-icon">
            <XIcon name="vote" />
          </span>
          <p>No voting rounds are open right now.</p>
          <small>
            When a Zcash community vote opens, you can vote here with your shielded ZEC.
          </small>
        </div>
      </div>
    </div>
  )
}

function Help({ dispatch }: { dispatch: Dispatch<Action> }) {
  return (
    <div className="xd-page">
      <PageHead title="Help" onBack={() => back(dispatch)} />
      <div className="xd-page-body">
        <div className="xd-help">
          <b>
            <XIcon name="buoy" />
            Get support
          </b>
          <p>Download recent technical logs to help Noir Support investigate an issue.</p>
          <p>
            Logs stay on this device and never include recovery phrases, private keys, passwords,
            addresses, balances, or transaction amounts. Up to 500 entries from the last 24 hours
            are kept.
          </p>
        </div>
      </div>
      <div className="xd-page-foot is-row">
        <Primary
          onClick={() =>
            toast(dispatch, 'In the extension this saves a log file. Nothing is downloaded here.')
          }
        >
          <XIcon name="deposit" />
          Download Logs
        </Primary>
        <Primary
          tone="outline"
          onClick={() => toast(dispatch, 'Support opens from inside the extension.')}
        >
          <XIcon name="plane" />
          Support
        </Primary>
      </div>
    </div>
  )
}

function About({ dispatch }: { dispatch: Dispatch<Action> }) {
  return (
    <div className="xd-page">
      <PageHead title="About" onBack={() => back(dispatch)} />
      <div className="xd-page-body is-detail">
        <div className="xd-about">
          <img src={IMG.logo} alt="" />
          <b>Noir Wallet</b>
          <span>Version 2.0.0</span>
          <p>A privacy-first multi-chain wallet built for security and ease of use</p>
          <span className="xd-about-social">
            {SOCIAL.map(link => (
              <a
                key={link.label}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                aria-label={link.label}
              >
                {link.label === 'GitHub' ? (
                  <XIcon name="github" />
                ) : link.label === 'Telegram' ? (
                  <XIcon name="plane" />
                ) : (
                  <span>X</span>
                )}
              </a>
            ))}
          </span>
        </div>
        <button
          type="button"
          className="xd-card-row"
          onClick={() => toast(dispatch, 'The Terms of Use open inside the extension.')}
        >
          <b>Terms of Use</b>
          <XIcon name="next" />
        </button>
        <div className="xd-card-row">
          <b>License</b>
          <small className="is-strong">BUSL-1.1</small>
        </div>
        <div className="xd-card-row">
          <b>Build</b>
          <small className="is-strong">Website demo</small>
        </div>
        <p className="xd-about-copy">© 2026 Noir Wallet. All rights reserved.</p>
        <a className="xd-linkbtn" {...walletLinkProps}>
          Get the real extension
          <XIcon name="external" />
        </a>
      </div>
    </div>
  )
}

/* ====================== Lock screen ====================== */

export function LockScreen({ dispatch }: { dispatch: Dispatch<Action> }) {
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const unlock = () => {
    if (!password) return
    dispatch({ type: 'unlock' })
  }
  return (
    <div className="xd-lock" role="dialog" aria-label="Wallet locked">
      <h3>Noir Wallet</h3>
      <form
        className="xd-lock-body"
        onSubmit={event => {
          event.preventDefault()
          unlock()
        }}
      >
        <img src={IMG.logo} alt="" />
        <b>Enter your password</b>
        <label className="xd-pw">
          <input
            type={shown ? 'text' : 'password'}
            value={password}
            placeholder="Enter Password"
            aria-label="Enter Password"
            autoComplete="off"
            autoFocus
            onChange={event => setPassword(event.target.value)}
          />
          <button
            type="button"
            aria-label={shown ? 'Hide password' : 'Show password'}
            onClick={() => setShown(!shown)}
          >
            <XIcon name={shown ? 'eyeOff' : 'eye'} />
          </button>
        </label>
        <small>Demo: any password unlocks. Nothing is saved or sent.</small>
      </form>
      <div className="xd-lock-foot">
        <Primary disabled={!password} onClick={unlock}>
          Unlock
        </Primary>
        <button
          type="button"
          className="xd-linkbtn"
          onClick={() =>
            dispatch({
              type: 'toast',
              text: 'In the extension you’d restore the wallet from its recovery phrase.'
            })
          }
        >
          Forgot password?
        </button>
      </div>
    </div>
  )
}
