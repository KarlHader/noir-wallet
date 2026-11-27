/**
 * The home page (second version of the design mock): hero dot grid, three feature sections,
 * flow diagram, privacy tools and the closing statue.
 */
import './site.css'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { docsLinkProps, walletLinkProps } from './walletStore'
import { IMG, TOOLS } from './content'
import { DeskNote } from './DeskNote'
import { DefiAccess, PrivateTransfers, ShieldUnshield } from './Features'
import { Hero } from './Hero'
import { Icon } from './Icon'
import { loadDemo } from './demoLoader'
import { Statue } from './Statue'
import { TryExtension } from './TryExtension'
import { Workflow } from './Workflow'

const ExtensionDemo = lazy(loadDemo)

/** Entry to the Shield & Win campaign page, above the header. Remove it when the campaign ends. */
function CampaignBar({ inert }: { inert: boolean }) {
  return (
    <a className="promo" href="/shield-and-win" inert={inert}>
      <span className="promo-live" aria-hidden="true" />
      <span className="promo-name">Shield &amp; Win</span>
      <span className="promo-text">
        Go shield, win ZEC
        <span className="promo-more">. Try a shield transfer for an instant draw.</span>
      </span>
      <span className="promo-go">
        <span className="promo-go-label">Join now</span>
        <Icon name="arrow" />
      </span>
    </a>
  )
}

function SiteHeader({ inert }: { inert: boolean }) {
  return (
    <header className="site-head" inert={inert}>
      <div className="wrap">
        <a className="brand" href="#top" aria-label="Noir Wallet, back to top">
          <img src={IMG.logo} alt="" />
          <span>Noir Wallet</span>
        </a>
        <nav className="site-nav" aria-label="Site">
          <a href="#features">Features</a>
          <a href="#workflow">Workflow</a>
          <a href="#downloads">Downloads</a>
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

/**
 * Supported privacy providers: the title takes the first cell, the two integrated ones sit to
 * its right, and the upcoming ones are grayed out and tagged Soon.
 */
function ShieldTools() {
  return (
    <section className="tools-sec" aria-labelledby="tools-title">
      <div className="tools">
        <h2 className="tools-title" id="tools-title">
          Supported
          <br />
          Shield Tools
        </h2>
        {/* The list itself takes no grid cell; its cards go straight into the outer grid */}
        <ul className="tools-list">
          {TOOLS.map(tool => (
            <li key={tool.name} className={`tool${tool.soon ? ' is-soon' : ''}`}>
              <img src={tool.icon} width={60} height={60} alt="" loading="lazy" />
              <b>{tool.name}</b>
              {tool.soon && <em>Soon</em>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Journey({ onTry }: { onTry: () => void }) {
  return (
    <section className="end" id="downloads" aria-labelledby="end-title">
      <div className="wrap">
        <h2 id="end-title">
          Start Your
          <br />
          Private On-Chain Journey.
        </h2>
        <div className="cta-row">
          <a className="btn" {...walletLinkProps}>
            <Icon name="download" />
            Install Wallet
          </a>
          <TryExtension variant="ghost" onOpen={onTry} />
          <a className="btn btn-ghost" {...docsLinkProps}>
            Docs
            <Icon name="external" />
          </a>
        </div>
        <DeskNote />
      </div>
    </section>
  )
}

function SiteFooter({ inert }: { inert: boolean }) {
  return (
    <footer className="site-foot" inert={inert}>
      <Statue />
      <p className="foot-copy">© 2026 Noir Privacy Terminal. All rights reserved.</p>
      <p className="wordmark" aria-hidden="true">
        Noir Wallet
      </p>
    </footer>
  )
}

export function Site() {
  // "Try the extension" demo: its chunk loads only once clicked. After it closes, focus returns
  // to the button that opened it.
  const [demo, setDemo] = useState(false)
  const trigger = useRef<HTMLElement | null>(null)
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
      <CampaignBar inert={demo} />
      <SiteHeader inert={demo} />
      <main id="top" inert={demo}>
        <Hero onTry={openDemo} />
        <PrivateTransfers />
        <ShieldUnshield />
        <DefiAccess />
        <Workflow />
        <ShieldTools />
        <Journey onTry={openDemo} />
      </main>
      <SiteFooter inert={demo} />
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
