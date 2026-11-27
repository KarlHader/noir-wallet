/**
 * The home page (the November 27 design mock): hero dot grid with the "Backed by" band, Key
 * Features, the flow diagram with the privacy providers, the three account types, hardware
 * wallets, security, and the closing statue. The Shield & Win campaign entry (Campaign.tsx)
 * loads separately on top.
 */
import './site.css'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { docsLinkProps, walletLinkProps } from './walletStore'
import { IMG, SOCIAL } from './content'
import { Accounts } from './Accounts'
import { AppsComingSoon } from './ComingSoon'
import { DeskNote } from './DeskNote'
import { Hardware } from './Hardware'
import { Hero } from './Hero'
import { Icon, SocialIcon } from './Icon'
import { KeyFeatures } from './KeyFeatures'
import { loadDemo } from './demoLoader'
import { useReveals, useSpotlight } from './motion'
import { Security } from './Security'
import { Statue } from './Statue'
import { Workflow } from './Workflow'

const ExtensionDemo = lazy(loadDemo)
// The Shield & Win entry loads on its own, after the page; it shows nothing once the campaign is
// over.
const Campaign = lazy(() => import('./Campaign'))

/**
 * The site header. Other pages (FeedbackRewards.tsx) pass base="/", so the brand and the section
 * links lead back to the home page.
 */
export function SiteHeader({ inert = false, base = '' }: { inert?: boolean; base?: '' | '/' }) {
  return (
    <header className="site-head" inert={inert}>
      <div className="wrap-head">
        <a
          className="brand"
          href={base || '#top'}
          aria-label={base ? 'Noir Wallet home page' : 'Noir Wallet, back to top'}
        >
          <img src={IMG.logo} alt="" />
          <span>Noir Wallet</span>
        </a>
        <nav className="site-nav" aria-label="Site">
          <a href={`${base}#features`}>Features</a>
          <a href={`${base}#workflow`}>Workflow</a>
          <a href={`${base}#downloads`}>Downloads</a>
          <a {...docsLinkProps}>Docs</a>
        </nav>
        <a className="btn btn-sm" {...walletLinkProps}>
          <Icon name="download" />
          Install Wallet
        </a>
      </div>
    </header>
  )
}

function Journey() {
  return (
    <section className="end" id="downloads" aria-labelledby="end-title">
      <div className="wrap">
        <h2 id="end-title" data-reveal="up">
          Start Your
          <br />
          Private On-Chain Journey.
        </h2>
        <div className="cta-row" data-reveal="up">
          <a className="btn" {...walletLinkProps}>
            <Icon name="download" />
            Install Wallet
          </a>
          <AppsComingSoon />
        </div>
        <DeskNote />
      </div>
    </section>
  )
}

/** The site footer. Other pages leave out the statue (statue={false}). */
export function SiteFooter({
  inert = false,
  statue = true
}: {
  inert?: boolean
  statue?: boolean
}) {
  return (
    <footer className={statue ? 'site-foot' : 'site-foot is-plain'} inert={inert}>
      {statue && <Statue />}
      <ul className="social" data-reveal="up">
        {SOCIAL.map(link => (
          <li key={link.name}>
            <a href={link.href} target="_blank" rel="noopener noreferrer" aria-label={link.label}>
              <SocialIcon name={link.name} />
            </a>
          </li>
        ))}
      </ul>
      <p className="foot-copy" data-reveal="up">
        © 2026 Noir Privacy Terminal. All rights reserved.
      </p>
      <p className="wordmark" aria-hidden="true" data-reveal="up">
        Noir Wallet
      </p>
    </footer>
  )
}

export function Site() {
  // "Try the extension" demo (opened from the hero wallet): its chunk loads only once clicked.
  // After it closes, focus returns to whatever opened it.
  const [demo, setDemo] = useState(false)
  const trigger = useRef<HTMLElement | null>(null)
  useReveals()
  useSpotlight()
  const openDemo = () => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDemo(true)
  }

  useEffect(() => {
    if (!demo) trigger.current?.focus({ preventScroll: true })
  }, [demo])

  // While the demo is open, the whole page behind it is inert: Tab cannot escape the overlay and
  // screen readers only read the overlay.
  return (
    <>
      <SiteHeader inert={demo} />
      <main id="top" inert={demo}>
        <Hero onTry={openDemo} />
        <KeyFeatures />
        <Workflow />
        <Accounts />
        <Hardware />
        <Security />
        <Journey />
      </main>
      <SiteFooter inert={demo} />
      <Suspense fallback={null}>
        <Campaign inert={demo} />
      </Suspense>
      {demo && (
        <Suspense
          fallback={
            <div className="xo-loading" role="status">
              Loading the wallet demo…
            </div>
          }
        >
          <ExtensionDemo onClose={() => setDemo(false)} />
        </Suspense>
      )}
    </>
  )
}
