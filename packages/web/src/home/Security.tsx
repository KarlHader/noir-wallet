/**
 * Your Key Open Code (design mock): four cards in a 2 × 2 grid. Each has a large icon on its
 * right that fades from white to transparent and is blurred into the background; the shapes
 * follow Lucide's shield-user, layers, badge-check and code-xml (ISC license).
 */
import { type ReactNode, useId } from 'react'
import { TRUST_POINTS } from './content'
import { TypeIn } from './TypeIn'

const SHAPES: Record<(typeof TRUST_POINTS)[number]['icon'], (paint: string) => ReactNode> = {
  custody: paint => (
    <g fill="none" stroke={paint} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <circle cx="12" cy="10.5" r="3" />
      <path d="M7.5 18.2a5 5 0 0 1 9 0" />
    </g>
  ),
  backup: paint => (
    <g fill="none" stroke={paint} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </g>
  ),
  audit: paint => (
    <>
      <path
        d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
        fill={paint}
      />
      <path
        d="m9 12 2 2 4-4"
        fill="none"
        stroke="#16161d"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  code: paint => (
    <g fill="none" stroke={paint} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </g>
  )
}

function TrustIcon({ name }: { name: (typeof TRUST_POINTS)[number]['icon'] }) {
  const id = useId()
  return (
    <svg className={`trust-icon is-${name}`} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {SHAPES[name](`url(#${id})`)}
    </svg>
  )
}

export function Security() {
  return (
    <section className="sec-n trust" aria-labelledby="trust-title">
      <div className="wrap-n">
        <p className="eyebrow" data-reveal="up">
          Security and Trust
        </p>
        <h2 className="h2" id="trust-title" data-reveal="type">
          <TypeIn text="Your Key Open Code" />
        </h2>
        <ul className="trust-grid">
          {TRUST_POINTS.map(point => (
            <li key={point.title} className="spot" data-reveal="up">
              <TrustIcon name={point.icon} />
              <h3>{point.title}</h3>
              <p>{point.body}</p>
              {point.link && (
                <a href={point.link.href} target="_blank" rel="noopener noreferrer">
                  {point.link.label} →
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
