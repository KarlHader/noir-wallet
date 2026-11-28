/**
 * Account-related pages: the Accounts list (grouped by wallet), adding an account / wallet,
 * rename, pin, hide and delete, plus the address, network, seed phrase and private key pages
 * in account details. The seed phrase and private key pages only demonstrate the flow and never
 * show anything real or realistic-looking.
 */
import { useState, type Dispatch } from 'react'
import { EVM_ICONS, PLACES, addressFor, valueOf } from './data'
import { MASK, closeOnEscape, money } from './format'
import { XIcon, type IconName } from './icons'
import type { Account, Action, AcctPage, View } from './model'
import { Avatar, FakeQR, IconButton, PageHead, Primary, Sheet, Toggle } from './ui'

type Base = { state: View; dispatch: Dispatch<Action> }

const totalOf = (account: Account) =>
  valueOf(account.holdings.shield) +
  valueOf(account.holdings.public) +
  (account.incognito ? valueOf(account.holdings.incognito) : 0)

function NetworkIcons({ account }: { account: Account }) {
  return (
    <span className="xd-acct-nets" aria-label="Networks">
      {account.networks.zcash && <img src={PLACES.zcash.icon} alt="Zcash" />}
      {account.networks.evm && <img src={EVM_ICONS} alt="Ethereum & EVM" />}
    </span>
  )
}

/* ====================== Accounts ====================== */

