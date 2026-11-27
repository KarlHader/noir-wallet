/**
 * Key Features (design mock): on a gray band, a wallet picture on the left and three cards on the
 * right. The selected card is lighter with a mint bar on its left edge, and the picture shows
 * that feature. The cards take turns on their own until one is picked.
 */
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { FEATURES, type FeatureLayer } from './content'
import { prefersReducedMotion, useInView } from './motion'

/** How long each card stays selected while they take turns. */
const ROTATE_MS = 6000

/** Size of the stage the pictures are laid out on in the design mock (CSS px). */
const STAGE = { w: 434, h: 647 }

/** Places a picture on the stage in percentages, so the stage can scale down as a whole. */
function layerStyle(layer: FeatureLayer): CSSProperties {
  return {
    left: `${(layer.x / STAGE.w) * 100}%`,
    top: `${(layer.y / STAGE.h) * 100}%`,
    width: `${(layer.w / STAGE.w) * 100}%`,
    aspectRatio: `${layer.w} / ${layer.clip ?? layer.h}`
  }
}

export function KeyFeatures() {
  const [reduced] = useState(prefersReducedMotion)
  const [active, setActive] = useState(0)
  const [auto, setAuto] = useState(!reduced)
  const [hold, setHold] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const visible = useInView(boxRef, 0.4)

  // Move on to the next card after a while. Paused while off-screen, while the pointer is over
  // the section, or while focus is inside it; stops for good once a card is picked.
  const running = auto && visible && !hold
  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(
      () => setActive(index => (index + 1) % FEATURES.length),
      ROTATE_MS
    )
    return () => window.clearTimeout(timer)
  }, [running, active])

  const pick = (index: number, focus = false) => {
    setAuto(false)
    setActive(index)
    if (focus) tabRefs.current[index]?.focus()
  }

  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = FEATURES.length - 1
    const keys: Record<string, number> = {
      ArrowDown: active === last ? 0 : active + 1,
      ArrowRight: active === last ? 0 : active + 1,
      ArrowUp: active === 0 ? last : active - 1,
      ArrowLeft: active === 0 ? last : active - 1,
      Home: 0,
      End: last
    }
    if (!(event.key in keys)) return
    event.preventDefault()
    pick(keys[event.key], true)
  }

  const current = FEATURES[active]

  return (
    <section className="kf" id="features" aria-labelledby="kf-title">
      <div
        ref={boxRef}
        className="kf-box"
        onPointerEnter={() => setHold(true)}
        onPointerLeave={() => setHold(false)}
        onFocus={() => setHold(true)}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHold(false)
        }}
      >
        <div
          className="kf-stage"
          data-reveal="up"
          id="kf-panel"
          role="tabpanel"
          aria-labelledby={`kf-tab-${current.id}`}
        >
          {FEATURES.map((feature, index) => {
            const on = index === active
            return (
              <div
                key={feature.id}
                className={`kf-shot${on ? ' on' : ''}`}
                role="img"
                aria-label={feature.alt}
                aria-hidden={on ? undefined : true}
              >
                {feature.layers.map(layer => (
                  <div key={layer.src} className="kf-layer" style={layerStyle(layer)}>
                    <img src={layer.src} width={layer.w} height={layer.h} loading="lazy" alt="" />
                  </div>
                ))}
              </div>
            )
          })}
        </div>

        <div className="kf-side">
          <h2 className="kf-title" id="kf-title" data-reveal="up">
            Key Features
          </h2>
          <div
            className="kf-tabs"
            role="tablist"
            aria-label="Key features"
            aria-orientation="vertical"
          >
            {FEATURES.map((feature, index) => {
              const on = index === active
              return (
                <button
                  key={feature.id}
                  ref={node => {
                    tabRefs.current[index] = node
                  }}
                  type="button"
                  role="tab"
                  id={`kf-tab-${feature.id}`}
                  className={`kf-tab${on ? ' on' : ''}`}
                  data-reveal="up"
                  aria-selected={on}
                  aria-controls="kf-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => pick(index)}
                  onKeyDown={onKey}
                >
                  <b>{feature.title}</b>
                  <span>{feature.body}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
