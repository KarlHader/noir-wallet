/**
 * How Noir Wallet Works (the flow diagram from the design mock): Public Account →
 * Shield Balance → Incognito Account → DeFi, followed by the supported privacy providers.
 * On desktop the diagram is laid out on the design mock's 1154 × 440 canvas and scales down
 * proportionally as a whole when the container narrows; on phones it becomes vertical.
 * A highlight runs along the connecting lines, from the public account all the way to DeFi.
 */
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from 'react'
import { DEFI_LEAVES, IMG, PROVIDERS } from './content'
import { Icon } from './Icon'
import { TypeIn } from './TypeIn'

const CANVAS_W = 1154

/**
 * Scale factor for when the container is too narrow to fit the design mock's canvas; it is not
 * applied in the vertical phone layout.
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

export function Workflow() {
  const fitRef = useRef<HTMLDivElement>(null)
  const k = useFit(fitRef)

  return (
    <section className="works-sec" id="workflow" aria-labelledby="workflow-title">
      <div className="wrap-n">
        <p className="eyebrow" data-reveal="up">
          Privacy Providers Aggregation
        </p>
        <h2 className="h2" id="workflow-title" data-reveal="type">
          <TypeIn text="How Noir Wallet Works" />
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
            <div className="wk-box wk-pub">Public Account</div>
            <span className="wk-wire" aria-hidden="true">
              <i />
            </span>
            <div className="wk-shield">
              <span className="wk-ring" aria-hidden="true" />
              <div className="wk-core">
                <img src={IMG.shieldGlyph} width={123} height={133} alt="" />
                <b>Shield Balance</b>
              </div>
              <div className="wk-chip wk-send">
                <Icon name="send" />
                <span>Send Privately</span>
              </div>
              <div className="wk-chip wk-recv">
                <Icon name="receive" />
                <span>Receive Privately</span>
              </div>
            </div>
            <span className="wk-wire is-late" aria-hidden="true">
              <i />
            </span>
            <div className="wk-box wk-priv">Incognito Account</div>
            {/* Fork to the three DeFi leaves: two curved lines + a straight line in the middle */}
            <svg className="wk-fan" viewBox="0 0 52 172" aria-hidden="true">
              <path className="wk-fan-line" d="M0 86H5C17 86 27 76 27 64V23C27 11 37 1 49 1H52" />
              <path className="wk-fan-line" d="M0 86H52" />
              <path
                className="wk-fan-line"
                d="M0 86H5C17 86 27 96 27 108V149C27 161 37 171 49 171H52"
              />
              <path
                className="wk-fan-spark"
                pathLength={100}
                d="M0 86H5C17 86 27 76 27 64V23C27 11 37 1 49 1H52"
              />
              <path className="wk-fan-spark" pathLength={100} d="M0 86H52" />
              <path
                className="wk-fan-spark"
                pathLength={100}
                d="M0 86H5C17 86 27 96 27 108V149C27 161 37 171 49 171H52"
              />
            </svg>
            <div className="wk-defi">
              <b>Defi Interactions</b>
              <ul>
                {DEFI_LEAVES.map(leaf => (
                  <li key={leaf}>{leaf}</li>
                ))}
              </ul>
              <span className="wk-more" aria-label="and more">
                <i />
                <i />
                <i />
              </span>
            </div>
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
