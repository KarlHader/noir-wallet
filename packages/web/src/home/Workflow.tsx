/**
 * How Noir Wallet Works (the design mock's diagram): the Public account shields into the Shield
 * balance, which funds the Incognito account privately, and Incognito is what you trade, lend and
 * predict with. A dashed bracket marks that Public and Incognito have no public link, and the bar
 * underneath says both come from one seed phrase. The supported privacy providers follow.
 * On desktop the diagram is laid out on the mock's 1256 × 536 canvas and scales down as a whole
 * when the container narrows; on phones it becomes one column. Sparks run along the lines: out
 * from Public through Shield and Incognito to the DeFi uses, then back along Return and Unshield.
 */
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from 'react'
import { DEFI_USES, IMG, PROVIDERS } from './content'

const CANVAS_W = 1256

/** The fan from the Incognito account to the three DeFi uses (canvas coordinates) */
const FAN = [
  'M913 224H937a2 2 0 0 0 2-2V160a2 2 0 0 1 2-2H965',
  'M913 249H960',
  'M913 275H937a2 2 0 0 1 2 2V337a2 2 0 0 0 2 2H965'
]

/**
 * Scale factor for when the container is too narrow to fit the design mock's canvas; it is not
 * applied in the one-column phone layout.
 */
function useFit(ref: RefObject<HTMLDivElement | null>) {
  const [k, setK] = useState(1)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      setK(Math.min(1, entry.contentRect.width / CANVAS_W))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return k
}

/** A line with a spark running along it; `is-back` lines run the other way. */
function Wire({ className }: { className: string }) {
  return (
    <span className={`wk-wire ${className}`} aria-hidden="true">
      <i />
    </span>
  )
}

export function Workflow() {
  const fitRef = useRef<HTMLDivElement>(null)
  const k = useFit(fitRef)

  return (
    <section className="works-sec" id="workflow" aria-labelledby="workflow-title">
      <div className="wrap-n">
        <p className="eyebrow" data-reveal="up">
          Wallet Architecture
        </p>
        <h2 className="h2" id="workflow-title" data-reveal="up">
          How Noir Wallet Works
        </h2>
      </div>
      <div className="wrap">
        <div
          ref={fitRef}
          className="works-fit"
          data-reveal="up"
          style={{ '--k': k } as CSSProperties}
        >
          <div className="works">
            {/* Desktop: the "no public link" bracket, the dashed lines down to the seed phrase
                bar, and the fan out to the DeFi uses */}
            <svg className="wk-lines" viewBox="0 0 1256 536" aria-hidden="true">
              <defs>
                <linearGradient
                  id="wk-fan-fade"
                  x1="913"
                  x2="965"
                  y1="0"
                  y2="0"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0" stopColor="#ffa100" stopOpacity="0.1" />
                  <stop offset="1" stopColor="#ffa200" />
                </linearGradient>
              </defs>
              <path className="wk-bracket" d="M98 188V29a6 6 0 0 1 6-6H802a6 6 0 0 1 6 6V196" />
              <path className="wk-drop is-public" d="M101.5 307V451" />
              <path className="wk-drop" d="M808 307V451" />
              {FAN.map(d => (
                <path key={d} className="wk-fan-line" d={d} />
              ))}
              {FAN.map(d => (
                <path key={d} className="wk-fan-spark" pathLength={100} d={d} />
              ))}
            </svg>

            <div className="wk-path">
              <p className="wk-nolink">No public link</p>
              <div className="wk-acct wk-pub">
                <img src={IMG.worksWallet} width={26} height={26} alt="" />
                <b>Public Account</b>
                <span>Your everyday wallet</span>
              </div>
              <div className="wk-link is-shield">
                <span className="wk-tag">Shield</span>
                <Wire className="is-out" />
                <Wire className="is-back" />
                <span className="wk-tag">Unshield</span>
              </div>
              <div className="wk-shield">
                <span className="wk-ring" aria-hidden="true" />
                <div className="wk-core">
                  <img src={IMG.shieldGlyph} width={123} height={133} alt="" />
                  <b>Shield Balance</b>
                </div>
                <div className="wk-chip wk-send">
                  <img src={IMG.worksSend} width={26} height={33} alt="" />
                  <span>Send Privately</span>
                </div>
                <div className="wk-chip wk-recv">
                  <img src={IMG.worksReceive} width={26} height={33} alt="" />
                  <span>Receive Privately</span>
                </div>
              </div>
              <div className="wk-link is-fund">
                <span className="wk-tag">Fund privately</span>
                <Wire className="is-out" />
                <Wire className="is-back" />
                <span className="wk-tag">Return</span>
              </div>
              <div className="wk-acct wk-priv">
                <img src={IMG.worksIncognito} width={28} height={28} alt="" />
                <b>Incognito Account</b>
              </div>
            </div>

            {/* Phones: one line from the Incognito account down to the DeFi uses */}
            <Wire className="wk-down" />
            <div className="wk-defi">
              <b className="wk-defi-title">Your Strategy, Your Identity, Protected</b>
              <ul>
                {DEFI_USES.map(use => (
                  <li key={use.title}>
                    <span className="wk-use-icon">
                      <img src={use.icon} width={15} height={15} alt="" />
                    </span>
                    <b>{use.title}</b>
                    <span>{use.body}</span>
                  </li>
                ))}
              </ul>
              <p className="wk-fresh">
                <b>Others see a fresh address</b>
                <span>Not you, not your main wallet</span>
              </p>
            </div>

            <p className="wk-seed">
              <img src={IMG.worksKey} width={11} height={22} alt="" />
              <span>
                Just one seed phrase, <strong>no extra backup</strong>
              </span>
              <em>HD wallet</em>
            </p>
          </div>
        </div>

        {/* The integrated providers come first; the upcoming ones are dimmed and tagged Soon. */}
        <div className="providers">
          <h3 data-reveal="up">Supported Privacy Providers</h3>
          <ul>
            {PROVIDERS.map(provider => (
              <li
                key={provider.name}
                className={`provider${provider.soon ? ' is-soon' : ''}`}
                data-reveal="up"
              >
                <img src={provider.icon} width={30} height={30} alt="" loading="lazy" />
                <b>{provider.name}</b>
                {provider.soon && <em>Soon</em>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
