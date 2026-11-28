/**
 * The extension demo's wallet itself: an extension popup (taller in side panel mode). The home
 * screen is always there and flow pages stack on top of it layer by layer, so going back keeps
 * whatever was filled in.
 */
import { useEffect, useRef, type Dispatch, type KeyboardEvent } from 'react'
import { AccountScreen, AccountsPage } from './accounts'
import {
  MoveFlow,
  ProviderDetail,
  ReceiveFlow,
  ResultScreen,
  ReviewScreen,
  SendFlow,
  SwapFlow,
  TokenDetail
} from './flows'
import { Home } from './home'
import { type Action, type Screen, type State, type View, viewOf } from './model'
import { LockScreen, SettingScreen, SettingsPage } from './settings'

type Props = { state: View; dispatch: Dispatch<Action> }

// One stable key per screen object: when a layer is replaced by a new screen it must remount.
const ids = new WeakMap<Screen, number>()
let nextId = 0
const keyOf = (screen: Screen) => {
  if (!ids.has(screen)) ids.set(screen, (nextId += 1))
  return ids.get(screen)
}

function ScreenView({ screen, state, dispatch }: Props & { screen: Screen }) {
  switch (screen.id) {
    case 'send':
      return (
        <SendFlow state={state} dispatch={dispatch} start={screen.domain} token={screen.token} />
      )
    case 'receive':
      return <ReceiveFlow state={state} dispatch={dispatch} start={screen.domain} />
    case 'move':
      return (
        <MoveFlow
          state={state}
          dispatch={dispatch}
          kind={screen.kind}
          token={screen.token}
          pick={screen.pick}
        />
      )
    case 'swap':
      return (
        <SwapFlow state={state} dispatch={dispatch} start={screen.domain} token={screen.token} />
      )
    case 'review':
      return <ReviewScreen state={state} dispatch={dispatch} tx={screen.tx} />
    case 'result':
      return <ResultScreen state={state} dispatch={dispatch} tx={screen.tx} live={screen.live} />
    case 'token':
      return <TokenDetail state={state} dispatch={dispatch} token={screen.token} />
    case 'provider':
      return <ProviderDetail state={state} dispatch={dispatch} place={screen.place} />
    case 'accounts':
      return <AccountsPage state={state} dispatch={dispatch} />
    case 'acct':
      return (
        <AccountScreen state={state} dispatch={dispatch} page={screen.page} id={screen.account} />
      )
    case 'settings':
      return <SettingsPage state={state} dispatch={dispatch} />
    case 'set':
      return <SettingScreen state={state} dispatch={dispatch} page={screen.page} arg={screen.arg} />
  }
}

export function DemoWallet({ state: raw, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const state = viewOf(raw)
  const { stack, toast, locked } = state
  const testnet = state.settings.testnet
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => dispatch({ type: 'untoast', id: toast.id }), 2600)
    return () => window.clearTimeout(timer)
  }, [toast, dispatch])

  // After a page change the layer below becomes inert and focus falls back to the body. Hand it
  // to the top layer so keyboard users stay in the wallet and Esc / Tab keep working. Leave focus
  // alone when it is in the guide on the left.
  useEffect(() => {
    const node = root.current
    if (!node || locked) return
    const active = document.activeElement
    const lost =
      !active ||
      active === document.body ||
      (node.contains(active) && active.closest('[inert]') !== null)
    if (!lost) return
    const top =
      node.querySelector<HTMLElement>('.xd-layer.is-top') ??
      node.querySelector<HTMLElement>('.xd-base')
    top?.focus({ preventScroll: true })
  }, [stack.length, locked])

  // Esc closes the wallet's overlay first, then goes back one page; only when neither applies is
  // it left to the outer layer to close the whole demo. Ignored on the lock screen.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || locked) return
    if (state.layer) dispatch({ type: 'layer', layer: null })
    else if (stack.length) dispatch({ type: 'back' })
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div ref={root} className="xd" data-testnet={testnet || undefined} onKeyDown={onKeyDown}>
      {testnet && <div className="xd-testnet">TESTNET</div>}
      <div className="xd-base" inert={stack.length > 0 || locked} tabIndex={-1}>
        <Home state={state} dispatch={dispatch} />
      </div>
      {stack.map((screen, index) => {
        const top = index === stack.length - 1
        return (
          <div
            key={keyOf(screen)}
            className={`xd-layer${top ? ' is-top' : ''}`}
            inert={!top || locked}
            tabIndex={-1}
          >
            <ScreenView screen={screen} state={state} dispatch={dispatch} />
          </div>
        )
      })}
      {locked && <LockScreen dispatch={dispatch} />}
      {toast && (
        <div className="xd-toast" role="status" key={toast.id}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
