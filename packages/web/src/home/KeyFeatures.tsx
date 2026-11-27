/**
 * Key Features (design mock): on a gray band, a wallet picture on the left and three cards on the
 * right. The selected card is lighter with a mint bar on its left edge, and the picture shows
 * that feature.
 *
 * Wide screens: the box pins under the header and scrolling down steps through the features
 * (site.css gives the section the room to scroll); after the last one the page moves on. A card
 * that is clicked scrolls to its stretch. Narrower screens stack the box, which is taller than
 * the screen, so there the cards take turns on their own until one is picked.
 */
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { FEATURES, type FeatureLayer } from './content'
import { prefersReducedMotion, useInView } from './motion'

/** How long each card stays selected while they take turns. */
const ROTATE_MS = 6000

/** Where the box pins and the scroll drives the features; site.css uses the same conditions. */
const PINNED = '(min-width: 1100px)'

function usePinned() {
  const [pinned, setPinned] = useState(false)
  useEffect(() => {
    const media = window.matchMedia(PINNED)
    // overflow: clip keeps the band from becoming a scroll container that sticky would stick to
    const supported = CSS.supports('overflow', 'clip')
    const sync = () => setPinned(supported && media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])
  return pinned
}

/** How far the section has scrolled under the pinned box: 0 when it pins, 1 when it lets go. */
function pinProgress(section: HTMLElement, box: HTMLElement) {
  const travel = section.offsetHeight - box.offsetHeight
  const passed = parseFloat(getComputedStyle(box).top) - section.getBoundingClientRect().top
  return { travel, progress: travel > 0 ? Math.min(Math.max(passed / travel, 0), 1) : 0 }
}

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
  const sectionRef = useRef<HTMLElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const visible = useInView(boxRef, 0.4)
  const pinned = usePinned()

  // Pinned: the feature follows the scroll, a third of the section's travel each
  useEffect(() => {
    const section = sectionRef.current
    const box = boxRef.current
    if (!pinned || !section || !box) return
    let frame = 0
    const update = () => {
      frame = 0
      const { progress } = pinProgress(section, box)
      setActive(Math.min(Math.floor(progress * FEATURES.length), FEATURES.length - 1))
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.cancelAnimationFrame(frame)
    }
  }, [pinned])

  // Stacked: move on to the next card after a while. Paused while off-screen, while the pointer
  // is over the section, or while focus is inside it; stops for good once a card is picked.
  const running = auto && visible && !hold && !pinned
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
    const section = sectionRef.current
    const box = boxRef.current
    if (pinned && section && box) {
      // Scroll to the middle of that feature's stretch; the scroll then selects it
      const { travel } = pinProgress(section, box)
      const start =
        section.getBoundingClientRect().top + window.scrollY - parseFloat(getComputedStyle(box).top)
      window.scrollTo({
        top: start + (travel * (index + 0.5)) / FEATURES.length,
        behavior: reduced ? 'auto' : 'smooth'
      })
      if (focus) tabRefs.current[index]?.focus({ preventScroll: true })
      return
    }
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
    <section ref={sectionRef} className="kf" id="features" aria-labelledby="kf-title">
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
      {/* Room to scroll while the box is pinned (wide screens only, see site.css) */}
      <div className="kf-travel" aria-hidden="true" />
    </section>
  )
}
