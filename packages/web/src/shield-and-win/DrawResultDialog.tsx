/**
 * A revealed draw (see reveals.ts). The result opens in an encrypted prize box, the same box as
 * the prize row above the campaign panel, only larger: it shakes, unlocks and opens. A win lifts
 * the ZEC coin out of it with confetti and offers Claim; no win opens an empty box. With reduced
 * motion the box shows opened at once and there is no confetti. The timeline is in
 * draw-result.css.
 */
import { useEffect, useRef } from 'react'
import type { ShieldWinEntry } from './api'
import { confettiBurst } from './confetti'
import './draw-result.css'

const COIN = '/shield-and-win/zec-coin.png'
// The prize box's faces in a 60 × 60 box (as in PrizeBoxes.tsx)
const FRONT = 'M4 22H44V56H4Z'
const TOP = 'M4 22 14 14H54L44 22Z'
const SIDE = 'M44 22 54 14V48L44 56Z'
const VENTS = 'M47 28 51 25M47 33 51 30M47 38 51 35'
// Light from the opened box, widening upward
const BEAM = 'M4 22-14-24H72L54 14Z'
/** When the lid pops (draw-result.css): the confetti starts with it */
const LID_POP_MS = 1100

// The scrambled bits on the sealed box's front: 2 rows of 7
const BITS = Array.from({ length: 14 }, (_, cell) => ({
  x: 9 + (cell % 7) * 4.6,
  y: 42 + Math.floor(cell / 7) * 5,
  o: 0.2 + ((cell * 37) % 70) / 100
}))

export function DrawResultDialog({
  entry,
  label,
  minimum,
  prizesLeft,
  campaignOpen,
  onClose,
  onClaim
}: {
  /** The revealed entry; null keeps the dialog closed */
  entry: ShieldWinEntry | null
  /** What was shielded, e.g. "ETH $12.40" */
  label: string
  /** The campaign's minimum, e.g. "$10" */
  minimum: string
  prizesLeft: number | null
  campaignOpen: boolean
  onClose: () => void
  onClaim: (entry: ShieldWinEntry) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<SVGSVGElement>(null)
  const won = entry?.draw_result === 'WON'
  const amount = entry
    ? [entry.reward_amount, entry.reward_asset].filter(part => part && part.length > 0).join(' ')
    : ''

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (entry && !dialog.open) dialog.showModal()
    if (!entry && dialog.open) dialog.close()
  }, [entry])

  // Confetti from the box as its lid pops, for a win
  useEffect(() => {
    if (!entry || entry.draw_result !== 'WON') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let stop: () => void = () => undefined
    const timer = window.setTimeout(() => {
      const canvas = canvasRef.current
      const box = boxRef.current
      if (!canvas || !box) return
      const area = canvas.getBoundingClientRect()
      const lid = box.getBoundingClientRect()
      stop = confettiBurst(canvas, {
        x: lid.left + lid.width / 2 - area.left,
        y: lid.top + lid.height * 0.42 - area.top
      })
    }, LID_POP_MS)
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [entry])

  const drawsFor = minimum ? `Every eligible shield of ${minimum} or more` : 'Every eligible shield'
  const left =
    prizesLeft === null || prizesLeft <= 0
      ? '.'
      : `, and ${prizesLeft} ${prizesLeft === 1 ? 'prize is' : 'prizes are'} still up for grabs.`
  const body = won
    ? 'Congratulations! Claim it to a transparent Zcash address in Noir Wallet. We cover the network fee.'
    : campaignOpen
      ? `This shield didn’t win. ${drawsFor} gets its own draw${left}`
      : 'This shield didn’t win. Thanks for taking part.'

  return (
    <dialog
      ref={dialogRef}
      className="dr"
      aria-labelledby="dr-title"
      aria-describedby="dr-body"
      onClose={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {entry ? (
        <div key={entry.id} className={won ? 'dr-in is-win' : 'dr-in is-lose'}>
          {won ? <canvas ref={canvasRef} className="dr-confetti" aria-hidden="true" /> : null}
          <button type="button" className="dr-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          <p className="dr-eye">Draw result · {label}</p>
          <div className="dr-stage" aria-hidden="true">
            <span className="dr-glow" />
            {won ? <span className="dr-rays" /> : null}
            {won ? <img className="dr-coin" src={COIN} width={104} height={104} alt="" /> : null}
            <svg ref={boxRef} className="dr-box" viewBox="-6 -24 72 84" focusable="false">
              <defs>
                <linearGradient id="dr-front" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#1b4434" />
                  <stop offset="1" stopColor="#0c1f17" />
                </linearGradient>
                <linearGradient id="dr-top" x1="0" y1="1" x2="1" y2="0">
                  <stop offset="0" stopColor="#2c6a53" />
                  <stop offset="1" stopColor="#4f9c7f" />
                </linearGradient>
                <linearGradient id="dr-beam" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0" stopColor="#fff3b0" stopOpacity="0.9" />
                  <stop offset="0.45" stopColor="#ffcc00" stopOpacity="0.35" />
                  <stop offset="1" stopColor="#ffcc00" stopOpacity="0" />
                </linearGradient>
              </defs>
              <ellipse className="dr-shadow" cx="30" cy="57.6" rx="26" ry="2.4" />
              {won ? <path className="dr-beam" d={BEAM} /> : null}
              <path className="dr-side" d={SIDE} />
              <path className="dr-front" d={FRONT} />
              <path className="dr-hole" d={TOP} />
              <g className="dr-lid">
                <path d={TOP} />
              </g>
              <g className="dr-lock">
                <rect x="19.5" y="29.5" width="9" height="7" rx="1.6" />
                <g className="dr-shackle-shut">
                  <path d="M21.2 29.5V27.6a2.8 2.8 0 0 1 5.6 0v1.9" />
                </g>
                <g className="dr-shackle-open">
                  <path d="M21.2 29.5V26.8a2.8 2.8 0 0 1 5.6 0" />
                </g>
              </g>
              <g className="dr-bits">
                {BITS.map(bit => (
                  <rect
                    key={`${bit.x}-${bit.y}`}
                    x={bit.x}
                    y={bit.y}
                    width="2.6"
                    height="2.6"
                    rx="0.4"
                    opacity={bit.o}
                  />
                ))}
              </g>
              <path className="dr-vent" d={VENTS} />
              {won ? null : (
                <g className="dr-dust">
                  <circle cx="26" cy="12" r="0.9" />
                  <circle cx="33" cy="8" r="0.7" />
                  <circle cx="21" cy="6" r="0.6" />
                </g>
              )}
            </svg>
          </div>
          <div className="dr-copy">
            <h2 id="dr-title" className="dr-title">
              {won ? (
                <>
                  You won <em>{amount}</em>
                </>
              ) : (
                'Not this time'
              )}
            </h2>
            <p id="dr-body" className="dr-body">
              {body}
            </p>
            <div className="dr-actions">
              {won ? (
                <>
                  <button
                    type="button"
                    className="dr-btn is-primary"
                    onClick={() => onClaim(entry)}
                  >
                    Claim {amount}
                  </button>
                  <button type="button" className="dr-btn" onClick={onClose}>
                    Later
                  </button>
                </>
              ) : (
                <button type="button" className="dr-btn" onClick={onClose}>
                  Got it
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}
