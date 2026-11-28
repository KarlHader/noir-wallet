/**
 * Ledger Supported (design mock): the supported hardware wallets next to the title, then three
 * steps, each with a mint icon. The icons are drawn after the mock's: a USB stick, a "Shield"
 * card with an arrow going in, and a screen with transfer arrows. Where an arrow crosses a shape
 * it keeps a gap in the card's background color, as in the mock.
 */
import type { ReactNode } from 'react'
import { HARDWARE_STEPS, IMG } from './content'

const MINT = '#00d18a'
const CARD = '#16161d'

const ICONS: Record<(typeof HARDWARE_STEPS)[number]['icon'], ReactNode> = {
  usb: (
    <g fill={CARD} stroke={MINT} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
      <circle cx="37" cy="31" r="7" />
      <path d="M21 11.5 27 5.5l10 10-6 6" />
      <path d="M5 27.5 21 11.5l10 10-16 16a3 3 0 0 1-4.2 0l-5.8-5.8a3 3 0 0 1 0-4.2Z" />
      <path d="M26.5 10.5l1.5 1.5M30.5 14.5l1.5 1.5" />
    </g>
  ),
  shield: (
    <>
      <rect x="1" y="8" width="46" height="32" rx="6" fill="#000" stroke={MINT} strokeWidth="2" />
      <text x="7.5" y="32" fill={MINT} fontSize="12" fontWeight="700">
        Shield
      </text>
      <path
        d="M24 1.5v12M18.5 8.5 24 14l5.5-5.5"
        fill="none"
        stroke={CARD}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M24 1.5v12M18.5 8.5 24 14l5.5-5.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  transfer: (
    <>
      <rect
        x="2"
        y="5"
        width="36"
        height="24"
        rx="2.5"
        fill={CARD}
        stroke={MINT}
        strokeWidth="2.4"
      />
      <path d="M20 29v6M11 36h18" stroke={MINT} strokeWidth="2.6" strokeLinecap="round" />
      <path
        d="M31 15h14M41.5 11.5 45 15l-3.5 3.5M46 24H32M35.5 20.5 32 24l3.5 3.5"
        fill="none"
        stroke={CARD}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M31 15h14M41.5 11.5 45 15l-3.5 3.5M46 24H32M35.5 20.5 32 24l3.5 3.5"
        fill="none"
        stroke={MINT}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  )
}

export function Hardware() {
  return (
    <section className="sec-n hardware" aria-labelledby="hardware-title">
      <div className="wrap-n">
        <div className="hw-head">
          <div>
            <p className="eyebrow" data-reveal="up">
              Hardware Wallets
            </p>
            <h2 className="h2" id="hardware-title" data-reveal="up">
              Ledger Supported
            </h2>
          </div>
          <ul className="hw-brands" aria-label="Supported hardware wallets">
            <li data-reveal="up">
              <img src={IMG.ledger} width={36} height={30} alt="" loading="lazy" />
              Ledger
            </li>
            <li data-reveal="up">
              <img src={IMG.keystone} width={42} height={42} alt="" loading="lazy" />
              Keystone
            </li>
          </ul>
        </div>
        <ol className="hw-steps">
          {HARDWARE_STEPS.map(step => (
            <li key={step.title} className="spot" data-reveal="up">
              <svg className="hw-icon" viewBox="0 0 48 42" aria-hidden="true">
                {ICONS[step.icon]}
              </svg>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