export function AccountsPage({ state, dispatch }: Base) {
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [menu, setMenu] = useState<string | null>(null)
  const [sheet, setSheet] = useState<
    { kind: 'addAccount' | 'addWallet' } | { kind: 'renameWallet'; wallet: string } | null
  >(null)
  const testnet = state.settings.testnet

  const act = (run: () => void) => {
    setMenu(null)
    run()
  }

  return (
    <div className="xd-page">
      <PageHead title="Accounts" onBack={() => dispatch({ type: 'back' })} backIcon="close" />
      <div className="xd-page-body is-flush">
        {state.wallets.map(wallet => {
          const closed = collapsed.includes(wallet)
          const accounts = state.accounts.filter(account => account.wallet === wallet)
          return (
            <section key={wallet} className="xd-acct-group">
              <div className="xd-acct-wallet">
                <button
                  type="button"
                  aria-label={`Rename wallet ${wallet}`}
                  onClick={() => setSheet({ kind: 'renameWallet', wallet })}
                >
                  {wallet}
                </button>
                <button
                  type="button"
                  className={`xd-acct-fold${closed ? ' is-closed' : ''}`}
                  aria-label={`${closed ? 'Expand' : 'Collapse'} ${wallet}`}
                  aria-expanded={!closed}
                  onClick={() =>
                    setCollapsed(
                      closed ? collapsed.filter(item => item !== wallet) : [...collapsed, wallet]
                    )
                  }
                >
                  <XIcon name="down" />
                </button>
              </div>
              {!closed && (
                <ul className="xd-acct-list">
                  {accounts.map(account => {
                    const on = account.id === state.current
                    return (
                      <li
                        key={account.id}
                        className={`${on ? 'is-current' : ''}${account.hidden ? ' is-hidden' : ''}`}
                      >
                        <button
                          type="button"
                          className="xd-acct-row"
                          aria-label={`Switch to ${account.name}`}
                          aria-current={on || undefined}
                          onClick={() => {
                            if (!on) {
                              dispatch({ type: 'switch', account: account.id })
                              dispatch({ type: 'toast', text: `Switched to ${account.name}` })
                            }
                          }}
                        >
                          <span className="xd-acct-name">
                            <b>{account.name}</b>
                            <NetworkIcons account={account} />
                            {account.hidden && <span className="xd-tag">Hidden</span>}
                          </span>
                          <span className="xd-acct-value">
                            {testnet ? '—' : money(totalOf(account), state.hidden)}
                          </span>
                        </button>
                        {on && <XIcon name="check" className="xd-acct-check" />}
                        <span
                          className="xd-acct-more"
                          onKeyDown={closeOnEscape(menu === account.id, () => setMenu(null))}
                        >
                          <IconButton
                            icon="more"
                            label={`Account actions for ${account.name}`}
                            onClick={() => setMenu(menu === account.id ? null : account.id)}
                          />
                          {menu === account.id && (
                            <>
                              <button
                                type="button"
                                className="xd-scrim is-clear"
                                aria-label="Close menu"
                                tabIndex={-1}
                                onClick={() => setMenu(null)}
                              />
                              <span className="xd-pop xd-acct-pop" role="menu">
                                {(
                                  [
                                    [
                                      'doc',
                                      'Account details',
                                      () =>
                                        dispatch({
                                          type: 'push',
                                          screen: {
                                            id: 'acct',
                                            page: 'details',
                                            account: account.id
                                          }
                                        })
                                    ],
                                    [
                                      'scan',
                                      'Addresses',
                                      () =>
                                        dispatch({
                                          type: 'push',
                                          screen: {
                                            id: 'acct',
                                            page: 'addresses',
                                            account: account.id
                                          }
                                        })
                                    ],
                                    [
                                      'pin',
                                      'Pin to top',
                                      () => {
                                        dispatch({ type: 'pinAccount', account: account.id })
                                        dispatch({
                                          type: 'toast',
                                          text: `${account.name} pinned to top`
                                        })
                                      }
                                    ],
                                    [
                                      account.hidden ? 'eye' : 'eyeOff',
                                      account.hidden ? 'Show account' : 'Hide account',
                                      () => {
                                        const visible = state.accounts.filter(
                                          item => !item.hidden && item.id !== account.id
                                        )
                                        if (!account.hidden && visible.length === 0) {
                                          dispatch({
                                            type: 'toast',
                                            text: 'Keep at least one account visible.'
                                          })
                                          return
                                        }
                                        dispatch({
                                          type: 'hideAccount',
                                          account: account.id,
                                          hidden: !account.hidden
                                        })
                                        dispatch({
                                          type: 'toast',
                                          text: account.hidden
                                            ? `${account.name} is visible again`
                                            : `${account.name} hidden from the account list`
                                        })
                                      }
                                    ]
                                  ] as [IconName, string, () => void][]
                                ).map(([icon, label, run], index) => (
                                  <button
                                    key={label}
                                    type="button"
                                    role="menuitem"
                                    autoFocus={index === 0}
                                    onClick={() => act(run)}
                                  >
                                    <span>
                                      <XIcon name={icon} />
                                      {label}
                                    </span>
                                  </button>
                                ))}
                              </span>
                            </>
                          )}
                        </span>
                      </li>
                    )
                  })}
                  <li>
                    <button
                      type="button"
                      className="xd-acct-add"
                      onClick={() => setSheet({ kind: 'addAccount' })}
                    >
                      <span>
                        <XIcon name="plus" />
                      </span>
                      Add account
                    </button>
                  </li>
                </ul>
              )}
            </section>
          )
        })}
      </div>
      <div className="xd-page-foot">
        <Primary onClick={() => setSheet({ kind: 'addWallet' })}>
          <XIcon name="plus" />
          Add Wallet
        </Primary>
      </div>

      {sheet?.kind === 'addAccount' && (
        <AddAccountSheet
          onClose={() => setSheet(null)}
          onDone={restore => {
            const wallet = state.account.wallet
            const count = state.accounts.filter(account => account.wallet === wallet).length
            dispatch({ type: 'addAccount', wallet })
            dispatch({
              type: 'toast',
              text: `Account ${count + 1} added${restore ? '. Zcash will scan its history.' : ''}`
            })
          }}
        />
      )}
      {sheet?.kind === 'addWallet' && (
        <AddWalletSheet
          onClose={() => setSheet(null)}
          onCreate={() => {
            dispatch({ type: 'addWallet' })
            dispatch({ type: 'toast', text: `Wallet ${state.wallets.length + 1} created` })
          }}
          onToast={text => dispatch({ type: 'toast', text })}
        />
      )}
      {sheet?.kind === 'renameWallet' && (
        <RenameSheet
          title="Rename wallet"
          value={sheet.wallet}
          onClose={() => setSheet(null)}
          onSave={name => {
            if (name !== sheet.wallet && state.wallets.includes(name)) {
              dispatch({ type: 'toast', text: 'Another wallet already has that name.' })
              return
            }
            dispatch({ type: 'renameWallet', wallet: sheet.wallet, name })
            setSheet(null)
          }}
        />
      )}
    </div>
  )
}

