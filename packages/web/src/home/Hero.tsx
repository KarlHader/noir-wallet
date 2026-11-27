/**
 * The hero (per the design mock): a dot grid underneath, copy on the left, the wallet home
 * screen (Shield view) on the right, and the supported chains marked on the grid.
 * Every few seconds a scan wave goes out from the wallet's Shield balance card: dots flash as
 * it passes, and the chain marks pick up a shield one after another, then fade back to their
 * original color.
 * Hovering the grid shows each dot's number; clicking the wallet image opens the interactive
 * extension demo. Below the grid runs the "Backed by YZi Labs" band, with the wallet over it.
 */
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { AppsComingSoon } from './ComingSoon'
import { walletLinkProps } from './walletStore'
import { IMG, PHONE_WIDTH, PHONES, frameStyle } from './content'
import { loadDemo } from './demoLoader'
import { Icon } from './Icon'
import { prefersReducedMotion, useInView } from './motion'
import { TypeIn } from './TypeIn'

/** Each chain is drawn in its own color (see .tone-* in site.css). */
type Tone = 'eth' | 'zec' | 'arb' | 'bnb' | 'base'
type Kind = 'wide' | 'mid' | 'band'

/**
 * Chains marked on the dot grid.
 * wide: positions at the design mock's 1440 width. x is the copy column's left edge plus the
 * fraction fx of the column width (Arbitrum uses a fixed leftward offset dx instead); row is
 * the row number.
 * mid: at 1000–1399 there is not enough space on the left, so the last three marks move below
 * the copy. fx is a fraction of the width between the copy column and the wallet; dr is which
 * row below the copy.
 * band: below 1000 all marks sit below the copy, and fx is a fraction of the screen width.
 */
const MARKS: {
  name: string
  tone: Tone
  wide: { fx?: number; dx?: number; row: number }
  mid?: { fx: number; dr: number }
  band: { fx: number; dr: number }
}[] = [
  { name: 'Ethereum', tone: 'eth', wide: { fx: 0.583, row: 4 }, band: { fx: 0.6, dr: 3 } },
  { name: 'Zcash', tone: 'zec', wide: { fx: 0.94, row: 9 }, band: { fx: 0.08, dr: 7 } },
  {
    name: 'Arbitrum',
    tone: 'arb',
    wide: { dx: -93, row: 26 },
    mid: { fx: 0.02, dr: 3 },
    band: { fx: 0.64, dr: 11 }
  },
  {
    name: 'BNB Chain',
    tone: 'bnb',
    wide: { fx: 0.487, row: 31 },
    mid: { fx: 0.5, dr: 7 },
    band: { fx: 0.1, dr: 15 }
  },
  {
    name: 'Base',
    tone: 'base',
    wide: { fx: 0.308, row: 37 },
    mid: { fx: 0.22, dr: 10 },
    band: { fx: 0.5, dr: 19 }
  }
]

const WAVE_MS = 1400
/** Interval between scan waves; how long chain marks keep their shield after a wave passes. */
const WAVE_EVERY = 7500
const SHIELD_HOLD = WAVE_MS + 1500
/**
 * Where the scan wave starts: in the wallet image, the center of the Shield card is 157px below
 * the top of the phone frame (at a 375px-wide frame), converted to a fraction of the width.
 */
const SHIELD_CARD_Y = 157 / PHONE_WIDTH
const TAU = Math.PI * 2
/** Grid dot gray: #1D1D1D; dots under the copy are one step darker so the text stays legible. */
const DOT = '29,29,29'
const DOT_QUIET = '17,17,17'

type Parts = {
  stage: HTMLElement
  canvas: HTMLCanvasElement
  tip: HTMLElement
  marks: HTMLElement[]
  /** Copy column; used to work out each mark's horizontal position from the design mock. */
  column: HTMLElement
  /** Wallet screenshot; used to find the scan wave's starting point. */
  phone: HTMLElement
}

type Field = {
  wave: () => void
  destroy: () => void
}

