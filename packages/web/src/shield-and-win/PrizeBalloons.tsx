import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { BALLOON_COLUMNS, type PrizeBoard } from './prizes'
import './prize-balloons.css'

// Small tilts so the balloons don't stand in rigid rows
const TILTS = [-6, 3, -2, 5, -4, 2, -5, 4, -3, 6]

// Where each rubber scrap starts before it flies out (toward the balloon's center)
const SHARDS = [
  { d: 'M9 16q3-4 7-1', x: 8, y: 8 },
  { d: 'M45 13q4 1 5 5', x: -7, y: 9 },
  { d: 'M50 45q-1 4-5 6', x: -8, y: -6 },
  { d: 'M10 47q1 4 6 5', x: 8, y: -7 }
]

// A jagged "pop" mark where the balloon was
const BURST = (() => {
  const outer = [22, 17, 21, 16, 23, 18, 20, 16, 22, 17, 21, 18]
  const points: string[] = []
  for (let k = 0; k < 24; k++) {
    const angle = ((k * 15 - 90) * Math.PI) / 180
    const radius = k % 2 === 0 ? outer[k / 2] : 10.5
    const x = Math.round((30 + radius * Math.cos(angle)) * 10) / 10
    const y = Math.round((33 + radius * Math.sin(angle)) * 10) / 10
    points.push(`${x},${y}`)
  }
  return `M${points.join('L')}Z`
})()

type Stage = 'live' | 'upcoming' | 'ended'

/**
 * The campaign's prizes as a wall of balloons, one per prize. A won prize is a popped balloon;
 * one that pops while the page is open bursts on screen.
 */
export function PrizeBalloons({
  board,
  amount,
  asset,
  stage
}: {
  board: PrizeBoard
  amount: string
  asset: string
  stage: Stage
}) {
  const fill = `pb-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const pattern = board.popped.map(popped => (popped ? '1' : '0')).join('')
  const seen = useRef(pattern)
  const [bursting, setBursting] = useState<ReadonlySet<number>>(() => new Set())

  // Balloons that popped since the last campaign refresh burst on screen
  useEffect(() => {
    const before = seen.current
    seen.current = pattern
    if (before === pattern || before.length !== pattern.length) return
    const fresh = new Set<number>()
    for (let index = 0; index < pattern.length; index++) {
      if (pattern[index] === '1' && before[index] === '0') fresh.add(index)
    }
    if (fresh.size > 0) setBursting(fresh)
  }, [pattern])

  useEffect(() => {
    if (bursting.size === 0) return
    const timer = window.setTimeout(() => setBursting(new Set()), 1200)
    return () => window.clearTimeout(timer)
  }, [bursting])

  const small = amount.length > 4
  return (
    <div className="pb" data-stage={stage}>
      <svg className="pb-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id={fill} cx="0.36" cy="0.3" r="0.78">
            <stop offset="0" stopColor="#d4fff0" />
            <stop offset="0.42" stopColor="#3dffbe" />
            <stop offset="1" stopColor="#00a070" />
          </radialGradient>
        </defs>
      </svg>
      <p className="pb-head">
        <span>
          {board.total} {board.total === 1 ? 'prize' : 'prizes'} · {amount} {asset}
          {board.total === 1 ? '' : ' each'}
        </span>
        <span>
          <b>{board.left}</b> left
        </span>
      </p>
      <ul
        className="pb-grid"
        style={{ '--pb-cols': Math.min(BALLOON_COLUMNS, board.total) } as CSSProperties}
      >
        {board.popped.map((popped, index) => (
          <li
            key={index}
            className={`pb-slot${popped ? ' is-popped' : ''}${bursting.has(index) ? ' is-bursting' : ''}`}
            style={
              {
                '--pb-tilt': `${TILTS[index % TILTS.length]}deg`,
                '--pb-delay': `${(index * 730) % 2900}ms`
              } as CSSProperties
            }
          >
            <svg viewBox="0 0 60 100" aria-hidden="true" focusable="false">
              <path className="pb-string" d="M30 71C26 79 34 86 30 98" />
              <g className="pb-balloon">
                <path
                  d="M30 4C46 4 56 17 56 33C56 50 43 63 32 67H28C17 63 4 50 4 33C4 17 14 4 30 4Z"
                  fill={`url(#${fill})`}
                />
                <path d="M27 67H33L31.6 71.5H28.4Z" className="pb-knot" />
                <ellipse
                  cx="18.5"
                  cy="19"
                  rx="4.5"
                  ry="8.5"
                  transform="rotate(28 18.5 19)"
                  className="pb-shine"
                />
                <text
                  x="30"
                  y={small ? 37 : 38}
                  className={small ? 'pb-amount is-small' : 'pb-amount'}
                >
                  {amount}
                </text>
                <text x="30" y="49" className="pb-asset">
                  {asset}
                </text>
              </g>
              <g className="pb-burst">
                <path className="pb-mark" d={BURST} />
                {SHARDS.map(shard => (
                  <path
                    key={shard.d}
                    className="pb-shard"
                    d={shard.d}
                    style={{ '--pb-x': `${shard.x}px`, '--pb-y': `${shard.y}px` } as CSSProperties}
                  />
                ))}
                <path d="M27.5 67H32.5L31.4 71H28.6Z" className="pb-knot is-left" />
                <text x="30" y="37" className="pb-won">
                  Won
                </text>
              </g>
            </svg>
            <span className="pb-sr">
              {`Prize ${index + 1}: ${popped ? 'won' : `${amount} ${asset}, not won yet`}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
