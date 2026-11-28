import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { PrizeBoard } from './prizes'
import './prize-boxes.css'

type Stage = 'live' | 'upcoming' | 'ended'

// One prize box in a 60 × 60 box: front, top and side faces, and the lid once it is open
const FRONT = 'M4 22H44V56H4Z'
const TOP = 'M4 22 14 14H54L44 22Z'
const SIDE = 'M44 22 54 14V48L44 56Z'
const LID = 'M14 14 20 0H60L54 14Z'
const VENTS = 'M47 28 51 25M47 33 51 30M47 38 51 35'

// The scrambled bits on a sealed box's front: 2 rows of 7, a different pattern on each box
function bits(seed: number) {
  const cells: { x: number; y: number; o: number }[] = []
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 7; col++) {
      const hash = Math.imul(seed * 7 + row * 13 + col * 5 + 1, 0x9e3779b1) >>> 0
      cells.push({ x: 9 + col * 4.6, y: 42 + row * 5, o: 0.18 + (hash % 70) / 100 })
    }
  }
  return cells
}

/** Boxes opened since the last campaign refresh, kept while their opening plays. */
function useJustOpened(board: PrizeBoard): ReadonlySet<number> {
  const seen = useRef(board.taken)
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set())

  useEffect(() => {
    const before = seen.current
    seen.current = board.taken
    if (board.taken <= before) return
    const next = new Set<number>()
    for (let index = before; index < board.taken; index++) next.add(index)
    setOpened(next)
  }, [board.taken])

  useEffect(() => {
    if (opened.size === 0) return
    const timer = window.setTimeout(() => setOpened(new Set()), 1600)
    return () => window.clearTimeout(timer)
  }, [opened])

  return opened
}

/**
 * The campaign's prizes as encrypted boxes above the panel, one per prize. Opened boxes (won
 * prizes) come first, then the box in the draw, the only one wired to the panel, then the sealed
 * ones. A box won while the page is open lights up and opens on screen.
 */
export function PrizeBoxes({
  board,
  amount,
  stage
}: {
  board: PrizeBoard
  amount: string
  stage: Stage
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const justOpened = useJustOpened(board)
  const small = amount.length > 4

  return (
    <ul
      className="bx-row"
      data-stage={stage}
      style={{ '--bx-cols': board.total } as CSSProperties}
      aria-hidden="true"
    >
      <svg className="bx-defs" width="0" height="0" focusable="false">
        <defs>
          <linearGradient id={`${uid}-front`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#132a20" />
            <stop offset="1" stopColor="#08120e" />
          </linearGradient>
          <linearGradient id={`${uid}-top`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#1c3a2f" />
            <stop offset="1" stopColor="#2a5444" />
          </linearGradient>
          <linearGradient id={`${uid}-front-lit`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1b4434" />
            <stop offset="1" stopColor="#0c1f17" />
          </linearGradient>
          <linearGradient id={`${uid}-top-lit`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#2c6a53" />
            <stop offset="1" stopColor="#4f9c7f" />
          </linearGradient>
        </defs>
      </svg>
      {board.opened.map((open, index) => {
        const now = index === board.current
        const state = open ? 'is-open' : now ? 'is-now' : 'is-sealed'
        return (
          <li key={index} className={`bx ${state}${justOpened.has(index) ? ' is-opening' : ''}`}>
            <svg className="bx-box" viewBox="0 0 60 60" focusable="false">
              <ellipse className="bx-shadow" cx="30" cy="57.6" rx="26" ry="2.4" />
              {open ? (
                <>
                  <path className="bx-side" d={SIDE} />
                  <path className="bx-front" d={FRONT} />
                  <path className="bx-hole" d={TOP} />
                  <path className="bx-lid" d={LID} />
                  <text
                    className={small ? 'bx-amount is-small' : 'bx-amount'}
                    x="24"
                    y={small ? 42 : 43}
                  >
                    {amount}
                  </text>
                </>
              ) : (
                <>
                  <path className="bx-side" d={SIDE} />
                  <path
                    className="bx-top"
                    d={TOP}
                    fill={`url(#${uid}-${now ? 'top-lit' : 'top'})`}
                  />
                  <path
                    className="bx-front"
                    d={FRONT}
                    fill={`url(#${uid}-${now ? 'front-lit' : 'front'})`}
                  />
                  <g className="bx-lock">
                    <rect x="19.5" y="29.5" width="9" height="7" rx="1.6" />
                    <path d="M21.2 29.5V27.6a2.8 2.8 0 0 1 5.6 0v1.9" />
                  </g>
                  {bits(index).map((bit, cell) => (
                    <rect
                      key={cell}
                      className="bx-bit"
                      x={bit.x}
                      y={bit.y}
                      width="2.6"
                      height="2.6"
                      rx="0.4"
                      opacity={bit.o}
                      style={{ '--bx-d': `${(cell * 170) % 1600}ms` } as CSSProperties}
                    />
                  ))}
                  <path className="bx-vent" d={VENTS} />
                </>
              )}
            </svg>
            <span className="bx-label">{open ? 'WON' : now ? 'NOW' : amount}</span>
            {now ? (
              <i className="bx-wire">
                <i />
              </i>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The panel's prize bar, one segment per box: won, in the draw, or still sealed. The box in the
 * draw is wired to its segment.
 */
export function PrizeBar({ board }: { board: PrizeBoard }) {
  const justOpened = useJustOpened(board)
  return (
    <ol
      className="bx-bar"
      style={{ '--bx-cols': board.total } as CSSProperties}
      aria-label={`${board.left} of ${board.total} prizes left`}
    >
      {board.opened.map((open, index) => {
        const now = index === board.current
        return (
          <li
            key={index}
            className={`${open ? 'is-open' : now ? 'is-now' : ''}${justOpened.has(index) ? ' is-opening' : ''}`}
          >
            <span className="bx-sr">
              {`Prize ${index + 1}: ${open ? 'won' : now ? 'in the draw' : 'not won yet'}`}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** "7 / 10 prizes left": the count ticks down on screen when a prize is won. */
export function PrizesLeft({
  board,
  amount,
  asset
}: {
  board: PrizeBoard
  amount: string
  asset: string
}) {
  const previous = useRef(board.left)
  const [ticking, setTicking] = useState(false)

  useEffect(() => {
    if (board.left >= previous.current) {
      previous.current = board.left
      return
    }
    previous.current = board.left
    setTicking(true)
    const timer = window.setTimeout(() => setTicking(false), 1800)
    return () => window.clearTimeout(timer)
  }, [board.left])

  return (
    <span className="bx-count">
      <b className={ticking ? 'is-ticking' : undefined}>{board.left}</b> / {board.total} prizes left
      <span className="bx-each">{` · ${amount} ${asset} each`}</span>
    </span>
  )
}