function clamp01(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function createField({ stage, canvas, tip, marks, column, phone }: Parts, reduced: boolean): Field {
  const context = canvas.getContext('2d')
  if (!context) return { wave: () => {}, destroy: () => {} }
  const ctx = context

  let cols = 101
  let rows = 41
  let total = cols * rows
  let cell = 1
  let width = 0
  let height = 0
  let ratio = 1
  let dims: { x0: number; y0: number; x1: number; y1: number }[] = []
  let markIndex: number[] = []
  let origin = { x: 0, y: 0 }
  let reach = 1
  let hover: { x: number; y: number } | null = null

  const born = performance.now()
  let reveal = reduced ? 1 : 0
  let waveAt = -1
  let raf = 0
  let pending = 0

  const pos = (index: number) => ({
    x: ((index % cols) + 0.5) * cell,
    y: (Math.floor(index / cols) + 0.5) * cell
  })
  const dimmed = (x: number, y: number) =>
    dims.some(d => x > d.x0 && x < d.x1 && y > d.y0 && y < d.y1)

  function layout() {
    const viewport = window.innerWidth
    // The design mock's placement needs at least 180px left of the copy for Arbitrum, which means
    // a viewport ≥1400.
    const kind: Kind = viewport >= 1400 ? 'wide' : viewport >= 1000 ? 'mid' : 'band'
    cols = kind === 'band' ? (viewport < 760 ? 44 : 72) : 101
    width = canvas.clientWidth
    cell = width / cols
    // Phones hide the grid (the mobile design mock has none): nothing to lay out or draw.
    if (width === 0) {
      rows = 0
      total = 0
      height = 0
      return
    }

    const box = canvas.getBoundingClientRect()
    const measure = (selector: string) =>
      Array.from(stage.querySelectorAll<HTMLElement>(selector))
        .map(node => ({ rect: node.getBoundingClientRect(), pad: Number(node.dataset.dim) || 12 }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .map(({ rect, pad }) => ({
          x0: rect.left - box.left - pad,
          y0: rect.top - box.top - pad,
          x1: rect.right - box.left + pad,
          y1: rect.bottom - box.top + pad
        }))

    let copyRow = 0
    measure('.hero-copy [data-dim]').forEach(d => {
      copyRow = Math.max(copyRow, Math.ceil(d.y1 / cell))
    })
    // On narrow screens the wallet overlaps the bottom 64px of the grid, so reserve a few extra
    // rows to keep the lowest marks from being covered.
    rows = kind === 'band' ? copyRow + 31 : Math.max(41, copyRow + (kind === 'mid' ? 13 : 3))
    total = cols * rows
    height = Math.round(cell * rows)
    ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    canvas.style.height = `${height}px`
    // The "Backed by" band sits under the grid (see .band in site.css)
    stage.parentElement?.style.setProperty('--field-h', `${height}px`)
    dims = measure('[data-dim]').filter(d => d.y1 > 0 && d.y0 < height)

    const col = column.getBoundingClientRect()
    const wrapLeft = col.left - box.left
    const wrapWidth = col.width
    const phoneBox = phone.getBoundingClientRect()
    const walletLeft = phoneBox.left - box.left
    origin = {
      x: phoneBox.left + phoneBox.width / 2 - box.left,
      y: phoneBox.top + phoneBox.width * SHIELD_CARD_Y - box.top
    }
    reach = Math.hypot(width, height) * 0.9

    markIndex = marks.map((node, k) => {
      const mark = MARKS[k]
      let x: number
      let row: number
      if (kind === 'band') {
        x = mark.band.fx * width
        row = copyRow + mark.band.dr
      } else if (kind === 'mid' && mark.mid) {
        x = wrapLeft + mark.mid.fx * (walletLeft - 24 - wrapLeft)
        row = copyRow + mark.mid.dr
      } else {
        x =
          mark.wide.dx !== undefined
            ? wrapLeft + mark.wide.dx
            : wrapLeft + (mark.wide.fx ?? 0) * wrapWidth
        row = mark.wide.row
      }
      const c = Math.min(cols - 2, Math.max(1, Math.round(x / cell - 0.5)))
      const r = Math.min(rows - 2, Math.max(1, row))
      const index = r * cols + c
      const p = pos(index)
      node.style.left = `${canvas.offsetLeft + p.x}px`
      node.style.top = `${canvas.offsetTop + p.y}px`
      const label = node.firstElementChild as HTMLElement | null
      node.toggleAttribute('data-flip', p.x + 26 + (label?.offsetWidth ?? 80) > width - 8)
      // When the scan wave reaches this mark; CSS uses it to stagger the moment each mark gets
      // its shield.
      const delay = (Math.hypot(p.x - origin.x, p.y - origin.y) / reach) * WAVE_MS
      node.style.setProperty('--wave', `${Math.round(delay)}ms`)
      return index
    })
    draw(performance.now())
  }

  function draw(now: number) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const r = Math.max(1.05, cell * 0.13)
    const sweep = waveAt < 0 ? -1 : ((now - waveAt) / WAVE_MS) * reach
    const band = cell * 2.6

    for (let index = 0; index < total; index += 1) {
      if (markIndex.includes(index)) continue
      const p = pos(index)
      const quiet = dimmed(p.x, p.y)
      // The dot itself is opaque #1D1D1D (one step darker behind the copy); alpha is only used for
      // the left-to-right reveal on load.
      const fade = reveal < 1 ? clamp01((reveal * 1.25 - (index % cols) / cols) * 5) : 1
      let color = quiet ? DOT_QUIET : DOT
      let alpha = fade
      let radius = r
      if (hover && !quiet) {
        const dx = (p.x - hover.x) / cell
        const dy = (p.y - hover.y) / cell
        const lift = 0.85 - (dx * dx + dy * dy) * 0.035
        if (lift > 0.12) {
          color = '255,255,255'
          alpha = lift * fade
        }
      }
      if (sweep > 0 && !quiet) {
        const k = 1 - Math.abs(Math.hypot(p.x - origin.x, p.y - origin.y) - sweep) / band
        if (k > 0) {
          color = '61,255,190'
          alpha = Math.min(0.95, 0.12 + k * 0.6) * fade
          radius = r * (1 + k * 0.7)
        }
      }
      if (alpha <= 0.004) continue
      ctx.fillStyle = `rgba(${color},${alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, radius, 0, TAU)
      ctx.fill()
    }
  }

  function step(now: number) {
    raf = 0
    let busy = false
    if (reveal < 1) {
      reveal = clamp01((now - born) / 1100)
      busy = true
    }
    if (waveAt >= 0) {
      if (now - waveAt > WAVE_MS) waveAt = -1
      else busy = true
    }
    draw(now)
    if (busy) raf = requestAnimationFrame(step)
  }

  const kick = () => {
    if (!raf) raf = requestAnimationFrame(step)
  }

  const onMove = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    hover = { x, y }
    const c = Math.min(cols - 1, Math.max(0, Math.floor(x / cell)))
    const r = Math.min(rows - 1, Math.max(0, Math.floor(y / cell)))
    const index = r * cols + c
    const p = pos(index)
    const k = markIndex.indexOf(index)
    if (k < 0 && dimmed(p.x, p.y)) {
      tip.classList.remove('on')
    } else {
      tip.textContent = k > -1 ? MARKS[k].name : `#${(index + 1).toLocaleString('en-US')}`
      tip.style.left = `${canvas.offsetLeft + p.x}px`
      tip.style.top = `${canvas.offsetTop + p.y}px`
      tip.classList.add('on')
    }
    kick()
  }
  const onLeave = () => {
    hover = null
    tip.classList.remove('on')
    kick()
  }

  const schedule = () => {
    cancelAnimationFrame(pending)
    pending = requestAnimationFrame(() => {
      pending = 0
      layout()
    })
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(stage)
  observer.observe(phone)
  document.fonts?.ready.then(schedule)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  layout()
  kick()

  return {
    wave() {
      if (reduced) return
      waveAt = performance.now()
      kick()
    },
    destroy() {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(pending)
      observer.disconnect()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
    }
  }
}

/** Frame alignment for the hero image and, on phones, the callout image (see .hero-phone img). */
function frameVars(): CSSProperties {
  const wide = frameStyle(PHONES.hero)
  const phone = frameStyle(PHONES.send)
  return {
    '--fw': wide.width,
    '--fx': wide.marginLeft,
    '--fy': wide.marginTop,
    '--fw-m': phone.width,
    '--fx-m': phone.marginLeft,
    '--fy-m': phone.marginTop
  } as CSSProperties
}

export function Hero({ onTry }: { onTry: () => void }) {
  const [reduced] = useState(prefersReducedMotion)
  // Chain marks get a shield as the scan wave passes, then fade back to their original color
  // after a while, in the same order.
  const [shielded, setShielded] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const phoneRef = useRef<HTMLDivElement>(null)
  const markRefs = useRef<(HTMLDivElement | null)[]>([])
  const field = useRef<Field | null>(null)
  const visible = useInView(stageRef, 0.25)

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    const tip = tipRef.current
    const column = columnRef.current
    const phone = phoneRef.current
    if (!stage || !canvas || !tip || !column || !phone) return
    const marks = markRefs.current.filter((node): node is HTMLDivElement => node !== null)
    const instance = createField({ stage, canvas, tip, marks, column, phone }, reduced)
    field.current = instance
    return () => {
      instance.destroy()
      field.current = null
    }
  }, [reduced])

  // While the hero is in the viewport: send the first wave once the grid has filled in, then one
  // every 7.5 seconds.
  useEffect(() => {
    if (reduced || !visible) return
    const timers: number[] = []
    const pulse = () => {
      field.current?.wave()
      setShielded(true)
      timers.push(window.setTimeout(() => setShielded(false), SHIELD_HOLD))
    }
    timers.push(window.setTimeout(pulse, 1600))
    const every = window.setInterval(pulse, WAVE_EVERY)
    return () => {
      window.clearInterval(every)
      timers.forEach(id => window.clearTimeout(id))
      setShielded(false)
    }
  }, [reduced, visible])

  const warm = () => void loadDemo()

  return (
    <section className={`hero${shielded ? ' is-shield' : ''}`} aria-labelledby="hero-title">
      <div ref={stageRef} className="hero-stage">
        <div className="hero-copy">
          <div ref={columnRef} className="hero-wrap">
            <div className="inner" data-dim="26">
              <h1 id="hero-title" data-reveal="type">
                <TypeIn text="The Privacy-first Multichain Wallet" />
              </h1>
              <p className="lede" data-reveal="up">
                Noir Wallet is the privacy-first multichain wallet. Send funds and use DeFi without
                exposing your balance, positions, or on-chain identity. Live on Zcash and major
                EVMs.
              </p>
              <div className="cta-row" data-reveal="up">
                <a className="btn" {...walletLinkProps}>
                  <img className="btn-chrome" src={IMG.chrome} width={20} height={20} alt="" />
                  Get Noir Wallet
                </a>
                <AppsComingSoon />
              </div>
            </div>
          </div>
        </div>

        <canvas
          ref={canvasRef}
          className="field"
          role="img"
          aria-label="A field of dots, with the networks Noir Wallet supports marked on it: Ethereum, Zcash, Arbitrum, BNB Chain and Base."
        />
        {MARKS.map((mark, k) => (
          <div
            key={mark.name}
            ref={node => {
              markRefs.current[k] = node
            }}
            className={`chain-mark tone-${mark.tone}`}
            aria-hidden="true"
          >
            <span>{mark.name}</span>
          </div>
        ))}
        <div ref={tipRef} className="tip doto" aria-hidden="true" />
      </div>

      <div className="hero-phone-layer">
        <div className="hero-wrap">
          <div ref={phoneRef} className="hero-phone">
            {/* Phones get the same home screen with the Send / Receive callout, as in the mobile
                design mock; the frame variables line each image up with the phone frame. */}
            <picture>
              <source
                media="(max-width: 759px)"
                srcSet={PHONES.send.src}
                width={PHONES.send.width}
                height={PHONES.send.height}
              />
              <img
                src={PHONES.hero.src}
                width={PHONES.hero.width}
                height={PHONES.hero.height}
                style={frameVars()}
                fetchPriority="high"
                alt="Noir Wallet home: a Shield balance of $4,489.21 across privacy providers, with $1,406.56 available to shield, above the Public and Incognito accounts."
              />
            </picture>
            {/* The wallet image opens the demo: the hint shows on hover and on keyboard focus. */}
            <button
              type="button"
              className="hero-phone-hit"
              onClick={onTry}
              onPointerEnter={warm}
              onFocus={warm}
            >
              <span className="hero-phone-hint">
                <Icon name="pointer" />
                Try the extension
              </span>
            </button>
          </div>
        </div>
      </div>

      <div className="band">
        <span>Backed by</span>
        <img className="band-logo" src={IMG.yzi} width={150} height={36} alt="YZi Labs" />
      </div>
    </section>
  )
}