function AddAccountSheet({
  onClose,
  onDone
}: {
  onClose: () => void
  onDone: (restore: boolean) => void
}) {
  const [choice, setChoice] = useState<'new' | 'restore' | null>(null)
  const [busy, setBusy] = useState(false)
  const options: [typeof choice, string][] = [
    ['new', 'New Zcash Account'],
    ['restore', 'Restore Zcash Account']
  ]
  return (
    <Sheet title="Has this account received ZEC before?" onClose={onClose} className="is-left">
      <div className="xd-sheet-body">
        <div className="xd-radios" role="radiogroup" aria-label="Zcash account history">
          {options.map(([id, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={choice === id}
              className={choice === id ? 'on' : ''}
              onClick={() => setChoice(id)}
            >
              <i />
              {label}
            </button>
          ))}
        </div>
        <p className="xd-fineprint">
          {choice === 'restore'
            ? 'Restoring scans Zcash from an earlier block so past payments show up. It takes longer to sync.'
            : 'A new account starts syncing from today.'}
        </p>
        <Primary
          disabled={!choice}
          busy={busy}
          onClick={() => {
            setBusy(true)
            window.setTimeout(() => onDone(choice === 'restore'), 700)
          }}
        >
          {busy ? 'Adding…' : 'Continue'}
        </Primary>
      </div>
    </Sheet>
  )
}

function AddWalletSheet({
  onClose,
  onCreate,
  onToast
}: {
  onClose: () => void
  onCreate: () => void
  onToast: (text: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const options: [IconName, string, string, () => void][] = [
    [
      'wallet',
      'Create New Wallet',
      'Create a new seed phrase wallet',
      () => {
        setBusy(true)
        window.setTimeout(onCreate, 700)
      }
    ],
    [
      'doc',
      'Import recovery phrase',
      'Import accounts from another wallet',
      () => onToast('Importing needs a real recovery phrase, so it isn’t part of the demo.')
    ],
    [
      'key',
      'Import private key',
      'Import a single-chain account',
      () => onToast('Importing needs a real private key, so it isn’t part of the demo.')
    ],
    [
      'usb',
      'Connect a hardware wallet',
      'Using a USB or a QR code',
      () => onToast('Hardware wallets need a connected device, so they aren’t part of the demo.')
    ]
  ]
  return (
    <Sheet title="Add wallet" onClose={onClose} className="is-left">
      <div className="xd-sheet-body">
        <div className="xd-options">
          {options.map(([icon, title, sub, run]) => (
            <button key={title} type="button" disabled={busy} onClick={run}>
              <XIcon name={icon} />
              <span>
                <b>{busy && title === 'Create New Wallet' ? 'Creating…' : title}</b>
                <small>{sub}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  )
}

export function RenameSheet({
  title,
  value,
  onClose,
  onSave
}: {
  title: string
  value: string
  onClose: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(value)
  const clean = name.trim()
  return (
    <Sheet title={title} onClose={onClose} className="is-left">
      <form
        className="xd-sheet-body xd-form"
        onSubmit={event => {
          event.preventDefault()
          if (clean) onSave(clean)
        }}
      >
        <label>
          <span>Name</span>
          <input
            value={name}
            maxLength={24}
            autoFocus
            onChange={event => setName(event.target.value)}
            spellCheck={false}
          />
        </label>
        <Primary disabled={!clean || clean === value} onClick={() => onSave(clean)}>
          Save
        </Primary>
      </form>
    </Sheet>
  )
}

/* ====================== Account details and its sub-pages ====================== */

export function AccountScreen({
  state,
  dispatch,
  page,
  id
}: Base & { page: AcctPage; id: string }) {
  const account = state.accounts.find(item => item.id === id)
  if (!account) return null
  if (page === 'details')
    return <AccountDetails state={state} dispatch={dispatch} account={account} />
  if (page === 'addresses') return <AccountAddresses dispatch={dispatch} account={account} />
  if (page === 'networks') return <AccountNetworks dispatch={dispatch} account={account} />
  return <SecretPage dispatch={dispatch} account={account} kind={page} />
}

function AccountDetails({ state, dispatch, account }: Base & { account: Account }) {
  const [sheet, setSheet] = useState<'rename' | 'delete' | null>(null)
  const open = (page: AcctPage) =>
    dispatch({ type: 'push', screen: { id: 'acct', page, account: account.id } })
  const rows: [IconName, string, () => void][] = [
    ['pencil', 'Rename', () => setSheet('rename')],
    ['layers', 'Address', () => open('addresses')],
    ['network', 'Networks', () => open('networks')],
    ['panel', 'Seed Phrase', () => open('seed')],
    ['key', 'Private Key', () => open('key')]
  ]
  return (
    <div className="xd-page">
      <PageHead
        title="Account Details"
        onBack={() => dispatch({ type: 'back' })}
        right={
          <IconButton
            icon="more"
            label="More account actions"
            onClick={() => {
              dispatch({ type: 'pinAccount', account: account.id })
              dispatch({ type: 'toast', text: `${account.name} pinned to top` })
            }}
          />
        }
      />
      <div className="xd-page-body is-detail">
        <div className="xd-acct-hero">
          <span className="xd-acct-hero-ring">
            <Avatar n={account.avatar} size={72} />
          </span>
          <b>{account.name}</b>
          <span>{account.wallet}</span>
        </div>
        <ul className="xd-settings is-big">
          {rows.map(([icon, label, run]) => (
            <li key={label}>
              <button type="button" onClick={run}>
                <XIcon name={icon} />
                {label}
                <XIcon name="next" className="xd-settings-go" />
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="is-danger" onClick={() => setSheet('delete')}>
              <XIcon name="trash" />
              Delete Account
            </button>
          </li>
        </ul>
      </div>

      {sheet === 'rename' && (
        <RenameSheet
          title="Rename account"
          value={account.name}
          onClose={() => setSheet(null)}
          onSave={name => {
            dispatch({ type: 'renameAccount', account: account.id, name })
            dispatch({ type: 'toast', text: `Renamed to ${name}` })
            setSheet(null)
          }}
        />
      )}
      {sheet === 'delete' && (
        <Sheet title={`Delete ${account.name}?`} onClose={() => setSheet(null)} className="is-left">
          <div className="xd-sheet-body">
            <p className="xd-sheet-text is-left">
              This removes the account from this wallet. Balances stay on-chain, and you can add the
              account back from your recovery phrase.
            </p>
            <div className="xd-pair">
              <Primary tone="ghost" onClick={() => setSheet(null)}>
                Cancel
              </Primary>
              <Primary
                tone="danger"
                onClick={() => {
                  if (state.accounts.length < 2) {
                    dispatch({ type: 'toast', text: 'A wallet needs at least one account.' })
                    setSheet(null)
                    return
                  }
                  dispatch({ type: 'deleteAccount', account: account.id })
                  dispatch({ type: 'toast', text: `${account.name} deleted` })
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

function AccountAddresses({ dispatch, account }: { dispatch: Dispatch<Action>; account: Account }) {
  const [qr, setQr] = useState<{ title: string; address: string } | null>(null)
  const rows: {
    icon: string
    title: string
    tag: string
    tone: 'plain' | 'gold' | 'green'
    address: string
    show: boolean
  }[] = [
    {
      icon: PLACES.zcash.icon,
      title: 'Zcash',
      tag: 'Shielded',
      tone: 'green',
      address: addressFor(account.id, 'shielded'),
      show: account.networks.zcash
    },
    {
      icon: PLACES.zcash.icon,
      title: 'Zcash',
      tag: 'Transparent',
      tone: 'plain',
      address: addressFor(account.id, 'transparent'),
      show: account.networks.zcash
    },
    {
      icon: EVM_ICONS,
      title: 'Ethereum & EVM',
      tag: 'Public',
      tone: 'plain',
      address: addressFor(account.id, 'public'),
      show: account.networks.evm
    },
    {
      icon: EVM_ICONS,
      title: 'Ethereum & EVM',
      tag: 'Incognito',
      tone: 'gold',
      address: addressFor(account.id, 'incognito'),
      show: account.networks.evm && account.incognito
    }
  ]
  const copy = () => dispatch({ type: 'toast', text: 'Sample address, so nothing was copied.' })
  return (
    <div className="xd-page">
      <PageHead title="Addresses" onBack={() => dispatch({ type: 'back' })} />
      <div className="xd-page-body">
        <p className="xd-fineprint">{account.name} · sample addresses for this demo</p>
        {rows
          .filter(row => row.show)
          .map(row => (
            <div key={`${row.title}-${row.tag}`} className="xd-addr-row">
              <img src={row.icon} alt="" />
              <span className="xd-addr-main">
                <b>
                  {row.title}
                  <span className={`xd-tag tone-${row.tone}`}>{row.tag}</span>
                </b>
                <span>{row.address}</span>
              </span>
              <IconButton
                icon="copy"
                label={`Copy ${row.title} ${row.tag} address`}
                onClick={copy}
              />
              <IconButton
                icon="qr"
                label={`Show ${row.title} ${row.tag} address QR code`}
                onClick={() => setQr({ title: `${row.title} · ${row.tag}`, address: row.address })}
              />
            </div>
          ))}
      </div>
      {qr && (
        <Sheet title={qr.title} onClose={() => setQr(null)}>
          <div className="xd-sheet-body xd-qr-body">
            <FakeQR seed={qr.address} />
            <b className="xd-qr-addr">{qr.address}</b>
            <p className="xd-sample-tag">
              <XIcon name="info" />
              Sample address for this demo. Don’t send funds to it.
            </p>
          </div>
        </Sheet>
      )}
    </div>
  )
}

function AccountNetworks({ dispatch, account }: { dispatch: Dispatch<Action>; account: Account }) {
  const set = (patch: Partial<Account['networks']>) => {
    const next = { ...account.networks, ...patch }
    if (!next.zcash && !next.evm) {
      dispatch({ type: 'toast', text: 'Keep at least one network on.' })
      return
    }
    dispatch({ type: 'accountNetworks', account: account.id, networks: next })
  }
  return (
    <div className="xd-page">
      <PageHead title="Networks" onBack={() => dispatch({ type: 'back' })} />
      <div className="xd-page-body">
        <p className="xd-fineprint">Choose which networks {account.name} uses.</p>
        <div className="xd-card-list">
          <div className="xd-card-row">
            <img src={PLACES.zcash.icon} alt="" />
            <b>Zcash</b>
            <Toggle on={account.networks.zcash} label="Zcash" onChange={on => set({ zcash: on })} />
          </div>
          <div className="xd-card-row">
            <img src={EVM_ICONS} alt="" />
            <b>Ethereum &amp; EVM</b>
            <Toggle
              on={account.networks.evm}
              label="Ethereum & EVM"
              onChange={on => set({ evm: on })}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Seed phrase / private key: walks through the "enter password → view" flow but only ever shows
 * masked cells.
 */
function SecretPage({
  dispatch,
  account,
  kind
}: {
  dispatch: Dispatch<Action>
  account: Account
  kind: 'seed' | 'key'
}) {
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const seed = kind === 'seed'
  return (
    <div className="xd-page">
      <PageHead
        title={seed ? 'Seed Phrase' : 'Private Key'}
        onBack={() => dispatch({ type: 'back' })}
      />
      <div className="xd-page-body">
        <p className="xd-note tone-danger">
          <XIcon name="warn" />
          <span>
            {seed
              ? 'Never share your Secret Recovery Phrase. Anyone with it gets permanent access to every account in this wallet.'
              : `Never share this private key. Anyone with it controls ${account.name} on this network.`}
          </span>
        </p>
        {!shown ? (
          <form
            className="xd-form"
            onSubmit={event => {
              event.preventDefault()
              if (password) setShown(true)
            }}
          >
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                placeholder="Any password works in the demo"
                autoComplete="off"
                onChange={event => setPassword(event.target.value)}
              />
            </label>
            <Primary disabled={!password} onClick={() => setShown(true)}>
              {seed ? 'Reveal Seed Phrase' : 'Show Private Key'}
            </Primary>
          </form>
        ) : (
          <>
            {seed ? (
              <ol className="xd-seed-grid" aria-label="Recovery phrase, hidden in the demo">
                {Array.from({ length: 24 }, (_, index) => (
                  <li key={index}>
                    <span>{index + 1}.</span>
                    {MASK}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="xd-key-box" aria-label="Private key, hidden in the demo">
                {Array.from({ length: 8 }, () => MASK).join(' ')}
              </div>
            )}
            <p className="xd-note tone-plain">
              <XIcon name="info" />
              <span>
                The demo never shows a real {seed ? 'recovery phrase' : 'private key'}. In the
                extension, {seed ? 'your 24 words appear' : 'the key appears'} here after you
                confirm your password.
              </span>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
