import type { MetaFunction } from 'react-router'
import { Link } from 'react-router'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import {
  ArrowRight,
  BookOpen,
  Chrome,
  Code2,
  Github,
  LockKeyhole,
  Package,
  ShieldCheck,
  Sparkles,
  WalletCards
} from 'lucide-react'
import { baseOptions } from '@/lib/layout.shared'

export const meta: MetaFunction = () => [
  { title: 'Noir Wallet Docs' },
  {
    name: 'description',
    content:
      'Use Noir Wallet with Zcash and supported EVM networks, or connect your dApp with the SDK.'
  },
  { property: 'og:title', content: 'Noir Wallet Documentation' },
  {
    property: 'og:description',
    content: 'Wallet guides and developer documentation for Noir Wallet.'
  },
  { property: 'og:image', content: 'https://docs.zknoir.com/og.png' }
]

const destinations = [
  {
    title: 'Install Noir Wallet',
    description: 'Install the Chrome extension and create or restore a wallet.',
    href: '/get-started',
    icon: Chrome,
    accent: 'cyan',
    label: 'Start here'
  },
  {
    title: 'Use the Wallet',
    description: 'Use Public, Shield, and Incognito balances to receive, send, and swap assets.',
    href: '/wallet-guide',
    icon: WalletCards,
    accent: 'violet',
    label: 'Wallet guide'
  },
  {
    title: 'Build with Noir',
    description: 'Connect accounts and request Zcash or EVM transactions with the SDK.',
    href: '/noir-sdk-integration',
    icon: Code2,
    accent: 'green',
    label: 'Developer docs'
  }
]

export default function HomePage() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="portal">
        <section className="hero-shell">
          <div className="hero-grid" aria-hidden="true" />
          <div className="hero-glow hero-glow-primary" aria-hidden="true" />
          <div className="hero-glow hero-glow-secondary" aria-hidden="true" />

          <div className="hero-copy">
            <div className="eyebrow">
              <Sparkles aria-hidden="true" />
              Documentation
            </div>
            <h1>
              Noir <span>Wallet</span>
            </h1>
            <p>Manage Zcash and supported EVM assets in a self-custodial browser wallet.</p>
            <div className="hero-actions">
              <Link className="button button-primary" to="/get-started">
                Get started
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link className="button button-secondary" to="/noir-sdk-integration">
                Read developer docs
              </Link>
            </div>
          </div>

          <div className="hero-console" aria-label="SDK quick start preview">
            <div className="console-bar">
              <span className="console-dot" />
              <span className="console-dot" />
              <span className="console-dot" />
              <span>quick-start.ts</span>
            </div>
            <pre>
              <code>
                <span className="code-muted">{'import '}</span>
                <span className="code-accent">{'{ getNoirWallet }'}</span>
                <span className="code-muted">{' from '}</span>
                <span className="code-string">{'"@noir-wallet/sdk";'}</span>
                {'\n\n'}
                <span className="code-muted">{'const '}</span>
                <span className="code-value">wallet</span>
                <span className="code-muted">{' = getNoirWallet();\n'}</span>
                <span className="code-muted">{'const '}</span>
                <span className="code-value">connection</span>
                <span className="code-muted">{' = await wallet.zcash.connect();\n\n'}</span>
                <span className="code-comment">{'// Privacy is now a product primitive.'}</span>
              </code>
            </pre>
            <div className="console-status">
              <ShieldCheck aria-hidden="true" />
              Connected securely
            </div>
          </div>
        </section>

        <section className="destination-section" aria-labelledby="explore-title">
          <div className="section-heading">
            <div>
              <h2 id="explore-title">Guides</h2>
            </div>
          </div>

          <div className="destination-grid">
            {destinations.map(destination => {
              const Icon = destination.icon
              return (
                <Link
                  className={`destination-card accent-${destination.accent}`}
                  to={destination.href}
                  key={destination.href}
                >
                  <span className="card-label">{destination.label}</span>
                  <span className="card-icon">
                    <Icon aria-hidden="true" />
                  </span>
                  <h3>{destination.title}</h3>
                  <p>{destination.description}</p>
                  <span className="card-link">
                    Open guide <ArrowRight aria-hidden="true" />
                  </span>
                </Link>
              )
            })}
          </div>
        </section>

        <section className="quick-links" aria-label="Quick links">
          <a
            href="https://chromewebstore.google.com/detail/noir-wallet/mfoghjbpfanobmnoemoepenjjcmfpmdn"
            target="_blank"
            rel="noreferrer"
          >
            <Chrome aria-hidden="true" />
            <span>
              <strong>Chrome Web Store</strong>
              Install the extension
            </span>
            <ArrowRight aria-hidden="true" />
          </a>
          <a href="https://www.npmjs.com/package/@noir-wallet/sdk" target="_blank" rel="noreferrer">
            <Package aria-hidden="true" />
            <span>
              <strong>@noir-wallet/sdk</strong>
              Add wallet support
            </span>
            <ArrowRight aria-hidden="true" />
          </a>
          <a href="https://zknoir.com/github" target="_blank" rel="noreferrer">
            <Github aria-hidden="true" />
            <span>
              <strong>GitHub</strong>
              View the source
            </span>
            <ArrowRight aria-hidden="true" />
          </a>
        </section>

        <section className="trust-strip">
          <div>
            <LockKeyhole aria-hidden="true" />
            <span>
              <strong>Self-custodial</strong>
              Your keys stay encrypted on your device.
            </span>
          </div>
          <div>
            <BookOpen aria-hidden="true" />
            <span>
              <strong>Source-aligned</strong>
              SDK examples compile against the current package.
            </span>
          </div>
        </section>
      </main>
    </HomeLayout>
  )
}
