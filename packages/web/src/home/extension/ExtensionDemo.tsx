/**
 * The "Try the extension" overlay: a guide with a few things to try on the left, and an
 * interactive wallet on the right.
 * Loaded on demand (lazy in Site); its styles ship in the same chunk.
 */
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from 'react'
import { walletLinkProps } from '../walletStore'
import { IMG } from '../content'
import { DemoWallet } from './DemoWallet'
import { XIcon } from './icons'
import { initialState, reducer, type Task } from './model'
import './demo.css'

const TASKS: { id: Task; title: string; body: string }[] = [
  {
    id: 'switch',
    title: 'Switch balances',
    body: 'Tap Shield or Public. The wallet changes with the balance in front.'
  },
  { id: 'shield', title: 'Shield your funds', body: 'Move ETH or ZEC from Public into Shield.' },
  {
    id: 'send',
    title: 'Send privately',
    body: 'Send from your Shield balance and follow it to confirmed.'
  },
  {
    id: 'incognito',
    title: 'Go Incognito',
    body: 'Create an Incognito account for DeFi, then deposit into it.'
  }
]

const POPUP_W = 375
/** Popup height is 600; enabling Sidebar (side panel mode) in settings makes it a taller panel. */
const POPUP_H = 600
const PANEL_H = 720

/** Scales the popup down proportionally to the window size so the whole wallet fits on screen. */
function useFitScale(popupH: number) {
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const fit = () => {
      const wide = window.innerWidth >= 900
      const height = (window.innerHeight - (wide ? 140 : 120)) / popupH
      const width = (window.innerWidth - 32) / POPUP_W
      setScale(Math.max(0.6, Math.min(1, height, width)))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [popupH])
  return scale
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function ExtensionDemo({ onClose }: { onClose: () => void }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const dialog = useRef<HTMLDivElement>(null)
  const popupH = state.settings.sidebar ? PANEL_H : POPUP_H
  const scale = useFitScale(popupH)
  const doneCount = state.done.length

  // On open, lock page scrolling and move focus in; on close, restore scrolling (Site returns
  // focus to the button that opened the demo).
  useEffect(() => {
    const root = document.documentElement
    const overflow = root.style.overflow
    root.style.overflow = 'hidden'
    dialog.current?.focus()
    return () => {
      root.style.overflow = overflow
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      onClose()
      return
    }
    if (event.key !== 'Tab' || !dialog.current) return
    // Keep focus cycling inside the overlay.
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      node => !node.closest('[inert]') && node.getClientRects().length > 0
    )
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialog.current)
    ) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={dialog}
      className="xo"
      role="dialog"
      aria-modal="true"
      aria-labelledby="xo-title"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="xo-bar">
        <span className="xo-brand">
          <img src={IMG.logo} alt="" />
          Noir Wallet
          <em>Extension demo</em>
        </span>
        <span className="xo-bar-actions">
          <button
            type="button"
            className="xo-btn is-quiet"
            onClick={() => dispatch({ type: 'reset' })}
          >
            <XIcon name="restart" />
            <span>Restart</span>
          </button>
          <button type="button" className="xo-btn" onClick={onClose} aria-label="Close wallet demo">
            <span>Close</span>
            <XIcon name="close" />
          </button>
        </span>
      </div>

      <div className="xo-main">
        <section className="xo-guide" aria-labelledby="xo-title">
          <p className="xo-eyebrow">Try it in your browser</p>
          <h2 id="xo-title">Your private wallet, one click away.</h2>
          <p className="xo-lede">
            This is Noir Wallet the way it lives in Chrome: Shield and Public balances side by side,
            with Incognito for DeFi. Tap around freely.
          </p>
          <div className="xo-progress" aria-live="polite">
            <span>
              {doneCount} of {TASKS.length} tried
            </span>
            <i style={{ '--p': doneCount / TASKS.length } as CSSProperties} />
          </div>
          <ol className="xo-tasks">
            {TASKS.map((task, index) => {
              const done = state.done.includes(task.id)
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`xo-task${done ? ' is-done' : ''}`}
                    onClick={() => dispatch({ type: 'guide', task: task.id })}
                  >
                    <span className="xo-num doto">{String(index + 1).padStart(2, '0')}</span>
                    <span className="xo-task-main">
                      <b>{task.title}</b>
                      <span>{task.body}</span>
                    </span>
                    <span className="xo-task-state" aria-label={done ? 'Done' : 'Show me'}>
                      {done ? <XIcon name="check" /> : <XIcon name="next" />}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          {doneCount === TASKS.length ? (
            <div className="xo-finish">
              <p>That’s the tour. The real wallet works the same way, with your own keys.</p>
              <a className="btn" {...walletLinkProps}>
                Get Noir Wallet
              </a>
            </div>
          ) : (
            <p className="xo-foot">
              <XIcon name="info" />
              Sample balances. Simulated transactions. No real funds.
            </p>
          )}
        </section>

        <div className="xo-stage">
          <div className="xo-frame" style={{ width: POPUP_W * scale, height: popupH * scale }}>
            <div
              className="xo-popup"
              style={{ height: popupH, transform: `scale(${scale})` }}
              aria-label="Interactive Noir Wallet demo with sample data"
              role="group"
            >
              <DemoWallet state={state} dispatch={dispatch} />
            </div>
          </div>
          <p className="xo-stage-note">Nothing here is signed, sent or stored.</p>
        </div>
      </div>
    </div>
  )
}
